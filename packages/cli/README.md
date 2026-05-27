# @cartanova/qgrid-cli

Qgrid 서버를 한 줄로 실행. OpenAI/Anthropic 구독 크레딧을 HTTP API + 대시보드로 제공하는 LLM 프록시.

## 설치

```bash
npm i -g @cartanova/qgrid-cli
```

## 사용법

```bash
# DB URL로 실행
qgrid --db postgres://user:password@host:port/dbname

# 포트 지정
qgrid --db postgres://... -p 3000

# 환경변수로 DB 설정 (플래그 생략 가능)
export QGRID_DB_HOST=dev.example.com
export QGRID_DB_PORT=5432
export QGRID_DB_USER=postgres
export QGRID_DB_PASSWORD=postgres
export QGRID_DB_NAME=qgrid
qgrid
```

서버가 뜨면 `http://localhost:44900`에서 대시보드 접속 → OAuth 로그인으로 토큰 등록.

Ctrl+C로 종료.

## 옵션

```
qgrid [options]

  --db <url>         PostgreSQL 연결 URL
  -p, --port <port>  서버 포트 (기본: 44900)
  -V, --version      버전 출력
  -h, --help         도움말
```

## 환경변수

`--db` 플래그가 없으면 아래 환경변수에서 DB 접속 정보를 읽음:

| 변수 | 기본값 |
|------|--------|
| `QGRID_DB_HOST` | `localhost` |
| `QGRID_DB_PORT` | `5432` |
| `QGRID_DB_USER` | `postgres` |
| `QGRID_DB_PASSWORD` | `postgres` |
| `QGRID_DB_NAME` | `qgrid` |
| `QGRID_WORKERS_PER_TOKEN` | `3` (OpenAI 토큰당 codex worker 수, 최대 5) |

## 사전 요구사항

- Node.js >= 20
- PostgreSQL
- [Codex CLI](https://github.com/openai/codex) (OpenAI 모델 사용 시)

## 동작 방식

CLI는 Sonamu 기반 서버를 내장 번들로 포함. 실행 시:

1. DB 연결 확인
2. 서버 시작 (API + 대시보드 웹 UI)
3. DB의 등록된 토큰 로드
4. **OpenAI 토큰**: 토큰당 codex app-server 프로세스 N개 spawn (기본 3). JSON-RPC로 통신. 병렬 요청 처리 + 큐잉.
5. **Anthropic 토큰**: claude CLI를 통한 호출. OAuth 토큰 자동 refresh.
6. 요청 도착 → idle worker에 라우팅 (round-robin) → 전부 busy면 큐 대기 (최대 60초)

Docker 불필요. Node.js + PostgreSQL + Codex CLI만 있으면 됨.

## SDK 연동

서버를 띄운 뒤 [`@cartanova/qgrid-ai-sdk`](../ai-sdk/README.md)로 호출:

```typescript
import { generateText } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: "서울 날씨 알려줘",
});
```

자세한 사용법은 [`@cartanova/qgrid-ai-sdk` README](../ai-sdk/README.md) 참조.
