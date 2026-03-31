/**
 * ByCC HTTP 클라이언트 — 프로젝트에 복사해서 사용. 의존성: zod
 * BYCC_URL 환경변수로 서버 주소 설정 (기본: http://localhost:44900)
 */
import { z } from "zod";

const BYCC_URL = process.env.BYCC_URL ?? "http://localhost:44900";

const jsonSchemaCache = new WeakMap<z.ZodType, string>();
function getJsonSchemaString(schema: z.ZodType): string {
  let cached = jsonSchemaCache.get(schema);
  if (!cached) {
    cached = JSON.stringify(z.toJSONSchema(schema));
    jsonSchemaCache.set(schema, cached);
  }
  return cached;
}

type ByccBase = {
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  durationMs: number;
  costUsd: number;
};
type ByccTextResponse = ByccBase & { text: string };
type ByccJsonResponse<T> = ByccBase & { json: T };

export async function generateByCC<T extends z.ZodType | undefined = undefined>(params: {
  prompt: string;
  system: string;
  returnType?: T;
}): Promise<T extends z.ZodType ? ByccJsonResponse<z.infer<T>> : ByccTextResponse> {
  const { prompt, system, returnType } = params;
  const systemWithSchema = returnType
    ? `${system}\n\n반드시 다음 JSON Schema에 맞게 JSON으로만 응답하세요. 다른 텍스트 없이:\n${getJsonSchemaString(returnType)}`
    : system;

  const res = await fetch(`${BYCC_URL}/api/bycc/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, system: systemWithSchema }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`ByCC error (${res.status}): ${err.error ?? err.message ?? res.statusText}`);
  }

  const { text, ...rest } = await res.json();

  if (returnType) {
    try {
      return { ...rest, json: z.parse(returnType, JSON.parse(text)) } as any;
    } catch (e) {
      throw new Error(`ByCC JSON 파싱/검증 실패: ${(e as Error).message}\nRaw: ${text.slice(0, 200)}`);
    }
  }

  return { ...rest, text } as any;
}
