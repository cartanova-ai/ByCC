# @cartanova/qgrid-ai-sdk

[English](./README.md) · **한국어**

AI SDK v6 custom `LanguageModelV3` provider for [qgrid](https://github.com/cartanova-ai/Qgrid).

**기존 AI SDK 코드 변경 없이, `model` 한 줄만 바꾸면 구독 토큰 풀링(토큰 N개 × concurrent permit) + request log 대시보드를 사용할 수 있습니다.**

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

OpenAI 서버 경로는 private ChatGPT Codex Responses backend를 HTTPS/SSE로 직접 호출합니다. 이 backend는 문서화되지 않아 예고 없이 변경될 수 있으며, qgrid의 mock protocol test는 live provider 검증이 아닙니다.

## 사용법
> 들어가기전에: 모든 클라이언트 사용법은 [AI-SDK](https://ai-sdk.dev/docs/ai-sdk-core)와 동일합니다.

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

top-level이 `object`인 schema는 서버 structured output으로 전달되어 강제됩니다.
top-level이 `object`가 아니면 (예: array) AI SDK 클라이언트 파싱으로 fallback되며 경고 로그가 출력됩니다.

> **Anthropic 모델 주의:** OpenAI/codex structured output은 디코딩 단계에서 schema를 강제(constrained decoding)하므로 이 부류 실패가 거의 없지만, Claude Code의 `--json-schema`는 `StructuredOutput` tool + 사후 검증 방식이라 복잡한 schema는 모델이 준수하지 못할 수 있습니다. qgrid는 structured streaming에만 `MAX_STRUCTURED_OUTPUT_RETRIES=1`을 주입해 1회 시도로 제한합니다(1 미만 값은 1로 클램프). non-stream `generate`에는 이 override를 주입하지 않고 Claude Code의 기본 retry 예산을 사용합니다. 각 경로의 시도 이후 검증이 실패하면 깨진 JSON 대신 명시적 에러를 반환합니다.

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
import { generateText, stepCountIs, tool } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";
import { z } from "zod";

const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: "서울 날씨 알려줘",
  tools: {
    getWeather: tool({
      description: "도시의 현재 날씨 조회",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        return { temperature: 22, condition: "맑음" };
      },
    }),
  },
  stopWhen: stepCountIs(3),
});
```

tool-call은 qgrid 서버의 structured output emulation으로 동작합니다.
AI SDK가 tool 실행을 관리하고, qgrid는 각 턴의 LLM 호출만 담당합니다.
실행 가능한 tool을 쓸 때는 제한이 있는 `stopWhen`을 지정해야 AI SDK가
tool-call 턴 뒤에도 계속 진행해 모델의 최종 응답을 받습니다.

`tools`와 `Output.object`를 함께 사용할 수도 있습니다.

```typescript
import { generateText, Output, stepCountIs, tool } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";
import { z } from "zod";

const { output } = await generateText({
  model: qgrid("openai/gpt-5.4"),
  prompt: "서울 날씨를 조회해서 예보를 반환해줘.",
  tools: {
    getWeather: tool({
      description: "도시의 현재 날씨 조회",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, temperature: 22 }),
    }),
  },
  stopWhen: stepCountIs(3),
  output: Output.object({
    schema: z.object({
      city: z.string(),
      summary: z.string(),
    }),
  }),
});
```

qgrid 2.5.4는 모든 모델 턴에 합성된 action envelope를 강제합니다. tool-call
턴은 AI SDK tool call로 유지되고, 마지막 `answer`는 사용자 schema로 강제된 뒤
`output`으로 반환됩니다. 제한이 있는 `stopWhen`을 지정하지 않으면 AI SDK가
기본 첫 번째 step에서 멈춰 최종 structured output을 만들 수 없습니다. qgrid server
2.5.4와 `@cartanova/qgrid-ai-sdk` 2.5.4가 모두 필요합니다. AI SDK의
`toolChoice`는 현재 전송하거나 강제하지 않으며 tool 선택은 모델이 결정합니다.

### Provider Options

qgrid 전용 옵션은 전부 `providerOptions.qgrid` 네임스페이스로 전달합니다. (`providerOptions.openai`가 아닙니다)
AI SDK는 바깥 `providerOptions`를 범용 JSON record로 타입 선언하므로 qgrid 옵션을 자동 추론하지 못합니다.
따라서 공개 타입 `QgridProviderOptions`를 중첩된 `qgrid` 값에 `satisfies`로 적용하세요. literal 추론을
유지하면서 qgrid 옵션의 오타와 잘못된 값을 컴파일 타임에 잡을 수 있습니다.

```typescript
import { generateText } from "ai";
import { qgrid, type QgridProviderOptions } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: qgrid("openai/gpt-5.4"),
  prompt: "복잡한 문제를 분석해줘",
  providerOptions: {
    qgrid: {
      effort: "high",
      reasoningSummary: "concise",
      verbosity: "medium",
    } satisfies QgridProviderOptions,
  },
});
```

| 옵션 | 값 | 적용 범위 | 설명 |
|---|---|---|---|
| `logger` | `boolean` | 공통 | qgrid request log 저장 여부. 기본값은 `true`. `false`로 설정해도 client tool 실행과 multi-step 연결은 계속 동작 |
| `sessionKey` | `string` | OpenAI 전용 | 전체 history 재전송 시 불투명 prompt-cache affinity를 파생하는 멀티턴 대화 식별자 ([아래](#멀티턴-prompt-cache-sessionkey) 참조) |
| `effort` | `"none"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | 공통 (지원 값은 모델별 상이, 예: `"max"`는 GPT-5.6+) | reasoning 모델의 추론 깊이. 기본값은 config의 `defaultEffort` (`"low"`) |
| `verbosity` | `"low"` \| `"medium"` \| `"high"` | OpenAI 전용 | 응답 텍스트의 상세도 |
| `reasoningSummary` | `"auto"` \| `"concise"` \| `"detailed"` \| `"none"` | OpenAI 전용 | 추론 요약 출력 방식 |
| `serviceTier` | `string` | OpenAI 전용 | OpenAI/codex service tier |
| `timeoutMs` | 양의 정수, 최대 `1_800_000` | Anthropic 전용 | 서버의 Claude Code 프로세스 제한시간(ms). SDK의 non-stream HTTP 제한은 이 값보다 60초 길게 설정. 기본값은 240초 |
| `imageGeneration` | `boolean` | OpenAI 전용, non-stream | codex 내장 `image_generation` tool 활성화 ([아래](#image-generation) 참조) |
| `imageGenerationOptions` | `{ quality?, size? }` | OpenAI 전용 | 이미지 품질/크기 힌트. `quality: "low" \| "medium" \| "high"`, `size: "1024x1024" \| "1024x1536" \| "1536x1024"` (기본: `medium` / `1536x1024`) |
| `fallbackModels` | `string[]` | 예약 | 향후 qgrid 서버 fallback routing용 예약 필드. 현재 동작하지 않으며 Claude Code의 Fable refusal fallback과 무관 |

AI SDK 최상위 `timeout`은 전체 클라이언트 제한시간이며 custom provider 실행 전에
`AbortSignal`로 변환됩니다. 따라서 그 숫자 자체는 qgrid에 전달되지 않습니다. qgrid 서버의
Claude Code 프로세스 제한시간을 바꾸려면 `providerOptions.qgrid.timeoutMs`를 사용하세요.
Anthropic `generateText` 요청에는 전역 설정을 바꾸지 않는 요청별 Undici dispatcher가 붙고,
`headersTimeout`과 `bodyTimeout`은 `timeoutMs + 60_000`으로 설정됩니다. 예를 들어 서버 제한이
600초면 HTTP 전송 예산은 660초입니다. 이 여유 시간 덕분에 클라이언트 전송 계층보다 서버의
명시적 timeout 응답이 먼저 도착할 수 있습니다. 클라이언트 취소 또는 비스트리밍 HTTP 연결
종료도 서버의 provider 실행을 중단합니다.

### 멀티턴 prompt cache (sessionKey)

멀티턴 대화에서 `sessionKey`로 호출자의 도메인 ID(게임 세션 ID, 채팅방 ID 등)를 넘기면 SDK가 model 범위의 불투명 affinity key를 파생합니다. Qgrid는 이를 `prompt_cache_key`로 보내고 매 요청 전체 대화 history를 재전송합니다. Provider thread나 process session은 보관하지 않습니다.

```typescript
const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: nextTurnPrompt,
  providerOptions: { qgrid: { sessionKey: "game-session-123" } },
});
```

- SDK 내부 affinity coordinate entry는 idle 10분 후 만료됩니다. 동일 affinity key 파생은 이 entry에 의존하지 않습니다.
- `anthropic/*` 모델에서는 무시됩니다. Claude Code는 자체 prefix-cache 동작을 사용합니다.

### Image Generation

OpenAI/codex 경로 전용, `generateText` 전용입니다. 해당 요청에만 codex 내장 `image_generation` tool을 켜고, 결과 이미지를 AI SDK `files`로 받습니다.

```typescript
const result = await generateText({
  model: qgrid("openai/gpt-5.4"),
  prompt: "우주를 나는 고래 일러스트",
  providerOptions: {
    qgrid: {
      imageGeneration: true,
      imageGenerationOptions: { quality: "medium", size: "1536x1024" },
    },
  },
});

const image = result.files[0]; // mediaType: "image/png", base64
```

레퍼런스 이미지는 일반 AI SDK multimodal message part로 전달할 수 있습니다:

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

- `streamText`에서는 거부됩니다 (non-stream 전용).
- 이미지 생성 요청은 provider 대화 상태를 보관하지 않고 전체 input을 직접 전송합니다.
- 레퍼런스 이미지는 JSON data URL로 전송됩니다. 큰 사진은 압축하거나 리사이즈해서 전달하세요. 과도하게 큰 base64 입력은 SDK가 거부하며, 사진에는 WebP/JPEG를 권장합니다.
- 이미지 비용은 `gpt-image-2` 공개 단가표 기반 **추정치**로 request log의 `image_cost_usd`에 별도 기록됩니다 (codex가 정확한 이미지 tool 사용량을 노출하지 않음).

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
  projectName?: string;        // request_logs.project_name (기본: QGRID_PROJECT_NAME 환경변수)
  tokenName?: string;          // request_logs.token_name (기본: "external")
  staleRunTimeoutMs?: number;  // watchdog timeout (기본: 30분 또는 AI SDK timeout + 여유시간, 0으로 비활성화)
  onLogError?: (error: Error) => void;  // 로깅 실패 콜백
});
```

모든 설정은 optional (serverUrl 제외). 기본값이 있으므로 `serverUrl`만 넣으면 동작합니다.

logger는 generate/tool-call step과 usage를 기록하지만, 장착된 tool 정의(name/description/inputSchema)는
기록하지 않습니다 — 대시보드의 "Tools" 섹션은 qgrid provider를 경유한 요청에만 표시됩니다.

특정 generation을 request log 저장에서 제외하려면 `providerOptions.qgrid.logger`를
`false`로 설정하세요. qgrid provider 호출과 `createQgridLogger`가 관찰하는 외부 provider
호출에 모두 적용되며, tool 실행과 multi-step 연결은 계속 정상 동작합니다.

```typescript
import { type QgridProviderOptions } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: google("gemini-3-flash"),
  prompt: "이 요청은 저장하지 마",
  providerOptions: {
    qgrid: { logger: false } satisfies QgridProviderOptions,
  },
  experimental_telemetry: createQgridLogger({ serverUrl: "http://localhost:44900" }),
});
```

외부 provider request log의 모델 이름은 `provider/modelId` 형식으로 저장됩니다. provider가
AI SDK response metadata로 실제 serving 모델을 다르게 보고하면 step과 final log에는
관찰된 serving 모델을 저장하고 requested model은 별도로 유지합니다. AI SDK runtime의
`response.modelId`는 변경하지 않습니다. `openai.responses`는 `openai`로,
`anthropic.messages`는 `anthropic`으로 적재하는 등 AI SDK adapter suffix는 base provider로 정규화합니다.

### qgrid provider와 함께 사용

`qgrid()` provider는 자체 lifecycle이 있으므로 logger가 자동으로 suppress됩니다. 같은 코드에서 qgrid provider와 다른 provider를 섞어 써도 이중 기록되지 않습니다.

## 지원 모델

```typescript
type QgridSupportedModel =
  // OpenAI (direct private Codex Responses backend)
  | "openai/gpt-5.6-sol"
  | "openai/gpt-5.6-terra"
  | "openai/gpt-5.6-luna"
  | "openai/gpt-5.5"
  | "openai/gpt-5.4"
  | "openai/gpt-5.2"
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.3-codex"
  | "openai/gpt-5.3-codex-spark"
  // Anthropic
  | "anthropic/claude-fable-5"
  | "anthropic/claude-haiku-4-5"
  | "anthropic/claude-sonnet-4"
  | "anthropic/claude-sonnet-4-5"
  | "anthropic/claude-sonnet-4-6"
  | "anthropic/claude-sonnet-4-7"
  | "anthropic/claude-sonnet-5"
  | "anthropic/claude-opus-4"
  | "anthropic/claude-opus-4-1"
  | "anthropic/claude-opus-4-5"
  | "anthropic/claude-opus-4-6"
  | "anthropic/claude-opus-4-7"
  | "anthropic/claude-opus-4-8"
  | "anthropic/claude-opus-5"
```

### GPT-5.6 사양

| 모델 | Context (qgrid OpenAI 경로) | 최대 출력 | 1M tokens당 input / cached input / output |
|---|---:|---:|---:|
| `openai/gpt-5.6-sol` | 372K | 128K | $5 / $0.50 / $30 |
| `openai/gpt-5.6-terra` | 372K | 128K | $2.50 / $0.25 / $15 |
| `openai/gpt-5.6-luna` | 372K | 128K | $1 / $0.10 / $6 |

세 모델 모두 `max` reasoning effort를 지원합니다. Qgrid는 model 설정에 사용해 온 구독 경로의 관측 한도인 372K context window(95% effective, 실사용 입력 약 353K)와 128K 최대 출력을 유지합니다. 이는 OpenAI public API에 표시된 1.05M context보다 작으며 local runtime의 제약으로 귀속하지 않습니다. 입력이 272K tokens를 넘으면 요청 전체에 input 2x, output 1.5x 장문 컨텍스트 할증이 적용되며, cache write는 uncached input 단가의 1.25x입니다.

`anthropic/claude-fable-5`는 1M context와 128K 최대 출력을 지원합니다. 1M tokens당 표준 단가는 input $10, cache read $1, 5분 cache write $12.50, 1시간 cache write $20, output $50입니다. qgrid는 Claude 응답의 5분/1시간 cache creation breakdown을 보존해 TTL별 단가를 각각 적용하며, breakdown이 없는 구버전 응답에서만 Claude Code가 subscription OAuth 경로에 자동 적용하는 1시간 TTL 단가로 fallback합니다. Fable은 adaptive thinking이 항상 켜져 있어야 하므로 qgrid는 이 모델의 adaptive thinking을 보존합니다.

`anthropic/claude-opus-5`는 기본 1M context와 128K 최대 출력을 지원합니다. 1M tokens당 단가는 input $5, cache read $0.50, 5분 cache write $6.25, 1시간 cache write $10, output $25입니다. qgrid는 Opus 5의 기본 adaptive thinking 동작을 유지하고 `effort`로 추론 깊이를 조절합니다. 따라서 `xhigh` 또는 `max` effort에서 허용되지 않는 `thinking: disabled` 조합도 만들지 않습니다.

Claude Code는 Fable의 safety refusal을 Opus 4.8로 자동 재시도할 수 있습니다. 이 경우 AI SDK 응답의 `response.modelId`와 `providerMetadata.qgrid.model`은 실제 serving 모델인 Opus를 가리킵니다. `providerMetadata.qgrid.requestedModel`은 Fable로 유지되고, `providerMetadata.qgrid.modelFallbacks`에 refusal fallback 이력이 담깁니다. 같은 metadata에서 `costSource`와 5분/1시간 cache-write 토큰 분해도 확인할 수 있습니다.

`openai/gpt-5.3-codex-spark`는 아직 token 단가가 확정·공개되지 않은 research preview입니다. 따라서 qgrid는 generic fallback 추정치를 보고하며, 이를 공식 단가로 취급하지 않습니다.

## 설정

```typescript
qgrid(modelId, {
  serverUrl?: string;      // qgrid 서버 주소 (기본: QGRID_URL 환경변수 또는 http://localhost:44900)
  defaultEffort?: string;  // effort 기본값 (기본: "low")
  projectName?: string;    // request_logs.project_name (기본: QGRID_PROJECT_NAME 환경변수)
});
```

여러 프로젝트/워크플로우가 한 qgrid 서버를 공유한다면 `QGRID_PROJECT_NAME`을 설정하세요. 대시보드에서 request log를 프로젝트별로 필터링하고 토큰/비용/캐시 지표를 워크로드별로 비교할 수 있습니다. config `projectName`은 특정 호출자만 다른 이름을 써야 할 때의 override 용도입니다.

## 환경변수

| 변수 | 설명 | 기본값 |
|---|---|---|
| `QGRID_URL` | qgrid 서버 주소 | `http://localhost:44900` |
| `QGRID_PROJECT_NAME` | request log 프로젝트 이름 (provider/logger 공통) | (없음) |

## 주의사항

- `temperature`, `maxOutputTokens` 등 sampling 파라미터는 OpenAI private Codex 경로와 Anthropic Claude Code 경로가 qgrid를 통해 받지 않으므로 무시됩니다.
- Structured output은 top-level `object` schema만 서버에서 강제됩니다. top-level `array`는 클라이언트 파싱 fallback.
- `tools`와 `Output.object`를 함께 사용하려면 qgrid server와 AI SDK가 모두 2.5.4 이상이어야 합니다.
- AI SDK/Zod가 Draft-7 `items: [...]`로 만드는 위치 기반 tuple은 지원되는
  positive schema 위치에서 OpenAI 호출 전에 정규화되고 위치별 제약이
  강제됩니다. tuple tail이 생략되면 고정 길이로 해석하며,
  `additionalItems: true`로 명시한 무제한 tail은 HTTP 400으로 거부합니다.
  negative, conditional 등 안전하게 정규화할 수 없는 위치의 tuple도 의미가
  바뀌는 변환 대신 HTTP 400으로 거부합니다. definition은 전역 정규화되므로
  해당 위치에서 참조하는 경우도 같은 이유로 거부합니다. Anthropic 위치 기반
  tuple schema는 Claude Code가 위치 의미를 보존할 수 없어 HTTP 400으로
  거부됩니다. tuple node는 `type: "array"`를 명시해야 하며 nullable tuple은
  array/null `anyOf`로 표현합니다.
- structured schema에서는 문서 root 또는 `$defs`/`definitions` entry root만
  연속으로 가리키는 로컬 root-relative JSON Pointer `$ref`를 허용합니다.
  property, tuple 내부, conditional, literal 값을 가리키는 ref는 정규화 중
  target이 이동하거나 다시 작성될 수 있어 HTTP 400으로 거부합니다. resource
  ID, anchor, 외부 ref, dynamic ref, recursive ref도 허용하지 않습니다.
- output/tool schema serialization, tool 이름, 설명, JSON escaping,
  composition framing은 합산 UTF-8 512 KiB 전처리 한도를 공유합니다.
  schema 값에는 별도로 합산 20,000 node와 schema별 최대 깊이 128 한도가
  적용됩니다. 잘못되거나 한도를 넘는 입력은 provider 실행 전에 HTTP 400으로
  실패합니다.
- Anthropic 경로에서는 최종 합성 schema가 Claude Code 전송의 안전한 단일 argv
  한도인 64 KiB도 넘지 않아야 합니다.
- AI SDK의 `toolChoice`는 현재 qgrid에서 지원하지 않습니다.

## 요구사항

- Node.js >= 20
- AI SDK v6 (`ai@^6.0.0`)
- 실행 중인 qgrid 서버
