# SON-532 구현 검토 요청 (Codex)

## 무엇을 검토하나

브랜치 `feat/son-532-schema-prompt-mode` (main 대비 9커밋). anthropic 경로에서
CC `--json-schema`(AJV 사후 채점 + 내부 재시도 루프)를 **제거**하고, 스키마/tool envelope
계약을 **system prompt 말미의 텍스트로 안내**하는 고정 픽스. 검증은 소비자 zod(스키마) /
`parseEnvelope`(envelope)가 맡는다. Linear SON-532.

계획서(로컬): `docs/plans/2026-08-12-001-feat-anthropic-schema-prompt-mode-plan.md`
— 단, **구현 중 사용자 결정으로 스코프가 바뀌었다**: 계획의 opt-in 모드(schemaDelivery
필드·서버 설정·Settings UI·관측 컬럼·ai-sdk 패스스루)는 전부 제거, 항상 프롬프트 전달로
고정. 계획서 상단 주석 참조.

## 커밋 구성 (기능 단위)

| 커밋 | 내용 |
|---|---|
| ec2c872 | U1 — anthropic 진입에서 strict 합성·argv 64KiB 제한 제거, 원형 구문·복잡도만 검증 (`buildAndValidateStrictOutputSchema` provider 분기) |
| 949f86d | U2 — `schema-prompt.ts` 렌더러 (`{"result":...}` 래퍼 명시, user 스키마 원형·strictify 미적용, $defs rebase 없음) |
| ea5cc58 | U3 — dispatcher anthropic 분기에서 `composeSystemWithSchemaContract` 로 system 말미 주입 (cold-only라 매 턴 재전송, 64KB 초과는 기존 file 분기 흡수) |
| 110148f | U4 — `fence-strip.ts` (기존 stripCodeFence 추출 + 스트림 델타 transform, 계약 기반 tail 홀드백, 전수 절단 불변식 테스트) |
| 0b4074c | U5 — parseEnvelope 실패 전제·메시지 갱신 (관용 폴백 금지 유지) |
| 50b2be4 | U8 — 준수율 벤치 (`scripts/schema-delivery-bench.ts` + `src/testing/schema-bench.ts`, dry-run 기본·checkpoint·3계층 분류) |
| e212457 | U9 — CONCEPTS/solutions/skill 정본 문서 정합 |
| 7eea447, d0ed501 | 테스트 인프라 — isolate:false 공유 레지스트리 오염 방어 (아래 "발견한 기존 취약점") |

## 검증 상태

- `packages/api` 전체: **47파일 726 테스트 통과** (2회 연속). ai-sdk 110 통과. `pnpm check` 통과.
- e2e: 민상님 실물 요청(request log 1090711/1091748) 재현 — 아래 결과 참조.

## e2e 설계 (사후검토 자료: 이 디렉터리)

- 입력 원본: dev0 request log **1090711**(구 `--json-schema`, 509s/$1.12/왕복3) 과
  **1091748**(민상님 수동 프롬프트 주입, 58s/$0.11/왕복1). 모델 anthropic/claude-sonnet-5, effort low.
- 스키마 실물: 1091748 system 에 민상님이 주입한 fenced JSON Schema(7.4KB)를 추출
  (`schema.json`). 두 실물 응답 모두 이 스키마의 required 를 충족함을 확인 — 프록시 타당.
- 케이스:
  - **v1-1090711**: 1090711 의 system+prompt 그대로 + `jsonSchema` 필드 → 새 경로가 자동 주입
  - **v2-1091748**: 1091748 의 system 에서 민상님 수동 주입분을 제거한 base + `jsonSchema` → 서버 주입이 수동 주입을 대체
  - 각각 generate / stream (총 4콜, 로컬 서버 = 이 브랜치 코드 + dev0 토큰 풀)
- 판정: JSON.parse / required 8종 누락 / 펜스 잔존 / 첫·끝 글자 / (stream) 델타연결==done.text
- 파일: `records.jsonl`(케이스별 상세), `*.response.json`(응답 원문), `*.deltas.txt`,
  `summary.json`, `minsangk-injection-wording.txt`(민상님 실물 주입문 — U2 렌더 문구의 참고)

### e2e 결과 — **정정: 스키마 검증 2/4** (2026-08-12 13:19~13:25 KST, 1차 측정)

> **정정 (2차 검토 #3):** 아래 표의 "심층 스키마 검증 4/4 통과"는 **오보였다.** 당시
> 검증기가 anyOf/oneOf 브랜치 내부를 검증하지 않아 v1 두 응답의 enum 위반
> (`expression: "기대"` — oneOf 브랜치 안 허용 목록 밖, 각 3회)을 놓쳤다. Ajv Draft
> 2020-12 재검증 결과: **v1 generate/stream INVALID(각 9 errors), v2 generate/stream
> VALID — 2/4.** 성능 관측(509s→~100s, 토큰/비용 감소)은 유효하지만 스키마 준수
> 비열등성은 이 표본으로 입증되지 않았다. 판정기를 Ajv 로 교체 후 재측정 결과가
> 아래 "재측정" 절에 있다.

| 케이스 | syntax | ~~구 검증기~~ | **Ajv 재검증** | 펜스 잔존 | wall | in/out tok | cost |
|---|---|---|---|---|---:|---|---:|
| v1-1090711-generate | ok | ~~통과~~ | **INVALID (9)** | 없음 | 104s | 18,500 / 12,521 | $0.299 |
| v1-1090711-stream | ok | ~~통과~~ | **INVALID (9)** | 없음 | 97s | 18,500 / 11,468 | $0.178 |
| v2-1091748-generate | ok | ~~통과~~ | VALID | 없음 | 80s | 18,980 / 9,771 | $0.260 |
| v2-1091748-stream | ok | ~~통과~~ | VALID | 없음 | 73s | 18,980 / 8,376 | $0.240 |

v1/v2 차이 해석: v1 은 1090711 의 원본 system(스키마 어휘 안내 없음), v2 는 민상님이
어휘·규칙 안내를 넣은 system 이다. enum 위반이 v1 에서만 났다는 것은 프롬프트 전달의
준수율이 **주변 프롬프트 품질에 민감**하다는 신호다 — U8 대표본이 측정할 축.

### 재측정 (판정기 Ajv 교체 후 fresh 4콜, 2026-08-12 15:51~15:55 KST)

| 케이스 | Ajv 판정 | 위반 | wall | out tok | cost |
|---|---|---|---:|---:|---:|
| v1-generate | **INVALID** | 3 errors (expression enum) | 20s | 1,554 | $0.134 |
| v1-stream | **INVALID** | 6 errors (expression enum ×2) | 88s | 9,909 | $0.154 |
| v2-generate | VALID | — | 75s | 8,196 | $0.237 |
| v2-stream | VALID | — | 66s | 7,453 | $0.226 |

**2/4 — 1차 측정과 동일 패턴이 재현됐다 (v1 표본 누적 4/4 invalid, v2 표본 누적 4/4
valid).** 위반은 매번 같은 지점: dialogue oneOf 브랜치의 `expression` 이 허용 enum
`["기쁨","분노","불안","슬픔","애정"]` 밖의 자연스러운 값("기대")으로 채워진다.

읽는 법 — 이 위반은 프롬프트 전달이 **만든** 병리가 아니라, structured 모드가 **숨겨서
비싸게 고치던** 병리다: 1090711 실물(같은 v1 입력, structured)은 CC AJV 가 같은 위반을
잡아 내부 재시도 3왕복을 돌린 것이 509s/$1.12 의 정체다. 프롬프트 전달에선 같은 실패가
빠르고(20~88s) 싸게($0.13~0.15) 소비자 검증에 정직하게 드러난다 — 소비자가 1회 재시도해도
structured 1회보다 싸고, 근본 해법은 v2 가 증명하듯 프롬프트의 어휘 안내다.

**결론(정직한 버전): 성능 개선은 입증, 무조건적 스키마 준수 비열등성은 미입증.**
준수율은 프롬프트 품질에 민감하며, deti 처럼 어휘 안내가 있는 실사용(v2 형태)에서는
표본 내 위반 0. 조건부 비열등성(안내 있는 프롬프트)의 대표본 확인이 U8 벤치의 몫이다.
재측정 산출물: `remeasure/` (records.jsonl, 응답 원문, 러너).

- **스트림 불변식 실전 확인**: 두 stream 케이스 모두 델타 연결 == done.text (각 169/125개 델타).
  펜스 transform 이 실트래픽에서 무손실.
- **응답 형태**: 4건 모두 첫 글자 `{` 끝 글자 `}`, extra top-level key 0, 프로즈·펜스 0.
- **구 structured(1090711 실물: 509s, in 122,532, out 55,098, $1.117) 대비 v1**:
  wall 4.9~5.2배↓, 입력 6.6배↓, 출력(청구) 4.4~4.8배↓, 비용 3.7~6.3배↓ — CC 내부
  재시도 루프 제거 효과가 실물 입력에서 재현됨.
- **민상님 수동 주입(1091748: 58s, out 6,782, $0.110) 대비 v2**: 같은 자릿수(73~80s,
  out 8.4~9.8K) — 서버 자동 주입이 수동 주입을 등가 대체. (콘텐츠 생성량 변동에 따른
  자연 편차 범위)
- 스폰 인자 실측: `--json-schema`·`--allowed-tools StructuredOutput` 부재, `--tools ""` 유지,
  system 말미에 계약 주입 확인 (ps 로 실행 중 프로세스 검증).
- request log: 로컬 서버가 dev0 DB 를 공유하므로 project `son532-e2e` 4건이 대시보드에서
  조회 가능 (single-turn, num_turns 왕복 없음).

## 검토 관점 요청

1. U1 분기(`qgrid.dispatcher.ts:buildAndValidateStrictOutputSchema`)가 openai 경로를 완전
   무손상으로 두는가. frame 의 `rejectInvalidCallerSchemas` 와의 이중 호출 정합.
2. `fence-strip.ts` 스트림 transform 의 견고성 — 홀드백 계약("공백·개행·백틱 suffix 보류")이
   stripFences(전체)와 char-단위로 일치한다는 불변식의 구멍 여부.
3. `schema-prompt.ts` envelope 안내문이 `parseEnvelope`(tool-emulation.ts) zod 계약과 어긋날
   여지 (교차 테스트가 tool-emulation.test.ts 에 있음).
4. 하드 픽스의 잔여물: `claude-session.ts` 의 structured 분기(`--json-schema`·retry env)와
   strictify 의 anthropic 특수 처리들이 dispatch 에서 도달 불가 코드로 남아 있다 — 제거
   vs 존치 판단.
5. 비-SDK 소비자 계약 변경(검증된 JSON → JSON 텍스트)이 놓친 표면이 있는지 (예: web
   대시보드의 응답 표시, deti 외 소비자).
6. 테스트 인프라 — `vi.resetModules()` in `vi.hoisted` 방어(d0ed501)의 부작용 여부.

## 1차 구현 검토(2026-08-12) 반영 기록

Codex 검토 8건 전부 반영 — 커밋 `b75dcc2`:

| # | 반영 |
|---|---|
| 1 | tool args 예시를 inputSchema required 로 합성(`exampleValueForSchema`), json answer 변형은 비 JSON 자리표시자 대신 프로즈 서술. 테스트로 고정 |
| 5 | 벤치 wire shape `{args:...}` 래핑 (e2e 러너와 동일) |
| 3 | `validateAgainstSchema` 전체 트리 재귀 검증 (anyOf/oneOf/const/enum/minItems/minLength 등 fixture 실사용 keyword 전부) — 속 빈 응답 거부 테스트 포함 |
| 6 | tool-calls 에서 멈추지 않음: 인자 inputSchema 검증 → 결정적 tool 결과로 연속턴(최대 3) → 최종 answer 분류 |
| 2 | fixture 내용 지문(`fingerprintFixture`)이 checkpoint 키·집계 필터에 포함 |
| 7 | done 없는 SSE 종료 = 전송 실패(premature EOF)로 분류 |
| 8 | 잘린 JSONL tail 을 append 전 개행 봉인(`repairCheckpointTail`) |
| 4 | README(2곳)·provider-runtime-differences·ai-sdk-provider-contract·solutions 2편(loose-schema-fallback SUPERSEDED, fresh-spawn migration 표) 갱신 + sync. 벤치 요청 마감 `BENCH_TIMEOUT_MS`(기본 15분) 추가 |
| lock | `packages/api/sonamu.lock` 체크섬 커밋 포함 |

반영 후 검증: api 47파일 **736** 테스트 중 735 통과, ai-sdk 110, `pnpm check` 통과, 벤치
dry-run 정상. 실패 1건(`openai-dispatcher.test.ts` autoscaling kill 횟수)은 **main 에서도
동일 재현되는 기존 플레이크** — 이 브랜치 무관 (별도 이슈 후보).

추가 커밋: `d3c2169`(envelope 실패 진단에 위반 원문 head 첨부 + 벤치 델타 검사 오탐 수정),
`16ee8d3`(벤치 연속턴에 AI SDK 계약대로 history 동봉), `721f4e7`(평문 answer 분류).

### tools e2e (R4 증명 공백 해소) — 12/12 통과

수정된 벤치로 tools-only / tools-with-schema × generate/stream × N=3 을 live 발사
(sonnet-5, 로컬 서버 = 이 브랜치). tool args inputSchema 검증 → 결정적 tool 결과로
연속턴 → 최종 answer 분류까지 전체 계약을 왕복했다. 결과: `tools-e2e.jsonl`.

| fixture | mode | N | pass | avgMs | outTok(2턴 합) |
|---|---|---:|---:|---:|---:|
| tools-only | generate | 3 | 3 | 10,763 | 996 |
| tools-only | stream | 3 | 3 | 9,800 | 958 |
| tools-with-schema | generate | 3 | 3 | 7,858 | 434 |
| tools-with-schema | stream | 3 | 3 | 8,169 | 432 |

최종 answer 가 벤치의 결정적 tool 결과 내용("1976년 단체 사진 사건" 등)을 정확히
반영 — tool 결과가 실제로 모델에 도달했다는 내용적 증거.

**과정에서 얻은 준수율 데이터 1건**: history 미동봉 상태의 초기 시도에서 sonnet-5 가
answer 변형의 `toolCalls` 키를 생략(`{"result":{"action":"answer","answer":...}}`)해
parseEnvelope 가 정직 거절한 사례 1/3 — U8 대표본 벤치가 측정할 위반 유형의 실물.
또한 **연속턴은 반드시 전체 history 를 동봉해야 한다**는 계약을 실측으로 확인
(history 없이 toolResults 만 보내면 모델이 맥락 없는 tool 결과만 받아 envelope 를
잊는다 — AI SDK 는 항상 동봉하므로 SDK 소비자는 해당 없음, raw API 소비자 문서화 필요).

## 발견한 기존 취약점 (별도 이슈 후보)

vitest `isolate:false`(sonamu 기본) 아래에서 vi.mock 파일은 같은 fork 의 앞선 파일이 실모듈을
캐시하면 조용히 무력화된다. main 도 `--no-file-parallelism` 이면 50건 실패 — 스위트가 파일
배치 운에 의존해 왔다. 이번엔 `qgrid.frame.test.ts` 에 국소 방어를 넣었지만, 같은 패턴의
파일(mock 다수)이 추가될 때마다 재발 가능.
