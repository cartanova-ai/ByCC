export type OpenAITransportKind = "https" | "websocket";

/**
 * OpenAI 전송 방식 선택. 동시성 knob 은 없다 — direct 전환으로 요청은 Anthropic 과
 * 동일하게 상한 없이 나가며, 상류 제한은 백엔드 응답이 진실이다.
 */
export function resolveOpenAITransportKind(
  env: Record<string, string | undefined> = process.env,
): OpenAITransportKind {
  const transport = env.QGRID_OPENAI_TRANSPORT ?? "websocket";
  if (transport !== "https" && transport !== "websocket") {
    throw new Error(
      `Invalid QGRID_OPENAI_TRANSPORT value: ${transport}. Expected https or websocket.`,
    );
  }
  return transport;
}
