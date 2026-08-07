/**
 * legacy request_logs 의 비용을 확정값으로 백필한다.
 *
 * 배경: `cost_source` 가 없는 row 는 조회할 때마다 앱이 현재 가격표로 재계산해 왔다
 * (`normalizeLegacyAnthropicRow`). 입력이 고정이라 결과도 항상 같은데, 96만 행 테이블에서
 * 23.6만 행을 매 요청 앱으로 끌어오는 비용만 남는다. 한 번 계산해 저장하면 총비용 집계가
 * 단일 SQL SUM 으로 끝난다.
 *
 * 계산식은 앱의 `normalizedUsageForCost` + `calculateCostUsd` 를 그대로 옮긴 것이다.
 * 두 로직이 갈라지면 백필된 값과 신규 저장값의 기준이 달라지므로, 가격표를 바꿀 때는
 * 이 마이그레이션이 아니라 앱 코드만 바꾸면 된다(이미 확정된 값은 유지되는 것이 계약).
 *
 * 되돌리기: down 은 `cost_source='backfilled'` 인 row 의 표식만 제거해 재계산 대상으로
 * 되돌린다. 원본 `cost_usd` 는 복원되지 않는다 — 되돌릴 수 없는 쓰기다. 덮이는 값은
 * NULL 이었거나, 음수였거나, 구버전 가격표로 계산된 값이고, 조회 경로는 이들을 그대로
 * 보여준 적이 없다(항상 현재 가격표로 재계산해 표시). 그래서 화면에 보이던 총액은
 * 백필 전후로 동일하며, 실질 손실은 없다.
 */
import { type Knex } from "knex";

// 마이그레이션 러너는 tsconfig 의 bundler 해석을 쓰지 않는 순수 ESM 로더라 확장자가 필요하다.
import { calculateCostUsd } from "../utils/providers/common/model-cost.js";

const MICRO_USD = 1_000_000;
const CHUNK_SIZE = 5_000;

type LegacyRow = {
  id: number;
  token_name: string | null;
  model_name: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_creation_5m_tokens: number | null;
  cache_creation_1h_tokens: number | null;
  cost_usd: number | null;
};

function isAnthropicRow(row: LegacyRow): boolean {
  return (
    row.token_name?.startsWith("anthropic/") === true ||
    row.model_name?.startsWith("claude-") === true ||
    row.model_name?.startsWith("anthropic/claude-") === true
  );
}

function backfilledCostMicroUsd(row: LegacyRow): number {
  if (!row.model_name) return Math.max(row.cost_usd ?? 0, 0);

  // Anthropic 은 input/cache_read/cache_creation 을 상호 배타적으로 보고한다. 과거 저장 경로가
  // 이를 합치지 않아 input_tokens 가 작게 남은 row 를 복원한다.
  const splitInput =
    isAnthropicRow(row) && row.input_tokens < row.cache_read_tokens + row.cache_creation_tokens;
  const inputTokens = splitInput
    ? row.input_tokens + row.cache_read_tokens + row.cache_creation_tokens
    : row.input_tokens;

  const model = row.model_name.includes("/") ? row.model_name.split("/").pop()! : row.model_name;
  const usd = calculateCostUsd(model, {
    inputTokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cache_read_tokens,
    cacheCreationInputTokens: row.cache_creation_tokens,
    ...(row.cache_creation_5m_tokens !== null
      ? { cacheCreationInputTokens5m: row.cache_creation_5m_tokens }
      : {}),
    ...(row.cache_creation_1h_tokens !== null
      ? { cacheCreationInputTokens1h: row.cache_creation_1h_tokens }
      : {}),
  });
  return Math.max(Math.round(usd * MICRO_USD), 0);
}

export async function up(knex: Knex): Promise<void> {
  let lastId = 0;
  let processed = 0;

  for (;;) {
    const { rows } = await knex.raw<{ rows: LegacyRow[] }>(
      `SELECT id, token_name, model_name, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens,
              cache_creation_5m_tokens, cache_creation_1h_tokens, cost_usd
         FROM request_logs
        WHERE (cost_source IS NULL OR cost_usd IS NULL) AND id > ?
        ORDER BY id
        LIMIT ?`,
      [lastId, CHUNK_SIZE],
    );
    if (rows.length === 0) break;

    // chunk 당 한 번의 UPDATE ... FROM (VALUES ...) 로 왕복을 줄인다.
    const values = rows.map((row) => `(${row.id}, ${backfilledCostMicroUsd(row)})`).join(",");
    await knex.raw(
      `UPDATE request_logs AS t
          SET cost_usd = v.cost_usd, cost_source = 'backfilled'
         FROM (VALUES ${values}) AS v(id, cost_usd)
        WHERE t.id = v.id`,
    );

    lastId = rows[rows.length - 1]!.id;
    processed += rows.length;
  }

  console.log(`[backfill] request_logs cost backfilled: ${processed} rows`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`UPDATE request_logs SET cost_source = NULL WHERE cost_source = 'backfilled'`);
}
