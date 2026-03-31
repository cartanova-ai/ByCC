# ByCC (By Claude Code)

Claude 구독 크레딧(Max/Team)을 HTTP API로 사용할 수 있게 해주는 서비스.

Anthropic API 키(토큰 과금) 대신 **구독 정액제 크레딧**으로 LLM을 호출합니다.

---

## 어떻게 동작하는가

```
팀원 프로젝트 (Node.js / Python / 뭐든)
  → POST http://bycc:44900/api/bycc/query
  ← { text, usage, durationMs, costUsd }

ByCC 서버 (Docker 컨테이너)
  └── ClaudePool (멀티 토큰 프로세스 풀)
        ├── Worker A-0 (token=계정A) → claude CLI 프로세스
        ├── Worker A-1 (token=계정A) → claude CLI 프로세스
        ├── Worker B-0 (token=계정B) → claude CLI 프로세스
        └── Worker B-1 (token=계정B) → claude CLI 프로세스
```

- HTTP 요청 하나로 LLM 호출 (언어 무관)
- N개 계정 토큰을 등록하면 쿼터를 풀링
- 한 토큰이 쿼터 소진되면 자동으로 다른 토큰으로 failover (호출자는 모름)

---

## 시작하기

### 1. 클론 + 설치

```bash
git clone git@github.com:CartaNova-AI/ByCC.git
cd ByCC
pnpm install
```

### 2. 토큰 발급

각 팀원이 자기 Claude Max/Team 계정에서 long-lived 토큰을 발급:

```bash
claude setup-token
```

### 3. 서버 시작

```bash
# Docker (권장)
docker compose up -d

# 개발 모드
pnpm -C packages/api sonamu dev
```

### 4. 토큰 등록

브라우저에서 `http://localhost:44900` 접속 → Tokens 페이지에서 추가.

또는 API로:

```bash
curl -X POST http://localhost:44900/api/bycc/addToken \
  -H 'Content-Type: application/json' \
  -d '{"token": "sk-ant-oat01-..."}'
```

### 5. 사용

```bash
curl -X POST http://localhost:44900/api/bycc/query \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "What is 1+1?", "system": "Reply in one word."}'
```

---

## 다른 프로젝트에서 사용

### TypeScript SDK

`packages/api/src/sdk/bycc.ts`를 프로젝트에 복사:

```typescript
import { generateByCC } from "./bycc";

// 텍스트 응답
const { text } = await generateByCC({
  prompt: "Hello",
  system: "Reply briefly.",
});

// 구조화 응답 (Zod 스키마 → JSON Schema 자동 포함 + 파싱/검증)
const { json } = await generateByCC({
  prompt: "질문 5개 생성해줘",
  system: "질문 생성 전문가입니다.",
  returnType: z.object({ questions: z.array(z.string()) }),
});
json.questions // string[]
```

의존성: `zod`

환경변수: `BYCC_URL` (기본: `http://localhost:44900`)

### 배포 환경

앱의 docker-compose에 bycc 서비스를 추가:

```yaml
services:
  api:
    environment:
      BYCC_URL: http://bycc:44900

  bycc:
    build: ./ByCC
    volumes:
      - ~/.bycc:/root/.bycc:ro
```

---

### PostgreSQL에 대해

docker-compose에 PostgreSQL이 포함되어 있지만, **ByCC는 데이터베이스를 사용하지 않습니다.** 토큰은 JSON 파일로 관리하고, 사용량은 인메모리 카운터입니다. PostgreSQL은 Sonamu 프레임워크가 시작 시 DB 연결을 필수로 요구하기 때문에 빈 DB를 띄워놓는 것뿐입니다. ByCC가 DB에 쿼리를 보내거나 데이터를 저장하지 않습니다.
