# Qgrid

[English](./README.md) · **한국어**

**LLM 구독 토큰을 API처럼 사용.** OpenAI/Anthropic 구독 크레딧을 HTTP API로 노출하는 LLM 프록시 서버.

종량제 API 키 없이 **구독 정액제**로 GPT-5.5, Claude Opus 등을 호출. N개 계정의 쿼터를 풀링하여 병렬 분산.

---

## 다른 구독 프록시와 다른점

기존 구독 토큰 프록시(claude-proxy 등)는 CLI를 한 번 호출하고 텍스트를 반환하는 **single-turn 텍스트 프록시**입니다. 구독 토큰은 공식 API가 아니라 CLI/앱을 통해서만 사용 가능하고, 단순 CLI 호출로는 tool-call, structured output, multi-turn agent loop 같은 API 기능을 쓸 수 없기 때문입니다.

Qgrid는 두 개의 CLI 런타임 위에 AI SDK `LanguageModelV3` custom provider를 구현하여 이 문제를 해결합니다:

- **OpenAI** — [codex app-server](https://github.com/openai/codex). 구독 토큰으로 Responses API를 쓸 수 있는 JSON-RPC 서버입니다. Qgrid는 토큰당 persistent worker 프로세스를 유지하고, 대화 thread를 재사용해 prompt cache를 적중시킵니다.
- **Anthropic** — Claude Code `stream-json` 모드. 요청마다 격리된 프로세스를 fresh spawn하고 전체 대화 히스토리를 재주입하므로, persistent session 없이도 multi-turn이 동작합니다.

덕분에:

- **Tool Calling** — AI SDK의 `tools` 옵션이 양쪽 provider 모두에서 그대로 동작. 서버가 structured output emulation으로 tool-call 형태를 만들고, AI SDK가 tool 실행을 관리.
- **Multi-step Agent Loop** — `stopWhen`, `maxSteps`로 tool-call → tool 실행 → 다음 턴을 자동 반복. 구독 토큰으로 agent를 만들 수 있음.
- **Structured Output** — `Output.object({ schema })` 로 JSON schema 강제. OpenAI는 codex structured output으로, Anthropic은 Claude Code `--json-schema` + 후검증으로 처리하며 검증 실패 시 깨진 JSON 대신 명시적 에러 반환.
- **Prompt Caching** — `sessionKey`만 넘기면 멀티턴 대화가 같은 codex thread로 라우팅되어 prompt cache 적중 (OpenAI).
- **Streaming** — [Sonamu Framework](https://github.com/cartanova-ai/sonamu)의 SSE 기반 실시간 텍스트 스트리밍.

---

## 왜 Qgrid?

- **API 키 비용 0원** — 이미 결제 중인 OpenAI/Anthropic 구독 토큰을 그대로 활용. 별도 종량제 API 키 불필요.
- **Tool Calling + Agent Loop** — 구독 토큰으로 tool-call, multi-step agent loop 가능. 단순 텍스트 프록시가 아님.
- **AI SDK 호환** — 기존 코드에서 `model` 한 줄만 교체. `generateText`, `streamText`, structured output, tool-call 전부 동작.
  ```ts
  model: qgrid("openai/gpt-5.4-mini")  // 이것만 바꾸면 됨
  ```
- **N개 구독 풀링** — 팀원 구독 계정을 모아서 병렬 처리. 토큰당 worker N개로 동시 요청 분산. 토큰별 quota threshold로 사용률 초과 토큰은 라우팅에서 자동 제외.
- **Request Log 대시보드** — 매 요청의 토큰 사용량, 비용, 캐시 적중, TTFT, tool-call 내역, reasoning을 웹 UI에서 실시간 확인.
- **이미지 생성** — 요청 단위로 codex `image_generation` tool을 켜고 표준 AI SDK 응답으로 PNG 파일 수신.
- **OpenAI + Anthropic** — 양쪽 구독 토큰 모두 등록 가능. OAuth 원클릭 로그인.

---

## 빠른 시작

### 1. 서버 실행

```bash
npm i -g @cartanova/qgrid-cli
```

Qgrid는 OAuth 토큰과 request log를 저장하기 위해 PostgreSQL이 필요합니다.
이미 접근 가능한 PostgreSQL이 있으면 바로 연결하면 되고, 로컬에 없으면 Docker로 띄울 수 있습니다:

```bash
docker run --name qgrid-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=qgrid \
  -p 5432:5432 \
  -d postgres:18

qgrid --db postgres://postgres:postgres@localhost:5432/qgrid
```

`http://localhost:44900`에서 대시보드 접속 → 토큰 등록 (OAuth 로그인).
> 모든 인증은 각 프로바이더의 Oauth flow를 따라갑니다.
> 로그인 성공시 받은 token을 permanently하게 저장하기위해 postgres 의존성이 필요합니다 (**postgres:18**)

### 2. SDK 설치

```bash
pnpm add @cartanova/qgrid-ai-sdk
```

### 3. 코드 한 줄만 변경

```diff
 import { generateText } from "ai";
-import { openai } from "@ai-sdk/openai";
+import { qgrid } from "@cartanova/qgrid-ai-sdk";

 const { text } = await generateText({
-  model: openai("gpt-5.4-mini"),
+  model: qgrid("openai/gpt-5.4-mini"),
   prompt: "서울 날씨 알려줘",
 });
```

기존 AI SDK 코드 그대로. `model`만 바꾸면 qgrid 서버를 통해 구독 토큰으로 호출됩니다.

### 4. (선택) 다른 provider에 로거 추가

이미 google/openai provider를 직접 쓰고 있다면, **한 줄 추가**로 대시보드에서 로그를 볼 수 있습니다:

```diff
+import { createQgridLogger } from "@cartanova/qgrid-ai-sdk";

 const { text } = await generateText({
   model: google("gemini-3-flash"),
   prompt: "복잡한 질문",
+  experimental_telemetry: createQgridLogger({ serverUrl: "http://localhost:44900" }),
 });
```

---

## 아키텍처

![Qgrid architecture](./assets/qgrid-architecture.ko.svg)

- **OpenAI** — persistent codex app-server 프로세스를 토큰당 N개 spawn. JSON-RPC로 통신. idle worker에 round-robin 라우팅, 전부 busy면 큐 대기(60초 타임아웃). `sessionKey`가 있는 멀티턴 대화는 같은 thread로 재라우팅되어 prompt cache 적중.
- **Anthropic** — 요청마다 격리된 Claude Code 프로세스를 fresh spawn (`stream-json` 입출력, 토큰별 config 격리). 대화 히스토리는 매 턴 재주입. OAuth 토큰 자동 refresh.
- **Quota threshold** — 토큰별 사용률 임계값(기본 80%). 임계값을 넘은 토큰은 rolling window가 회복될 때까지 라우팅에서 제외.
- **Request Log** — 매 요청의 generate step, tool-call step, reasoning, 토큰 사용량, 캐시 지표, TTFT, 비용을 DB에 기록. 대시보드에서 확인.

> **codex 내장 하네스 제거:** codex app-server는 매 요청마다 내장 tool(shell, web_search, apply_patch 등 14개)과 instruction 블록(permissions, environment_context, skills, ~10KB)을 자동 주입합니다. Qgrid는 worker의 `config.toml`로 이를 전부 비활성화하고 최소 system prompt + no environment로 실행합니다. 덕분에 codex가 **coding agent가 아니라 순수 텍스트 생성 엔드포인트**처럼 동작하며, 불필요한 input token 오버헤드와 엉뚱한 내장 tool 호출이 없습니다. 모델이 보는 tool은 AI SDK로 넘긴 것뿐입니다.

---

## SDK 사용법

자세한 사용법은 [`@cartanova/qgrid-ai-sdk` README](./packages/ai-sdk/README.ko.md)를 참조하세요.

### 텍스트 생성

```typescript
const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  system: "당신은 학술 논문 요약가입니다.",
  prompt: paperText,
});
```

### Structured Output

```typescript
const { output } = await generateText({
  model: qgrid("openai/gpt-5.4"),
  prompt: paperText,
  output: Output.object({
    schema: z.object({
      title: z.string(),
      authors: z.array(z.string()),
      keyFindings: z.array(z.string()),
    }),
  }),
});
```

### 스트리밍

```typescript
const { textStream } = streamText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: "TypeScript의 장점을 설명해줘",
});

for await (const chunk of textStream) {
  process.stdout.write(chunk);
}
```

### Tool Calling

```typescript
const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: "서울 날씨 알려줘",
  tools: {
    getWeather: tool({
      description: "도시의 현재 날씨 조회",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ temperature: 22, condition: "맑음" }),
    }),
  },
});
```

### Prompt Caching (sessionKey)

```typescript
// 멀티턴 대화를 같은 codex thread로 라우팅 → prompt cache 적중 (OpenAI)
const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: nextTurn,
  providerOptions: { qgrid: { sessionKey: "chat-room-42" } },
});
```

### 이미지 생성

```typescript
// OpenAI 경로 + generateText 전용 — 해당 요청에만 codex image_generation tool 활성화
const result = await generateText({
  model: qgrid("openai/gpt-5.4"),
  prompt: "우주를 나는 고래 일러스트",
  providerOptions: { qgrid: { imageGeneration: true } },
});

const image = result.files[0]; // mediaType: "image/png", base64
```

레퍼런스 이미지는 AI SDK multimodal message part로 전달할 수 있습니다:

```typescript
const result = await generateText({
  model: qgrid("openai/gpt-5.4"),
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "이 이미지를 스타일 레퍼런스로 사용해서 포스터를 만들어줘" },
        { type: "file", mediaType: "image/png", data: referenceImageBase64 },
      ],
    },
  ],
  providerOptions: { qgrid: { imageGeneration: true } },
});
```

레퍼런스 이미지는 JSON data URL로 전송되므로 큰 사진은 압축하거나 리사이즈해서 전달하세요. SDK는 과도하게 큰 base64 입력을 명확한 에러로 거부하며, 사진에는 WebP/JPEG를 권장합니다.

---

## CLI

```bash
npm i -g @cartanova/qgrid-cli

qgrid --db postgres://user:password@host:port/dbname
qgrid --db postgres://... -p 3000  # 포트 지정
```

CLI 설치 시 코딩 에이전트용 qgrid skill이 자동 동기화됩니다 — global 설치는 `~/.codex/skills/qgrid`, `~/.claude/skills/qgrid`, 프로젝트 설치는 `.agents/skills`, `.claude/skills`. 자세한 내용은 [`@cartanova/qgrid-cli` README](./packages/cli/README.ko.md)를 참조하세요.

환경변수로 DB 설정 가능:

```bash
export QGRID_DB_HOST=dev.example.com
export QGRID_DB_PORT=5432
export QGRID_DB_USER=postgres
export QGRID_DB_PASSWORD=postgres
export QGRID_DB_NAME=qgrid
qgrid
```

---

## 팀 사용 (공유 DB)

팀원들이 같은 PostgreSQL을 바라보면 토큰 풀을 공유합니다:

```bash
# 각 팀원 로컬에서
qgrid --db postgres://user:pw@dev.example.com:5432/qgrid

# 각 팀원 프로젝트에서
QGRID_URL=http://localhost:44900
QGRID_PROJECT_NAME=my-service   # request log 프로젝트 라벨
```

대시보드에서 전체 팀의 request log를 프로젝트별로 필터링하여 확인할 수 있습니다. 트래픽이 늘어도 워크로드를 구분할 수 있도록 각 프로젝트에 `QGRID_PROJECT_NAME`을 설정하세요.

---

## 지원 모델

| Provider | 모델 |
|---|---|
| OpenAI | `openai/gpt-5.5`, `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-5.3-codex`, `openai/gpt-5.3-codex-spark`, `openai/gpt-5.2` |
| Anthropic | `anthropic/claude-sonnet-5`, `anthropic/claude-opus-4-8`, `anthropic/claude-opus-4-7`, `anthropic/claude-opus-4-6`, `anthropic/claude-opus-4-5`, `anthropic/claude-opus-4-1`, `anthropic/claude-opus-4`, `anthropic/claude-sonnet-4-7`, `anthropic/claude-sonnet-4-6`, `anthropic/claude-sonnet-4-5`, `anthropic/claude-sonnet-4`, `anthropic/claude-haiku-4-5` |

> `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-8`은 자동으로 1M 토큰 컨텍스트로 실행됩니다.

---

## 환경변수

| 변수 | 설명 | 기본값 |
|---|---|---|
| `QGRID_URL` | qgrid 서버 주소 (SDK) | `http://localhost:44900` |
| `QGRID_PROJECT_NAME` | request log 프로젝트 이름 (SDK/logger). 대시보드 프로젝트별 필터링에 사용 | (없음) |
| `QGRID_DB_HOST` | PostgreSQL 호스트 | `localhost` |
| `QGRID_DB_PORT` | PostgreSQL 포트 | `5432` |
| `QGRID_DB_USER` | PostgreSQL 사용자 | `postgres` |
| `QGRID_DB_PASSWORD` | PostgreSQL 비밀번호 | `postgres` |
| `QGRID_DB_NAME` | 데이터베이스 이름 | `qgrid` |
| `QGRID_WORKERS_PER_TOKEN` | OpenAI 토큰당 worker 수 | `3` (최대 5) |
| `QGRID_PUBLIC_BASE_URL` | Anthropic OAuth callback 공개 베이스 URL | `http://localhost:<port>` |
| `QGRID_OPENAI_THREAD_REUSE` | `false`로 설정 시 OpenAI thread reuse(prompt cache) 비활성화 | 활성 |

---

## 패키지 구조

```
packages/
├── ai-sdk/  ← @cartanova/qgrid-ai-sdk (AI SDK v6 provider + logger)
├── api/     ← Sonamu 서버 (QgridDispatcher, Request Log, OAuth)
├── web/     ← 대시보드 React 앱 (TanStack Router + Query)
├── sdk/     ← @cartanova/qgrid-sdk (v1, deprecated)
└── cli/     ← @cartanova/qgrid-cli (서버 번들 포함)
```

---

## 사전 요구사항

- Node.js >= 20
- PostgreSQL
- Docker (로컬 PostgreSQL을 컨테이너로 실행할 경우)
- [Codex CLI](https://github.com/openai/codex) (OpenAI 모델 사용 시)
- [Claude Code](https://www.anthropic.com/claude-code) (Anthropic 모델 사용 시)

---

## 주의사항

- **OpenAI 모델**: codex app-server 기반. `temperature`, `maxOutputTokens` 등 sampling 파라미터는 지원하지 않습니다.
- **Anthropic 모델**: Claude Code 기반. OAuth 로그인 필요. tool calling과 structured output은 OpenAI와 동일하게 동작하지만, 요청마다 fresh process로 실행되므로 `sessionKey` thread reuse는 적용되지 않습니다.
- **Anthropic structured output**: codex(constrained decoding)와 달리 Claude Code의 `--json-schema`는 생성을 강제하지 않고 가이드+사후 검증하므로, 복잡한 schema는 간헐적으로 검증에 실패할 수 있습니다. qgrid는 내부 재시도를 기본 차단하고 1회만 시도하며, 실패 시 깨진 JSON 대신 명시적 에러를 반환합니다.
- **쿼터 관리**: 구독 rate limit (5시간/7일 rolling window) 적용. 토큰별 quota threshold(기본 80%) 초과 시 라우팅에서 자동 제외되며, 대시보드에서 수동 비활성화도 가능합니다.
