# Qgrid

**LLM 구독 토큰을 API처럼 사용.** OpenAI/Anthropic 구독 크레딧을 HTTP API로 노출하는 LLM 프록시 서버.

종량제 API 키 없이 **구독 정액제**로 GPT-5.5, Claude Opus 등을 호출. N개 계정의 쿼터를 풀링하여 병렬 분산.

---

## 다른 구독 프록시와 다른점

기존 구독 토큰 프록시(claude-proxy 등)는 CLI를 한 번 호출하고 텍스트를 반환하는 **single-turn 텍스트 프록시**입니다. 구독 토큰은 공식 API가 아니라 CLI/앱을 통해서만 사용 가능하고, CLI는 tool-call이나 structured output 같은 API 기능을 지원하지 않기 때문입니다.

> **참고:** `claude -p`에서 structured output emulation으로 tool-call 형태를 흉내낼 수는 있지만, `claude -p`는 매 호출이 독립된 single-turn이라 **multi-turn을 지원하지 않습니다.** tool-call → tool 실행 → 결과를 다음 턴에 전달하는 agent loop가 근본적으로 불가능합니다. 또한 Anthropic은 2026-06-18부로 `claude -p`의 서드파티 사용을 제한할 예정입니다.

Qgrid는 이 문제를 **codex app-server를 백엔드로 사용**하여 해결합니다. codex app-server는 OpenAI의 Responses API를 구독 토큰으로 사용할 수 있는 JSON-RPC 서버이고, Qgrid가 이 위에 AI SDK `LanguageModelV3` custom provider를 구현했습니다. 덕분에:

- **Tool Calling** — AI SDK의 `tools` 옵션이 그대로 동작. 서버가 structured output emulation으로 tool-call 형태를 만들고, AI SDK가 tool 실행을 관리.
- **Multi-step Agent Loop** — `stopWhen`, `maxSteps`로 tool-call → tool 실행 → 다음 턴을 자동 반복. 구독 토큰으로 agent를 만들 수 있음.
- **Structured Output** — `Output.object({ schema })` 로 JSON schema 강제. 파싱 실패 없음.
- **Streaming** — [Sonamu Framework](https://github.com/cartanova-ai/sonamu)의 SSE 기반 실시간 텍스트 스트리밍.

---

## 왜 Qgrid?

- **API 키 비용 0원** — 이미 결제 중인 OpenAI/Anthropic 구독 토큰을 그대로 활용. 별도 종량제 API 키 불필요.
- **Tool Calling + Agent Loop** — 구독 토큰으로 tool-call, multi-step agent loop 가능. 단순 텍스트 프록시가 아님.
- **AI SDK 호환** — 기존 코드에서 `model` 한 줄만 교체. `generateText`, `streamText`, structured output, tool-call 전부 동작.
  ```ts
  model: qgrid("openai/gpt-5.4-mini")  // 이것만 바꾸면 됨
  ```
- **N개 구독 풀링** — 팀원 구독 계정을 모아서 병렬 처리. 토큰당 worker N개로 동시 요청 분산.
- **Request Log 대시보드** — 매 요청의 토큰 사용량, 비용, tool-call 내역, reasoning을 웹 UI에서 실시간 확인.
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

- **OpenAI** — codex app-server 프로세스를 토큰당 N개 spawn. JSON-RPC로 통신. 병렬 요청 처리 + 요청 큐잉.
- **Anthropic** — claude CLI를 통한 호출. OAuth 토큰 자동 refresh.
- **Request Log** — 매 요청의 generate step, tool-call step, reasoning, 토큰 사용량, 비용을 DB에 기록. 대시보드에서 확인.

---

## SDK 사용법

자세한 사용법은 [`@cartanova/qgrid-ai-sdk` README](./packages/ai-sdk/README.md)를 참조하세요.

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

---

## CLI

```bash
npm i -g @cartanova/qgrid-cli

qgrid --db postgres://user:password@host:port/dbname
qgrid --db postgres://... -p 3000  # 포트 지정
```

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
```

대시보드에서 전체 팀의 request log를 프로젝트별로 필터링하여 확인할 수 있습니다.

---

## 지원 모델

| Provider | 모델 |
|---|---|
| OpenAI | `openai/gpt-5.5`, `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-5.2`, `openai/gpt-5.3-codex` |
| Anthropic | `anthropic/claude-sonnet-4-7`, `anthropic/claude-opus-4-7`, `anthropic/claude-haiku-4-5` 등 |

---

## 환경변수

| 변수 | 설명 | 기본값 |
|---|---|---|
| `QGRID_URL` | qgrid 서버 주소 (SDK) | `http://localhost:44900` |
| `QGRID_DB_HOST` | PostgreSQL 호스트 | `localhost` |
| `QGRID_DB_PORT` | PostgreSQL 포트 | `5432` |
| `QGRID_DB_NAME` | 데이터베이스 이름 | `qgrid` |
| `QGRID_WORKERS_PER_TOKEN` | OpenAI 토큰당 worker 수 | `3` (최대 5) |

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
- **Anthropic 모델**: claude CLI 기반. OAuth 로그인 필요.
- **쿼터 관리**: 구독 rate limit (5시간/7일 rolling window) 적용. 소진된 토큰은 대시보드에서 비활성화.
