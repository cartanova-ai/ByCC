import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import SendIcon from "~icons/lucide/arrow-up";
import ImageIcon from "~icons/lucide/image";
import RotateIcon from "~icons/lucide/rotate-ccw";
import SlidersIcon from "~icons/lucide/sliders-horizontal";
import SquareIcon from "~icons/lucide/square";
import XIcon from "~icons/lucide/x";

import chatIcon from "@/assets/chat-icon.png";
import { type QgridThreadCoord } from "@/services/qgrid/qgrid.types";
import { QgridService, TokenService } from "@/services/services.generated";

import {
  chatConfigChanged,
  chatTokenOptions,
  providerTokenMissing,
  resolvedTokenName,
  tokenTargetPayload,
  type ChatTokenOption,
  type ChatConfig,
} from "./chat-token-selection";

const CHAT_PROJECT_NAME = "qgrid_chat";
const DEFAULT_MODEL = "anthropic/claude-fable-5-1";

// dispatcher 는 provider prefix 없는 모델을 라우팅하지 못하므로 항상 접두사를 포함한다.
// ai-sdk 의 QgridSupportedModel union 중 실제로 서비스되는 모델만 provider 별로 최신순 나열한다.
// web 은 ai-sdk 에 의존하지 않아 런타임 공유가 없으므로, 모델을 추가할 때 두 곳을 함께 갱신한다.
// union 에는 남아 있지만 여기서 제외한 항목:
//  - `gpt-5.4`, `gpt-5.4-mini`: qgrid 가 쓰는 ChatGPT 구독 Codex 경로에서 2026-08-31 retired
//    (대체 gpt-5.6-terra / gpt-5.6-luna).
//  - `gpt-5.2`, `gpt-5.3-codex`: 같은 경로에서 이미 제공 종료.
//  - `claude-sonnet-4-7`: 공식 카탈로그에 없는 유령 항목.
const MODEL_PRESET_GROUPS: { label: string; models: string[] }[] = [
  {
    label: "OpenAI",
    models: [
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.5",
      "openai/gpt-5.3-codex-spark",
    ],
  },
  {
    label: "Anthropic",
    models: [
      "anthropic/claude-fable-5-1",
      "anthropic/claude-fable-5",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-1",
      "anthropic/claude-opus-4",
      "anthropic/claude-sonnet-4",
    ],
  },
];
const EFFORT_PRESETS = ["low", "medium", "high"];

interface DoneMeta {
  model?: string;
  tokenName?: string | null;
  durationMs: number;
  costUsd: number;
  requestLogId?: number;
  fallback: boolean;
}

type ChatMessage =
  | { role: "user"; text: string; images?: string[] }
  | {
      role: "assistant";
      text: string;
      status: "streaming" | "done" | "aborted" | "error";
      meta?: DoneMeta;
      error?: string;
    };

// codex ResponseItem 포맷 (ai-sdk extractPromptAndHistory 와 동일). Anthropic 경로는
// threadCoord 재사용이 없어 이 history 가 유일한 문맥이고, OpenAI 경로는 cold 폴백에 쓴다.
// 과거 turn 의 이미지는 history 에 싣지 않는다 — warm thread 에는 이미 남아 있고,
// cold 폴백에서만 텍스트로 축약되는 것을 감수한다(테스트 도구 범위).
function buildHistory(messages: ChatMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: m.text }],
      });
    } else if (m.text) {
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: m.text }],
      });
    }
  }
  return items;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const PROVIDER_LABELS: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic" };

// dispatcher 원문 에러(NO_OPENAI_WORKERS 등)와, 토큰 0개라 부팅이 끝나지 않는 환경의
// "기동 중" 메시지를 실제 원인인 토큰 부재 안내로 바꿔준다.
function humanizeError(
  message: string,
  provider: string | undefined,
  tokens: ChatTokenOption[] | undefined,
): string {
  const missing = tokens !== undefined && providerTokenMissing(tokens, provider);
  const noTokenError =
    /NO_OPENAI_WORKERS|no ready openai workers|no anthropic tokens available/i.test(message);
  if (noTokenError || (missing && /기동 중입니다/.test(message))) {
    const label = provider ? (PROVIDER_LABELS[provider] ?? provider) : "";
    return `사용 가능한 ${label} 토큰이 없습니다. Tokens 페이지에서 토큰을 추가해주세요.`;
  }
  return message;
}

function formatCost(costUsd: number): string {
  return costUsd >= 0.01 ? `$${costUsd.toFixed(2)}` : `$${costUsd.toFixed(4)}`;
}

const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_DIMENSION = 1536;

// 원본 그대로 보내면 data-URL 팽창으로 body 한도(10MB)와 provider 입력 한도를 위협하므로
// 긴 변 1536px JPEG 로 줄여서 보낸다.
async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [panelClosing, setPanelClosing] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [tokenName, setTokenName] = useState("");
  const [effort, setEffort] = useState("");
  const [system, setSystem] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);

  const threadCoordRef = useRef<QgridThreadCoord | undefined>(undefined);
  const lastConfigRef = useRef<ChatConfig | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const provider = model.split("/")[0];
  // 이미지 입력은 OpenAI(codex) 경로만 UserInput 으로 전달된다.
  const supportsImages = provider === "openai";

  const { data: tokensData } = TokenService.useTokens(
    "A",
    { orderBy: "ord-asc" },
    { enabled: open },
  );
  const tokenOptions = useMemo(
    () => chatTokenOptions(tokensData?.rows ?? [], provider),
    [provider, tokensData?.rows],
  );
  const tokenListLoaded = tokensData?.rows !== undefined;
  // SSE handler 는 연결 시점 클로저에 갇히므로 최신 토큰 목록은 ref 로 읽는다.
  const tokensRef = useRef<ChatTokenOption[] | undefined>(undefined);
  useEffect(() => {
    tokensRef.current = tokensData?.rows;
  }, [tokensData?.rows]);
  const selectedProviderMissing =
    tokensData?.rows !== undefined && providerTokenMissing(tokensData.rows, provider);

  useEffect(() => {
    if (!supportsImages) setAttachments([]);
  }, [supportsImages]);

  useEffect(() => {
    setTokenName((current) => resolvedTokenName(current, tokenOptions, tokenListLoaded));
  }, [tokenListLoaded, tokenOptions]);

  const addAttachments = async (files: FileList | null) => {
    if (!files) return;
    const slots = MAX_ATTACHMENTS - attachments.length;
    const converted = await Promise.all(
      [...files].slice(0, slots).map((f) => fileToDataUrl(f).catch(() => null)),
    );
    setAttachments((prev) =>
      [...prev, ...converted.filter((url): url is string => url !== null)].slice(
        0,
        MAX_ATTACHMENTS,
      ),
    );
  };

  const patchLastAssistant = (patch: (m: ChatMessage & { role: "assistant" }) => ChatMessage) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant") return prev;
      return [...prev.slice(0, -1), patch(last)];
    });
  };

  const failStreaming = (message: string) => {
    const friendly = humanizeError(
      message,
      lastConfigRef.current?.model.split("/")[0],
      tokensRef.current,
    );
    patchLastAssistant((m) =>
      m.status === "streaming" ? { ...m, status: "error", error: friendly } : m,
    );
    setStreamId(null);
    setBusy(false);
  };

  // SSE handler 는 연결 시점에 캡처되므로 state 를 읽지 않고 functional update 만 쓴다.
  const streamState = QgridService.useQueryStream(
    { streamId: streamId ?? "" },
    {
      delta: ({ text }) => {
        patchLastAssistant((m) => (m.status === "streaming" ? { ...m, text: m.text + text } : m));
      },
      toolCall: () => {
        failStreaming("tool call 응답은 채팅에서 지원하지 않습니다");
      },
      done: (data) => {
        threadCoordRef.current = data.runContext?.threadCoord;
        patchLastAssistant((m) => ({
          ...m,
          text: data.text || m.text,
          status: "done",
          meta: {
            model: data.model,
            tokenName: data.tokenName,
            durationMs: data.durationMs,
            costUsd: data.costUsd,
            requestLogId: data.runContext?.requestLogId,
            fallback: (data.modelFallbacks?.length ?? 0) > 0,
          },
        }));
      },
      error: ({ message }) => {
        failStreaming(message);
      },
      end: () => {
        // done/error 없이 스트림이 닫힌 경우만 정리한다.
        patchLastAssistant((m) =>
          m.status === "streaming"
            ? { ...m, status: "error", error: "응답 완료 전에 스트림이 종료되었습니다" }
            : m,
        );
        setStreamId(null);
        setBusy(false);
      },
    },
    { enabled: streamId !== null, retry: 0 },
  );

  // retry: 0 이라 연결 실패 시 end 이벤트 없이 error state 만 남는다.
  useEffect(() => {
    if (streamId !== null && streamState.error) {
      failStreaming(streamState.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamState.error]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || busy) return;

    // threadCoord 에는 systemHash 가 박혀 있고 모델 변경은 서버가 검증하지 않으므로,
    // 둘 중 하나라도 바뀌면 좌표를 버리고 history 로 문맥을 복구한다.
    const sys = system.trim();
    const selectedTokenName = resolvedTokenName(tokenName, tokenOptions, tokenListLoaded);
    const currentConfig = { model, system: sys, tokenName: selectedTokenName };
    if (lastConfigRef.current && chatConfigChanged(lastConfigRef.current, currentConfig)) {
      threadCoordRef.current = undefined;
    }
    lastConfigRef.current = currentConfig;

    const images = supportsImages ? attachments : [];
    const history = buildHistory(messages);
    setMessages((prev) => [
      ...prev,
      { role: "user", text: prompt, ...(images.length > 0 ? { images } : {}) },
      { role: "assistant", text: "", status: "streaming" },
    ]);
    setDraft("");
    setAttachments([]);
    setBusy(true);

    try {
      const { streamId: id } = await QgridService.prepareStream({
        prompt,
        model,
        projectName: CHAT_PROJECT_NAME,
        ...tokenTargetPayload(selectedTokenName),
        ...(sys ? { system: sys } : {}),
        ...(effort ? { effort } : {}),
        // text 파트 없이 image 파트만 보내면 서버가 prompt 를 text 파트로 앞에 붙여준다.
        ...(images.length > 0
          ? { input: images.map((url) => ({ type: "image" as const, url })) }
          : {}),
        ...(history.length > 0 ? { history: JSON.stringify(history) } : {}),
        ...(threadCoordRef.current ? { runContext: { threadCoord: threadCoordRef.current } } : {}),
      });
      setStreamId(id);
    } catch (e) {
      failStreaming(errorMessage(e));
    }
  };

  // EventSource 를 닫으면 서버 sse.onClose 가 abort 와 run 마감을 처리한다.
  const stop = () => {
    patchLastAssistant((m) => (m.status === "streaming" ? { ...m, status: "aborted" } : m));
    setStreamId(null);
    setBusy(false);
  };

  // 축소 애니메이션이 끝난 뒤 언마운트한다. reduced motion 이면 애니메이션이 아예 돌지
  // 않아 onAnimationEnd 가 오지 않으므로 즉시 닫는다.
  const closePanel = () => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOpen(false);
      return;
    }
    setPanelClosing(true);
  };

  const resetChat = () => {
    if (busy) stop();
    setMessages([]);
    threadCoordRef.current = undefined;
    lastConfigRef.current = undefined;
  };

  return (
    <div className="fixed bottom-5 right-5 z-40">
      {open ? (
        <div
          onAnimationEnd={() => {
            if (panelClosing) {
              setOpen(false);
              setPanelClosing(false);
            }
          }}
          className={`flex flex-col w-[min(400px,calc(100vw-2.5rem))] h-[min(640px,calc(100dvh-7rem))] bg-white rounded-2xl shadow-[0_16px_48px_rgba(44,36,24,0.18),0_0_0_1px_rgba(227,218,204,0.6)] overflow-hidden origin-bottom-right ${panelClosing ? "chat-panel-pop-out" : "chat-panel-pop"}`}
        >
          <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-sand-100 shrink-0">
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-sand-900 leading-tight">채팅</p>
              <p className="text-[11px] text-sand-400 truncate leading-tight">
                {model}
                {effort ? ` · ${effort}` : ""}
                {tokenName ? ` · ${tokenName}` : ""}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setSettingsOpen((v) => !v)}
                title="모델·토큰·effort·system prompt 설정"
                className={`size-8 grid place-items-center rounded-full transition-colors duration-150 ${
                  settingsOpen
                    ? "text-sienna-500 bg-sienna-50"
                    : "text-sand-500 hover:text-sand-700 hover:bg-sand-100"
                }`}
              >
                <SlidersIcon className="size-4" />
              </button>
              <button
                type="button"
                onClick={resetChat}
                disabled={messages.length === 0}
                title="새 대화"
                className="size-8 grid place-items-center rounded-full text-sand-500 hover:text-sand-700 hover:bg-sand-100 disabled:opacity-40 transition-colors duration-150"
              >
                <RotateIcon className="size-4" />
              </button>
              <button
                type="button"
                onClick={closePanel}
                title="닫기"
                className="size-8 grid place-items-center rounded-full text-sand-500 hover:text-sand-700 hover:bg-sand-100 transition-colors duration-150"
              >
                <XIcon className="size-4.5" />
              </button>
            </div>
          </div>

          {settingsOpen && (
            <div className="px-4 py-2.5 border-b border-sand-100 bg-sand-50/60 shrink-0 flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={busy}
                  className="min-w-0 flex-1 rounded-xl border border-sand-200/80 bg-white px-2 py-1.5 text-[12px] text-sand-800 focus:outline-none focus:border-sienna-300 disabled:opacity-50"
                >
                  {MODEL_PRESET_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <select
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                  disabled={busy}
                  className="rounded-xl border border-sand-200/80 bg-white px-2 py-1.5 text-[12px] text-sand-600 focus:outline-none focus:border-sienna-300 disabled:opacity-50"
                >
                  <option value="">effort 기본</option>
                  {EFFORT_PRESETS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <select
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                disabled={busy}
                aria-label="요청 토큰"
                className="w-full rounded-xl border border-sand-200/80 bg-white px-2 py-1.5 text-[12px] text-sand-700 focus:outline-none focus:border-sienna-300 disabled:opacity-50"
              >
                <option value="">토큰 자동 분배</option>
                {tokenOptions.map((token) => (
                  <option key={token.name} value={token.name}>
                    {token.name}
                  </option>
                ))}
              </select>
              <textarea
                value={system}
                onChange={(e) => setSystem(e.target.value)}
                disabled={busy}
                placeholder="system prompt (선택)"
                rows={2}
                className="w-full resize-none rounded-xl border border-sand-200/80 bg-white px-2.5 py-1.5 text-[12px] text-sand-800 placeholder:text-sand-400 focus:outline-none focus:border-sienna-300 disabled:opacity-50"
              />
            </div>
          )}

          <div ref={scrollRef} className="flex-1 overflow-y-auto main-scroll px-3.5 py-3">
            {messages.length === 0 ? (
              <div className="h-full grid place-items-center">
                <div className="text-center px-4">
                  <img
                    src={chatIcon}
                    alt=""
                    className="mx-auto mb-2.5 size-14 rounded-[35%] object-cover"
                  />
                  <p className="text-[13px] text-sand-600">가용 토큰에게 바로 물어보세요.</p>
                  <p className="mt-1 text-[11px] text-sand-400">
                    대화는 저장되지 않고, 요청은{" "}
                    <Link
                      to="/logs"
                      search={{ project: CHAT_PROJECT_NAME, page: 1 }}
                      className="text-sienna-500 hover:underline"
                    >
                      request log
                    </Link>
                    에 기록됩니다.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {messages.map((m, i) =>
                  m.role === "user" ? (
                    <div key={i} className="self-end max-w-[80%] flex flex-col items-end gap-1">
                      {m.images && (
                        <div className="flex flex-wrap justify-end gap-1">
                          {m.images.map((url, j) => (
                            <img
                              key={j}
                              src={url}
                              alt=""
                              className="size-24 rounded-xl object-cover"
                            />
                          ))}
                        </div>
                      )}
                      <div className="rounded-[18px] rounded-br-[5px] bg-sienna-600 px-3.5 py-2 text-[13px] leading-relaxed text-white whitespace-pre-wrap break-words">
                        {m.text}
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="self-start max-w-[88%] min-w-0">
                      <div className="rounded-[18px] rounded-bl-[5px] bg-sand-100 px-3.5 py-2">
                        {m.text ? (
                          <div className="prose prose-sm prose-qgrid max-w-none text-[13px] leading-relaxed break-words">
                            <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>
                          </div>
                        ) : m.status === "streaming" ? (
                          <span
                            className="inline-flex gap-1 py-1.5 px-0.5"
                            aria-label="응답 대기 중"
                          >
                            <span className="chat-typing-dot" />
                            <span className="chat-typing-dot [animation-delay:150ms]" />
                            <span className="chat-typing-dot [animation-delay:300ms]" />
                          </span>
                        ) : null}
                        {m.status === "aborted" && (
                          <p className="mt-1 text-[10px] text-sand-400">중단됨</p>
                        )}
                        {m.status === "error" && (
                          <p className="mt-1 text-[12px] text-danger-500 break-words">{m.error}</p>
                        )}
                      </div>
                      {m.meta && (
                        <Link
                          to={m.meta.requestLogId !== undefined ? "/requests/show" : "/logs"}
                          search={
                            m.meta.requestLogId !== undefined
                              ? { id: m.meta.requestLogId }
                              : { project: CHAT_PROJECT_NAME, page: 1 }
                          }
                          className="mt-1 ml-1.5 inline-block text-[10px] tabular-nums text-sand-400 hover:text-sienna-500 transition-colors duration-150"
                          title="request log 보기"
                        >
                          {m.meta.model}
                          {m.meta.fallback && " (폴백)"}
                          {m.meta.tokenName ? ` · ${m.meta.tokenName}` : ""}
                          {` · ${(m.meta.durationMs / 1000).toFixed(1)}s · ${formatCost(m.meta.costUsd)}`}
                        </Link>
                      )}
                    </div>
                  ),
                )}
              </div>
            )}
          </div>

          {selectedProviderMissing && (
            <div className="px-4 py-1.5 border-t border-caution-400/30 bg-caution-400/10 text-[11px] text-caution-500 shrink-0">
              {PROVIDER_LABELS[provider] ?? provider} 토큰이 등록되어 있지 않습니다.{" "}
              <Link to="/tokens" className="font-medium underline hover:text-caution-400">
                Tokens 페이지
              </Link>
              에서 추가해주세요.
            </div>
          )}
          <div className="px-3 py-2.5 border-t border-sand-100 shrink-0">
            {attachments.length > 0 && (
              <div className="flex gap-1.5 pb-2">
                {attachments.map((url, i) => (
                  <div key={i} className="relative">
                    <img src={url} alt="" className="size-12 rounded-xl object-cover" />
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                      title="첨부 제거"
                      className="absolute -top-1.5 -right-1.5 size-4.5 grid place-items-center rounded-full bg-sand-800 text-white hover:bg-sand-700"
                    >
                      <XIcon className="size-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-1.5">
              {supportsImages && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(e) => {
                      void addAttachments(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={busy || attachments.length >= MAX_ATTACHMENTS}
                    title="이미지 첨부"
                    className="size-9 shrink-0 grid place-items-center rounded-full text-sand-500 hover:text-sand-700 hover:bg-sand-100 disabled:opacity-40 transition-colors duration-150"
                  >
                    <ImageIcon className="size-4.5" />
                  </button>
                </>
              )}
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="메시지 입력..."
                rows={1}
                className="min-w-0 flex-1 resize-none [field-sizing:content] max-h-28 rounded-[20px] border border-sand-200/80 bg-sand-50/60 px-4 py-2 text-[13px] leading-relaxed text-sand-800 placeholder:text-sand-400 focus:outline-none focus:border-sienna-300 focus:bg-white transition-colors duration-150"
              />
              {busy ? (
                <button
                  type="button"
                  onClick={stop}
                  title="응답 중단"
                  className="size-9 shrink-0 grid place-items-center rounded-full border border-sand-200/80 text-sand-600 hover:bg-sand-100 active:scale-[0.96] transition-all duration-150"
                >
                  <SquareIcon className="size-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!draft.trim()}
                  title="전송"
                  className="size-9 shrink-0 grid place-items-center rounded-full bg-sienna-600 text-white hover:bg-sienna-700 disabled:opacity-40 active:scale-[0.96] transition-all duration-150"
                >
                  <SendIcon className="size-4.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="채팅 열기"
          className="block size-15 rounded-[35%] overflow-hidden shadow-[0_6px_20px_rgba(44,36,24,0.25)] hover:scale-105 active:scale-[0.96] transition-transform duration-150"
        >
          <img src={chatIcon} alt="" className="size-full object-cover" />
        </button>
      )}
    </div>
  );
}
