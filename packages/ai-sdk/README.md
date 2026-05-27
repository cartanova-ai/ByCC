# @cartanova/qgrid-ai-sdk

AI SDK v6 custom `LanguageModelV3` provider for [qgrid](https://github.com/cartanova-ai/Qgrid).

**기존 AI SDK 코드 변경 없이, `model` 한 줄만 바꾸면 qgrid를 통한 구독 토큰으로 N개(토큰개수) 병렬 풀링 + request log 대시보드를 사용가능**

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

이미 다른 provider(google, openai 등)를 직접 사용하고 있다면, **logger 옵션 한 줄**만 추가하면 에이전트의 매 step(generate, tool-call, reasoning)을 qgrid 대시보드에서 확인할 수 있습니다.

```diff
 const { text } = await generateText({
   model: google("gemini-3-flash"),
   prompt: "복잡한 질문",
+  experimental_telemetry: createQgridLogger({ serverUrl: "http://localhost:44900" }),
 });
```

## 설치

```bash
pnpm add @cartanova/qgrid-ai-sdk
```

Peer dependencies: `ai@^6.0.0`, `@ai-sdk/provider@^3.0.0`

## 빠른 시작

```typescript
import { generateText } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: "서울 날씨 알려줘",
});
```

qgrid 서버(`http://localhost:44900`)가 실행 중이어야 합니다.

## 사용법
> 들어가기전에: 모든 클라언트 사용법은 [AI-SDK](https://ai-sdk.dev/docs/ai-sdk-core)와 동일합니다.

### 텍스트 생성

```typescript
import { generateText } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  system: "당신은 학술 논문 요약가입니다.",
  prompt: paperText,
});
```

### 구조화 응답 (Structured Output)
> [AI-SDK structured output guide를 참조하세요](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)

```typescript
import { generateText, Output } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";
import { z } from "zod";

const { output } = await generateText({
  model: qgrid("openai/gpt-5.4"),
  system: "논문 메타데이터를 추출해주세요.",
  prompt: paperText,
  output: Output.object({
    schema: z.object({
      title: z.string(),
      authors: z.array(z.string()),
      keyFindings: z.array(z.string()),
    }),
  }),
});

console.log(output.title, output.authors);
```

top-level이 `object`인 schema는 OpenAI structured output으로 서버에 전달됩니다 (임의로 타입 지정 시 파싱 에러)
top-level이 AI-SDK의 가이드를 따르지않으면 AI SDK 클라이언트 파싱으로 fallback되며 경고 로그가 출력됩니다.

### 스트리밍

```typescript
import { streamText } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

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
import { generateText, tool } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";
import { z } from "zod";

const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: "서울 날씨 알려줘",
  tools: {
    getWeather: tool({
      description: "도시의 현재 날씨 조회",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        return { temperature: 22, condition: "맑음" };
      },
    }),
  },
});
```

tool-call은 qgrid 서버의 structured output emulation으로 동작합니다.
AI SDK가 tool 실행을 관리하고, qgrid는 각 턴의 LLM 호출만 담당합니다.

### Provider Options

```typescript
import { generateText } from "ai";
import { qgrid, type QgridProviderOptions } from "@cartanova/qgrid-ai-sdk";

const providerOptions = {
  openai: {
    reasoningEffort: "high",
    reasoningSummary: "concise",
    textVerbosity: "medium",
  },
} satisfies QgridProviderOptions;

const { text } = await generateText({
  model: qgrid("openai/gpt-5.4"),
  prompt: "복잡한 문제를 분석해줘",
  providerOptions,
});
```

| 옵션 | 값 | 설명 |
|---|---|---|
| `reasoningEffort` | `"none"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | reasoning 모델의 추론 깊이 |
| `reasoningSummary` | `"auto"` \| `"concise"` \| `"detailed"` \| `"none"` | 추론 요약 출력 방식 (Responses API 전용) |
| `textVerbosity` | `"low"` \| `"medium"` \| `"high"` | 응답 텍스트의 상세도 |

codex app-server가 지원하는 옵션만 포함되어 있습니다. `temperature`, `maxOutputTokens` 등은 codex가 무시합니다.

## Telemetry Logger

qgrid provider가 아닌 모델(google, openai 직접 호출)에서도 같은 request log 대시보드를 사용하려면 `createQgridLogger`를 `experimental_telemetry`에 넣으면 됩니다.

```typescript
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { createQgridLogger } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: google("gemini-3-flash"),
  prompt: "안녕하세요",
  experimental_telemetry: createQgridLogger({
    serverUrl: "http://localhost:44900",
  }),
});
```

병렬 호출, run 분리, telemetry 활성화 등은 자동 처리됩니다.

### Logger 설정

```typescript
createQgridLogger({
  serverUrl: string;           // qgrid 서버 주소 (필수)
  projectName?: string;        // request_logs.project_name
  tokenName?: string;          // request_logs.token_name (기본: "external")
  staleRunTimeoutMs?: number;  // watchdog timeout (기본: 30분, 0으로 비활성화)
  onLogError?: (error: Error) => void;  // 로깅 실패 콜백
});
```

모든 설정은 optional (serverUrl 제외). 기본값이 있으므로 `serverUrl`만 넣으면 동작합니다.

### qgrid provider와 함께 사용

`qgrid()` provider는 자체 lifecycle이 있으므로 logger가 자동으로 suppress됩니다. 같은 코드에서 qgrid provider와 다른 provider를 섞어 써도 이중 기록되지 않습니다.

## 지원 모델

```typescript
type QgridSupportedModel =
  // OpenAI (based on codex app-server)
  | "openai/gpt-5.5"
  | "openai/gpt-5.4"
  | "openai/gpt-5.2"
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.3-codex"
  | "openai/gpt-5.3-codex-spark"
  // Anthropic
  | "anthropic/claude-haiku-4-5"
  | "anthropic/claude-sonnet-4"
  | "anthropic/claude-sonnet-4-5"
  | "anthropic/claude-sonnet-4-6"
  | "anthropic/claude-sonnet-4-7"
  | "anthropic/claude-opus-4"
  | "anthropic/claude-opus-4-1"
  | "anthropic/claude-opus-4-5"
  | "anthropic/claude-opus-4-6"
  | "anthropic/claude-opus-4-7"
```

## 설정

```typescript
qgrid(modelId, {
  serverUrl?: string;      // qgrid 서버 주소 (기본: QGRID_URL 환경변수 또는 http://localhost:44900)
  defaultEffort?: string;  // reasoningEffort 기본값 (기본: "low")
});
```

## 환경변수

| 변수 | 설명 | 기본값 |
|---|---|---|
| `QGRID_URL` | qgrid 서버 주소 | `http://localhost:44900` |

## 주의사항

- `temperature`, `maxOutputTokens` 등 sampling 파라미터는 codex app-server가 지원하지 않아 무시됩니다.
- Structured output은 top-level `object` schema만 지원합니다. top-level `array`는 클라이언트 파싱 fallback.

## 요구사항

- Node.js >= 20
- AI SDK v6 (`ai@^6.0.0`)
- 실행 중인 qgrid 서버
