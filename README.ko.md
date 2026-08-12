# Qgrid

[English](./README.md) · **한국어**

**LLM 구독 토큰을 API처럼 사용.** OpenAI/Anthropic 구독 크레딧을 HTTP API로 노출하는 LLM 프록시 서버.

종량제 API 키 없이 **구독 정액제**로 GPT-5.5, Claude Opus 등을 호출. N개 계정의 쿼터를 풀링하여 병렬 분산.

---

## 다른 구독 프록시와 다른점

기존 구독 토큰 프록시(claude-proxy 등)는 CLI를 한 번 호출하고 텍스트를 반환하는 **single-turn 텍스트 프록시**입니다. 구독 토큰은 공식 API가 아니라 CLI/앱을 통해서만 사용 가능하고, 단순 CLI 호출로는 tool-call, structured output, multi-turn agent loop 같은 API 기능을 쓸 수 없기 때문입니다.

Qgrid는 두 구독 기반 런타임 위에 AI SDK `LanguageModelV3` custom provider를 구현하여 이 문제를 해결합니다:

- **OpenAI** — `https://chatgpt.com/backend-api/codex/responses`에 HTTPS로 직접 요청하고 SSE 응답을 해석합니다. Qgrid는 Codex CLI identity header를 보내고 매 turn 전체 대화 history를 재전송합니다. `sessionKey`에서 파생한 불투명 key로 provider thread를 보관하지 않고 prompt-cache affinity를 유지합니다.
- **Anthropic** — Claude Code `stream-json` 모드. 요청마다 격리된 프로세스를 fresh spawn하고 전체 대화 히스토리를 재주입하므로, persistent session 없이도 multi-turn이 동작합니다.

덕분에:

- **Tool Calling** — AI SDK의 `tools` 옵션이 양쪽 provider 모두에서 그대로 동작. 서버가 structured output emulation으로 tool-call 형태를 만들고, AI SDK가 tool 실행을 관리.
- **Multi-step Agent Loop** — `stopWhen`, `maxSteps`로 tool-call → tool 실행 → 다음 턴을 자동 반복. 구독 토큰으로 agent를 만들 수 있음.
- **Structured Output** — `Output.object({ schema })` 로 JSON schema 강제. OpenAI는 codex structured output으로, Anthropic은 Claude Code `--json-schema` + 후검증으로 처리하며 검증 실패 시 깨진 JSON 대신 명시적 에러 반환.
- **Prompt Caching** — `sessionKey`를 넘기면 매 요청 전체 history를 재전송하면서 안정적인 불투명 OpenAI prompt-cache affinity를 사용합니다.
- **Streaming** — [Sonamu Framework](https://github.com/cartanova-ai/sonamu)의 SSE 기반 실시간 텍스트 스트리밍.

---

## 왜 Qgrid?

- **API 키 비용 0원** — 이미 결제 중인 OpenAI/Anthropic 구독 토큰을 그대로 활용. 별도 종량제 API 키 불필요.
- **Tool Calling + Agent Loop** — 구독 토큰으로 tool-call, multi-step agent loop 가능. 단순 텍스트 프록시가 아님.
- **AI SDK 호환** — 기존 코드에서 `model` 한 줄만 교체. `generateText`, `streamText`, structured output, tool-call 전부 동작.
  ```ts
  model: qgrid("openai/gpt-5.4-mini")  // 이것만 바꾸면 됨
  ```
- **N개 구독 풀링** — 팀원 구독 계정을 모아서 병렬 처리. 토큰 단위 concurrent permit과 smooth weighted routing으로 요청을 분산. 토큰별 quota threshold로 사용률 초과 토큰은 라우팅에서 자동 제외.
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

- **OpenAI** — `https://chatgpt.com/backend-api/codex/responses`를 직접 호출합니다. 기본값인 `QGRID_OPENAI_TRANSPORT=https`는 HTTPS/SSE를 사용하고, `QGRID_OPENAI_TRANSPORT=websocket`은 같은 URL의 scheme을 `wss`로 바꿔 요청마다 Responses WebSocket 하나를 엽니다. WebSocket은 `response.create` 메시지 하나를 보내고 terminal Responses event를 받아야 합니다. Connection multiplexing과 ambiguous request replay는 하지 않습니다. Handshake가 401로 거부됐음이 확정된 경우에만 credential을 갱신하고 한 번 다시 연결합니다. 잘못된 selector 값은 dispatcher 설정 시 즉시 실패합니다.
- **Anthropic** — 요청마다 격리된 Claude Code 프로세스를 fresh spawn (`stream-json` 입출력, 토큰별 config 격리). 대화 히스토리는 매 턴 재주입. OAuth 토큰 자동 refresh.
- **Quota threshold** — 토큰별 사용률 임계값(기본 80%). 임계값을 넘은 토큰은 rolling window가 회복될 때까지 라우팅에서 제외.
- **Request Log** — 매 요청의 generate step, tool-call step, reasoning, 토큰 사용량, 캐시 지표, TTFT, 비용을 DB에 기록. 대시보드에서 확인.

> **Private backend 주의:** OpenAI 경로는 문서화된 public API가 아니라 ChatGPT의 private Codex backend를 사용합니다. URL, request field, identity header 요구사항, SSE event, quota 응답, 가용성은 예고 없이 바뀔 수 있습니다. 이 migration은 mock 기반 protocol/transport test로 검사했으며, 실제 provider 계정에 대한 live 검증을 주장하지 않습니다.

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
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ temperature: 22, condition: "맑음" }),
    }),
  },
  stopWhen: stepCountIs(3),
});
```

### Prompt Caching (sessionKey)

```typescript
// 전체 history를 재전송하고 불투명 prompt-cache affinity 유지 (OpenAI)
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

CLI는 공개 설정인 `QGRID_DB_*`를 Sonamu 내부의 `SONAMU_DB_*`로 변환합니다.
`packages/api`를 CLI 없이 직접 실행하는 소스 배포만 `SONAMU_DB_*`를 사용합니다.
dev0 같은 원격 비프로덕션 환경은 `NODE_ENV=staging`, 프로덕션은
`NODE_ENV=production`을 사용합니다. 이 프로필은 DB를 새로 만들지 않으며,
접속할 DB는 `QGRID_DB_NAME`이 명시적으로 결정합니다.

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
| OpenAI | `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, `openai/gpt-5.6-luna`, `openai/gpt-5.5`, `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-5.3-codex`, `openai/gpt-5.3-codex-spark`, `openai/gpt-5.2` |
| Anthropic | `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, `anthropic/claude-opus-4-8`, `anthropic/claude-opus-4-7`, `anthropic/claude-opus-4-6`, `anthropic/claude-opus-4-5`, `anthropic/claude-opus-4-1`, `anthropic/claude-opus-4`, `anthropic/claude-sonnet-4-7`, `anthropic/claude-sonnet-4-6`, `anthropic/claude-sonnet-4-5`, `anthropic/claude-sonnet-4`, `anthropic/claude-haiku-4-5` |

> `claude-opus-5`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-8`은 자동으로 1M 토큰 컨텍스트로 실행됩니다. Opus 5는 기본 adaptive thinking 동작을 유지하며, qgrid의 `effort` 옵션으로 추론 깊이를 조절합니다.

---

## 환경변수

| 변수 | 설명 | 기본값 |
|---|---|---|
| `QGRID_URL` | qgrid 서버 주소 (SDK) | `http://localhost:44900` |
| `QGRID_PROJECT_NAME` | request log 프로젝트 이름 (SDK/logger). 대시보드 프로젝트별 필터링에 사용 | (없음) |
| `HOST` | 서버 listen 호스트. loopback이 아닌 값은 대시보드와 관리 API를 외부에 노출 | `localhost` |
| `NODE_ENV` | Sonamu 실행 프로필: `development`, `test`, `staging`, `production`. 원격 비프로덕션 API 배포에는 `staging` 사용 | API 직접 실행 시 `development`, CLI는 `production` |
| `QGRID_DB_HOST` | PostgreSQL 호스트 (CLI) | `localhost` |
| `QGRID_DB_PORT` | PostgreSQL 포트 (CLI) | `5432` |
| `QGRID_DB_USER` | PostgreSQL 사용자 (CLI) | `postgres` |
| `QGRID_DB_PASSWORD` | PostgreSQL 비밀번호 (CLI) | `postgres` |
| `QGRID_DB_NAME` | 데이터베이스 이름 (CLI) | `qgrid` |
| `SLACK_BOT_TOKEN` | 토큰 만료 알림용 Slack bot token. 미설정 시 알림 비활성 | — |
| `SLACK_CHANNEL_ID` | 알림을 받을 Slack 채널 | — |
| `SLACK_EXPIRY_REMINDER_INTERVAL_MINUTES` | 세션 만료 알림을 다시 보내는 주기(분). 미설정·0이면 끔 | — |
| `SLACK_USER_MAP` | `토큰명:SlackUserId` 목록. 매핑된 토큰은 멘션으로 알림 | — |

> qgrid는 대시보드 API에 별도 인증을 두지 않습니다. 신뢰할 수 있는 네트워크나 reverse proxy 뒤가 아니라면 `HOST`를 loopback으로 유지하세요. 공개 바인드는 Monit 탭의 서버 로그 피드를 포함한 모든 관리 엔드포인트를 노출합니다.
>
> `packages/api`를 직접 실행할 때는 같은 값을 Sonamu 네이티브 환경변수인 `SONAMU_DB_*`로 설정합니다.

---

## 패키지 구조

```
packages/
├── ai-sdk/  ← @cartanova/qgrid-ai-sdk (AI SDK v6 provider + logger)
├── api/     ← Sonamu 서버 (QgridDispatcher, Request Log, OAuth)
├── web/     ← 대시보드 React 앱 (TanStack Router + Query)
└── cli/     ← @cartanova/qgrid-cli (서버 번들 포함)
```

---

## 사전 요구사항

- Node.js >= 20
- PostgreSQL
- Docker (로컬 PostgreSQL을 컨테이너로 실행할 경우)
- [Claude Code](https://www.anthropic.com/claude-code) (Anthropic 모델 사용 시)

---

## 주의사항

- **OpenAI 모델**: private Codex Responses backend를 직접 사용합니다. 이 경로는 `temperature`, `maxOutputTokens` 등 sampling 파라미터를 지원하지 않습니다.
- **Anthropic 모델**: Claude Code 기반. OAuth 로그인 필요. tool calling과 object structured output을 지원하지만, 요청마다 fresh process로 실행되므로 OpenAI 방식의 `sessionKey` cache affinity는 적용되지 않습니다.
- **Anthropic structured output**: codex(constrained decoding)와 달리 Claude Code의 `--json-schema`는 `StructuredOutput` 도구로 생성을 유도하고 사후 검증하므로, 복잡한 schema는 간헐적으로 검증에 실패할 수 있습니다. qgrid는 stream 지연을 제한하기 위해 structured streaming만 1회 시도로 고정하고, non-stream `generate`는 Claude Code의 기본 retry 예산을 유지합니다. 검증 실패는 깨진 JSON 대신 명시적 에러로 반환합니다.
- **위치 기반 tuple**: OpenAI는 지원되는 positive schema 위치에서 tuple의 위치별 제약을 정규화해 강제합니다. negative, conditional 등 안전하게 정규화할 수 없는 위치의 tuple은 의미가 바뀌는 변환 대신 HTTP 400으로 거부합니다. definition은 전역 정규화되므로 해당 위치에서 참조하는 경우도 같은 이유로 거부합니다. Anthropic 위치 기반 tuple schema도 Claude Code가 위치 의미를 보존할 수 없어 HTTP 400으로 거부됩니다. tuple node는 `type: "array"`를 명시하며 nullable tuple은 `anyOf`로 표현합니다.
- **Schema reference**: structured schema에서는 문서 root 또는 `$defs`/`definitions` entry root만 연속으로 가리키는 로컬 root-relative JSON Pointer `$ref`를 허용합니다. property, tuple 내부, conditional, literal 값을 가리키는 ref는 정규화 중 target이 이동하거나 다시 작성될 수 있어 HTTP 400으로 거부합니다. resource ID, anchor, 외부 ref, dynamic ref, recursive ref도 허용하지 않습니다.
- **Schema budget**: output/tool schema serialization, tool 이름, 설명, JSON escaping, composition framing은 합산 UTF-8 512 KiB 한도를 공유합니다.
- **쿼터 관리**: 구독 rate limit (5시간/7일 rolling window) 적용. 토큰별 quota threshold(기본 80%) 초과 시 라우팅에서 자동 제외되며, 대시보드에서 수동 비활성화도 가능합니다.
