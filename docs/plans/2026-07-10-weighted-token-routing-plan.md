# Weighted token routing implementation plan

> **Status (direct OpenAI migration complete):** This plan records the earlier worker/thread implementation and is not the current OpenAI runtime specification. The completed runtime keeps smooth weighted token routing and the 50-item/60-second queue, but uses token-level concurrent permits, direct HTTPS/SSE, full-history replay, and opaque prompt-cache affinity. See `packages/cli/skills/qgrid/references/openai-codex-runtime.md` for current behavior.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route new OpenAI and Anthropic requests across eligible tokens with per-token smooth weighted round-robin while preserving quota gates, OpenAI thread affinity, and work-conserving queue behavior.

**Architecture:** A provider-independent selector owns integer weights and smooth weighted round-robin scores keyed by token ID. Each provider dispatcher keeps responsibility for quota, lifecycle, worker availability, and execution, then gives the selector only the eligible token IDs for the current assignment. Token weight is stored with the existing token record and propagated through Sonamu-generated contracts and PostgreSQL token notifications.

**Tech stack:** TypeScript 6, Vitest 4, Sonamu 0.9, Knex/PostgreSQL, React 19, TanStack Query.

**Origin:** `docs/brainstorms/2026-07-10-weighted-token-routing-requirements.md`

## Global constraints

- `weight` is an integer from 1 through 100 and defaults to 1.
- Weight applies to OpenAI cold requests and all Anthropic requests.
- OpenAI thread reuse remains pinned to its existing worker and does not read or mutate weighted-selector state.
- The existing quota threshold gate runs before weighted selection; quota lookup failures remain fail-open.
- OpenAI skips tokens with no idle worker and immediately uses another eligible idle token.
- Queue drain must use weighted selection and must not prefer the worker that happened to finish first.
- No task may connect to, modify, or migrate dev0 or another remote database.
- A migration may be applied only to a disposable local PostgreSQL container after confirming its hostname is local.
- Do not add per-model, per-project, per-request, adaptive, latency-based, cost-based, or worker-count-based weights.

---

### Task 1: Add the shared smooth weighted round-robin selector

**Files:**

- Create: `packages/api/src/utils/providers/common/smooth-weighted-round-robin.ts`
- Create: `packages/api/src/utils/providers/common/smooth-weighted-round-robin.test.ts`

**Interfaces:**

- Produces: `SmoothWeightedRoundRobin.setToken(tokenId: number, weight: number): void`
- Produces: `SmoothWeightedRoundRobin.removeToken(tokenId: number): void`
- Produces: `SmoothWeightedRoundRobin.resetScores(): void`
- Produces: `SmoothWeightedRoundRobin.select(eligibleTokenIds: ReadonlySet<number>): number | null`
- Invariant: `setToken` and `removeToken` reset all scores only when configuration actually changes.

- [ ] **Step 1: Write selector tests**

Create `smooth-weighted-round-robin.test.ts` with explicit sequences and lifecycle cases:

```ts
import { describe, expect, it } from "vitest";

import { SmoothWeightedRoundRobin } from "./smooth-weighted-round-robin";

function pickMany(selector: SmoothWeightedRoundRobin, ids: number[], count: number): number[] {
  const eligible = new Set(ids);
  return Array.from({ length: count }, () => selector.select(eligible)!);
}

describe("SmoothWeightedRoundRobin", () => {
  it("uses token-id order as the deterministic tie break for equal weights", () => {
    const selector = new SmoothWeightedRoundRobin();
    selector.setToken(2, 1);
    selector.setToken(1, 1);

    expect(pickMany(selector, [1, 2], 4)).toEqual([1, 2, 1, 2]);
  });

  it("produces a smooth 3:1 distribution", () => {
    const selector = new SmoothWeightedRoundRobin();
    selector.setToken(1, 3);
    selector.setToken(2, 1);

    expect(pickMany(selector, [1, 2], 4)).toEqual([1, 1, 2, 1]);
  });

  it("produces a complete 5:2:1 weighted cycle", () => {
    const selector = new SmoothWeightedRoundRobin();
    selector.setToken(1, 5);
    selector.setToken(2, 2);
    selector.setToken(3, 1);

    const picked = pickMany(selector, [1, 2, 3], 8);
    expect(picked.filter((id) => id === 1)).toHaveLength(5);
    expect(picked.filter((id) => id === 2)).toHaveLength(2);
    expect(picked.filter((id) => id === 3)).toHaveLength(1);
  });

  it("selects only from the current eligible set", () => {
    const selector = new SmoothWeightedRoundRobin();
    selector.setToken(1, 10);
    selector.setToken(2, 1);

    expect(selector.select(new Set([2]))).toBe(2);
    expect(selector.select(new Set([1, 2]))).toBe(1);
  });

  it("resets scores when a weight changes or a token is removed", () => {
    const selector = new SmoothWeightedRoundRobin();
    selector.setToken(1, 3);
    selector.setToken(2, 1);
    selector.select(new Set([1, 2]));

    selector.setToken(1, 1);
    expect(pickMany(selector, [1, 2], 2)).toEqual([1, 2]);

    selector.removeToken(1);
    expect(selector.select(new Set([1, 2]))).toBe(2);
  });

  it("returns null for empty or unregistered candidates", () => {
    const selector = new SmoothWeightedRoundRobin();
    expect(selector.select(new Set())).toBeNull();
    expect(selector.select(new Set([99]))).toBeNull();
  });

  it("rejects weights outside 1 through 100", () => {
    const selector = new SmoothWeightedRoundRobin();
    expect(() => selector.setToken(1, 0)).toThrow(RangeError);
    expect(() => selector.setToken(1, 101)).toThrow(RangeError);
    expect(() => selector.setToken(1, 1.5)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run the selector test and confirm the expected failure**

Run:

```bash
pnpm --filter qgrid-api exec vitest run src/utils/providers/common/smooth-weighted-round-robin.test.ts
```

Expected: FAIL because `./smooth-weighted-round-robin` does not exist.

- [ ] **Step 3: Implement the selector**

Create `smooth-weighted-round-robin.ts`:

```ts
export class SmoothWeightedRoundRobin {
  private readonly weights = new Map<number, number>();
  private readonly currentScores = new Map<number, number>();

  setToken(tokenId: number, weight: number): void {
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) {
      throw new RangeError("weight must be an integer between 1 and 100");
    }
    if (this.weights.get(tokenId) === weight) return;
    this.weights.set(tokenId, weight);
    this.resetScores();
  }

  removeToken(tokenId: number): void {
    if (!this.weights.delete(tokenId)) return;
    this.currentScores.delete(tokenId);
    this.resetScores();
  }

  resetScores(): void {
    this.currentScores.clear();
  }

  select(eligibleTokenIds: ReadonlySet<number>): number | null {
    const candidates = [...eligibleTokenIds]
      .filter((tokenId) => this.weights.has(tokenId))
      .sort((a, b) => a - b);
    if (candidates.length === 0) return null;

    let selected = candidates[0]!;
    let selectedScore = Number.NEGATIVE_INFINITY;
    let totalWeight = 0;

    for (const tokenId of candidates) {
      const weight = this.weights.get(tokenId)!;
      totalWeight += weight;
      const score = (this.currentScores.get(tokenId) ?? 0) + weight;
      this.currentScores.set(tokenId, score);
      if (score > selectedScore) {
        selected = tokenId;
        selectedScore = score;
      }
    }

    this.currentScores.set(selected, selectedScore - totalWeight);
    return selected;
  }
}
```

- [ ] **Step 4: Run the selector test and API type check**

Run:

```bash
pnpm --filter qgrid-api exec vitest run src/utils/providers/common/smooth-weighted-round-robin.test.ts
pnpm exec tsc -p packages/api/tsconfig.json --noEmit
```

Expected: both commands exit 0; selector test reports 7 passing tests.

- [ ] **Step 5: Commit the selector**

```bash
git add packages/api/src/utils/providers/common/smooth-weighted-round-robin.ts packages/api/src/utils/providers/common/smooth-weighted-round-robin.test.ts
git commit -m "feat(qgrid): 가중 라운드로빈 선택기 추가"
```

---

### Task 2: Add weight to the token data and API contract

**Files:**

- Modify: `packages/api/src/application/token/token.entity.json:5-28`
- Modify: `packages/api/src/application/token/token.types.ts:33-44`
- Modify: `packages/api/src/application/token/token.types.test.ts:16-34`
- Modify: `packages/api/src/application/token/token.model.ts:16-21`
- Modify: `packages/api/src/application/token/token.model.test.ts:34-69`
- Modify: `packages/api/src/application/qgrid/qgrid.frame.ts:407-435`
- Modify: `packages/api/src/application/qgrid/qgrid.frame.test.ts:48-99`
- Create: `packages/api/src/migrations/20260710090000_alter_tokens_add_weight.ts`
- Regenerate: `packages/api/src/application/sonamu.generated.ts`
- Regenerate: `packages/api/src/application/sonamu.generated.sso.ts`
- Regenerate: `packages/api/src/application/sonamu.generated.http`
- Regenerate: `packages/api/src/i18n/sd.generated.ts`
- Regenerate: `packages/web/src/services/sonamu.generated.ts`
- Regenerate: `packages/web/src/services/services.generated.ts`
- Regenerate: `packages/web/src/services/token/token.types.ts`
- Regenerate: `packages/web/src/i18n/sd.generated.ts`
- Regenerate: `packages/api/sonamu.lock`

**Interfaces:**

- Produces: `TokenSubsetMapping["A"]["weight"]: number`
- Produces: `TokenSaveParams.weight?: number`, validated as an integer from 1 through 100.
- Produces: `QgridFrame.updateToken(id, name?, quotaThreshold?, weight?)`.
- Migration contract: existing rows and new inserts receive `weight = 1`; the column is non-null.

- [ ] **Step 1: Extend token schema and model tests first**

Add these assertions to `token.types.test.ts`:

```ts
it("accepts integer weights from 1 through 100", () => {
  expect(TokenSaveParams.parse({ ...baseToken, weight: 1 }).weight).toBe(1);
  expect(TokenSaveParams.parse({ ...baseToken, weight: 100 }).weight).toBe(100);
});

it("rejects invalid weights", () => {
  for (const weight of [0, 101, 1.5]) {
    expect(() => TokenSaveParams.parse({ ...baseToken, weight })).toThrow();
  }
});
```

Add these cases to `token.model.test.ts`:

```ts
it("applies weight 1 to newly created tokens by default", async () => {
  const { ubRegister } = mockWritePuri();
  await TokenModel.save([baseToken]);
  expect(ubRegister).toHaveBeenCalledWith("tokens", expect.objectContaining({ weight: 1 }));
});

it("preserves an explicit create weight and does not inject weight into updates", async () => {
  const { ubRegister } = mockWritePuri();
  await TokenModel.save([{ ...baseToken, weight: 4 }, { ...baseToken, id: 1 }]);
  expect(ubRegister.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ weight: 4 }));
  expect(ubRegister.mock.calls[1]?.[1]).not.toHaveProperty("weight");
});
```

Extend `qgrid.frame.test.ts`'s `tokenEntry` with `weight: 1`, then add:

```ts
it("rejects invalid weights before saving", async () => {
  findOneMock.mockResolvedValueOnce(tokenEntry);
  await expect(QgridFrame.updateToken(1, "tok-A", undefined, 0)).rejects.toThrow(
    "weight must be an integer between 1 and 100",
  );
  expect(saveMock).not.toHaveBeenCalled();
});

it("saves a valid weight while preserving omitted fields", async () => {
  findOneMock.mockResolvedValueOnce(tokenEntry);
  await expect(QgridFrame.updateToken(1, undefined, undefined, 4)).resolves.toEqual({
    updated: true,
  });
  expect(saveMock).toHaveBeenCalledWith([
    expect.objectContaining({ id: 1, name: "tok-A", weight: 4 }),
  ]);
});
```

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
pnpm --filter qgrid-api exec vitest run src/application/token/token.types.test.ts src/application/token/token.model.test.ts src/application/qgrid/qgrid.frame.test.ts
```

Expected: FAIL because `TokenSaveParams` and `updateToken` do not accept weight.

- [ ] **Step 3: Add the entity, validation, defaults, API parameter, and migration source**

Add this entity property and include `weight` in subset `A`:

```json
{
  "name": "weight",
  "type": "integer",
  "desc": "가중 라운드로빈 라우팅 가중치 (1..100)",
  "dbDefault": "1"
}
```

Extend `TokenSaveParams`:

```ts
const TokenQuotaThreshold = z.int().min(1).max(100).nullable();
const TokenWeight = z.int().min(1).max(100);

export const TokenSaveParams = TokenBaseSchema.partial({
  id: true,
  created_at: true,
  active: true,
  ord: true,
  quota_threshold: true,
  weight: true,
}).extend({
  quota_threshold: TokenQuotaThreshold.optional(),
  weight: TokenWeight.optional(),
});
```

Refactor create defaults without changing explicit `null` quota behavior:

```ts
const DEFAULT_QUOTA_THRESHOLD = 80;
const DEFAULT_WEIGHT = 1;

function applyCreateDefaults(sp: TokenSaveParams): TokenSaveParams {
  if (sp.id !== undefined) return sp;
  return {
    ...sp,
    ...(sp.quota_threshold === undefined
      ? { quota_threshold: DEFAULT_QUOTA_THRESHOLD }
      : {}),
    ...(sp.weight === undefined ? { weight: DEFAULT_WEIGHT } : {}),
  };
}
```

Add the optional fourth update field and preserve the current quota validation message:

```ts
async updateToken(
  id: number,
  name?: string,
  quotaThreshold?: number | null,
  weight?: number,
): Promise<{ updated: boolean }> {
  const entry = await TokenModel.findOne("A", { id });
  if (!entry) return { updated: false };
  if (weight !== undefined && (!Number.isInteger(weight) || weight < 1 || weight > 100)) {
    throw new BadRequestException(
      "weight must be an integer between 1 and 100" as LocalizedString,
    );
  }

  const patch: TokenSaveParamsType = {
    id: entry.id,
    provider: entry.provider,
    credentials: entry.credentials,
    name: name !== undefined ? name : entry.name,
  };
  if (quotaThreshold !== undefined) patch.quota_threshold = quotaThreshold;
  if (weight !== undefined) patch.weight = weight;

  const parsed = TokenSaveParams.safeParse(patch);
  if (!parsed.success) {
    throw new BadRequestException(
      "quotaThreshold must be an integer between 1 and 100, or null" as LocalizedString,
      { zodError: parsed.error },
    );
  }

  await TokenModel.save([parsed.data]);
  return { updated: true };
}
```

Create the migration source without executing it:

```ts
import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tokens", (table) => {
    table.integer("weight").notNullable().defaultTo(1);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tokens", (table) => {
    table.dropColumns("weight");
  });
}
```

- [ ] **Step 4: Regenerate Sonamu contracts without applying migrations**

Build the API artifact first because Sonamu 0.9.9 loads `packages/api/dist/sonamu.config.js` during sync. Then run sync. Neither command applies migrations:

```bash
pnpm --filter qgrid-api sonamu build api
pnpm --filter qgrid-api sonamu sync
```

Expected: both commands exit 0; generated API and web schemas include `weight`; `QgridService.updateToken` and its mutation accept `weight?: number`. Do not run `sonamu migrate run`. Before sync, verify that any database configuration loaded by Sonamu points to the disposable local container. If it points to dev0 or another remote host, stop without running sync and update generated artifacts only after a local configuration is available.

Inspect generated changes:

```bash
rg -n "weight|updateToken" packages/api/src/application/sonamu.generated.ts packages/api/src/application/sonamu.generated.sso.ts packages/web/src/services/sonamu.generated.ts packages/web/src/services/services.generated.ts
```

Expected: `weight: z.int()` appears in Token base/subset schemas and `weight` appears in the update-token request contract.

- [ ] **Step 5: Run contract tests and type checks**

Run:

```bash
pnpm --filter qgrid-api exec vitest run src/application/token/token.types.test.ts src/application/token/token.model.test.ts src/application/qgrid/qgrid.frame.test.ts
pnpm exec tsc -p packages/api/tsconfig.json --noEmit
pnpm exec tsc -p packages/web/tsconfig.json --noEmit
```

Expected: all focused tests pass; both TypeScript commands exit 0.

- [ ] **Step 6: Commit the token contract**

```bash
git add packages/api/sonamu.lock packages/api/src/application packages/api/src/i18n packages/api/src/migrations/20260710090000_alter_tokens_add_weight.ts packages/web/src/i18n packages/web/src/services
git commit -m "feat(qgrid): 토큰 라우팅 가중치 저장"
```

---

### Task 3: Propagate weight through token notifications and reconcile

**Files:**

- Modify: `packages/api/src/application/qgrid/token-trigger-setup.ts:35-45`
- Modify: `packages/api/src/application/qgrid/token-subscriber.ts:178-246`
- Modify: `packages/api/src/application/qgrid/token-subscriber.test.ts:17-89`
- Create: `packages/api/src/application/qgrid/token-trigger-setup.test.ts`
- Modify: `packages/api/src/utils/providers/anthropic/anthropic-dispatcher.ts:38-143`
- Modify: `packages/api/src/utils/providers/openai/openai-dispatcher.ts:92-244`
- Modify: `packages/api/src/utils/providers/openai/openai-dispatcher.ts:584-662`

**Interfaces:**

- Produces: notification and reconcile calls pass `(id, name, credentials, quotaThreshold, weight)`.
- Produces: provider add/update/replace metadata methods accept and retain weight before routing integration.
- Trigger contract: an update where only `weight` changes emits `tokens_changed`.

- [ ] **Step 1: Write notification, reconcile, and trigger SQL tests**

Update the token fixture with `weight: 4` and require the fifth argument:

```ts
expect(openaiDispatcher.onTokenUpdated).toHaveBeenCalledWith(
  1,
  "tok-A",
  { accessToken: "access", accountId: "account" },
  80,
  4,
);
```

Add an Anthropic notification assertion with a dispatcher that records its call:

```ts
const anthropicDispatcher = { onTokenUpdated: vi.fn() };
const subscriber = new TokenSubscriber(
  {} as never,
  {
    removeCache: vi.fn(),
    upsertCache: vi.fn(),
    replaceCache: vi.fn(),
    openaiDispatcher: null,
    anthropicDispatcher,
  } as never,
);
findOneMock.mockResolvedValueOnce({
  ...openaiToken(true),
  provider: "anthropic",
  credentials: { accessToken: "access", refreshToken: "refresh" },
});

await subscriber.handleNotification(JSON.stringify({ op: "UPDATE", id: 1 }));

expect(anthropicDispatcher.onTokenUpdated).toHaveBeenCalledWith(
  1,
  "tok-A",
  { accessToken: "access", refreshToken: "refresh" },
  80,
  4,
);
```

Add a reconcile test with mocked `replaceTokens` methods and assert each receives:

```ts
expect(anthropicDispatcher.replaceTokens).toHaveBeenCalledWith([
  expect.objectContaining({ id: 1, quotaThreshold: 80, weight: 4 }),
]);
expect(openaiDispatcher.replaceTokens).toHaveBeenCalledWith([
  expect.objectContaining({ id: 2, quotaThreshold: 80, weight: 4 }),
]);
```

Export the trigger SQL as `TOKENS_TRIGGER_SETUP_SQL` and create `token-trigger-setup.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { TOKENS_TRIGGER_SETUP_SQL } from "./token-trigger-setup";

describe("tokens trigger setup", () => {
  it("notifies when token weight changes", () => {
    expect(TOKENS_TRIGGER_SETUP_SQL).toContain(
      "OLD.weight IS DISTINCT FROM NEW.weight",
    );
  });
});
```

- [ ] **Step 2: Run subscriber tests and confirm failure**

Run:

```bash
pnpm --filter qgrid-api exec vitest run src/application/qgrid/token-subscriber.test.ts src/application/qgrid/token-trigger-setup.test.ts
```

Expected: FAIL because weight is not passed and the trigger SQL is not exported or weight-aware.

- [ ] **Step 3: Wire weight through notifications and reconcile**

Change each provider callback to append `row.weight`:

```ts
openaiDispatcher?.onTokenAdded(
  payload.id,
  row.name,
  creds as OpenAICredentials,
  row.quota_threshold,
  row.weight,
);
```

Apply the same fifth argument to OpenAI update and both Anthropic add/update calls. Add `weight: r.weight` to both reconcile row mappings.

In the same step, make the receiving methods type-safe. Anthropic pooled metadata and event handlers become:

```ts
interface PooledToken {
  id: number;
  name: string;
  credentials: AnthropicCredentials;
  quotaThreshold?: number | null;
  weight: number;
}

onTokenAdded(
  id: number,
  name: string,
  credentials: AnthropicCredentials,
  quotaThreshold?: number | null,
  weight = 1,
): void {
  this.tokenPool.set(id, { id, name, credentials, quotaThreshold, weight });
}
```

Apply the same signature and assignment to `onTokenUpdated`; add required `weight: number` to `replaceTokens` rows; load `weight: t.weight` during `start`.

OpenAI metadata and receiving signatures become:

```ts
type TokenMetadata = {
  name: string;
  quotaThreshold?: number | null;
  weight: number;
};

private setTokenMetadata(
  id: number,
  name: string,
  quotaThreshold: number | null | undefined,
  weight: number,
): void {
  this.tokenMetadata.set(id, { name, quotaThreshold, weight });
}
```

Append `weight = 1` to `onTokenAdded`, `onTokenUpdated`, and `spawnWorkers`; add required `weight: number` to `replaceTokens` rows. Forward weight through every `setTokenMetadata` and `spawnWorkers` call, including startup. This task stores weight but does not change selection yet.

Rename and export the trigger SQL, add the condition, and use the exported constant in `ensureTokensTrigger`:

```ts
export const TOKENS_TRIGGER_SETUP_SQL = `
  CREATE OR REPLACE TRIGGER tokens_changed_upd
  AFTER UPDATE ON public.tokens
  FOR EACH ROW
  WHEN (
    OLD.active IS DISTINCT FROM NEW.active OR
    OLD.credentials IS DISTINCT FROM NEW.credentials OR
    OLD.provider IS DISTINCT FROM NEW.provider OR
    OLD.name IS DISTINCT FROM NEW.name OR
    OLD.quota_threshold IS DISTINCT FROM NEW.quota_threshold OR
    OLD.weight IS DISTINCT FROM NEW.weight
  )
  EXECUTE FUNCTION public.tokens_notify();
`;
```

Retain the function definition and insert/delete trigger text already present above this update-trigger block. Change `client.query(SETUP_SQL)` to `client.query(TOKENS_TRIGGER_SETUP_SQL)`.

- [ ] **Step 4: Run notification tests**

Run:

```bash
pnpm --filter qgrid-api exec vitest run src/application/qgrid/token-subscriber.test.ts src/application/qgrid/token-trigger-setup.test.ts
pnpm exec tsc -p packages/api/tsconfig.json --noEmit
```

Expected: all notification, reconcile, and SQL contract tests pass; the API type check exits 0 with both provider handler signatures accepting weight.

- [ ] **Step 5: Commit propagation changes**

```bash
git add packages/api/src/application/qgrid/token-subscriber.ts packages/api/src/application/qgrid/token-subscriber.test.ts packages/api/src/application/qgrid/token-trigger-setup.ts packages/api/src/application/qgrid/token-trigger-setup.test.ts packages/api/src/utils/providers/anthropic/anthropic-dispatcher.ts packages/api/src/utils/providers/openai/openai-dispatcher.ts
git commit -m "feat(qgrid): 토큰 가중치 변경 실시간 반영"
```

---

### Task 4: Replace Anthropic least-used routing with weighted routing

**Files:**

- Modify: `packages/api/src/utils/providers/anthropic/anthropic-dispatcher.ts:38-173`
- Modify: `packages/api/src/utils/providers/anthropic/anthropic-dispatcher.test.ts:201-330`

**Interfaces:**

- Consumes: `SmoothWeightedRoundRobin` from Task 1.
- Consumes: pooled token rows and token event methods retain `weight: number` from Task 3.
- Produces: quota-filtered Anthropic token selection in the configured weight ratio.

- [ ] **Step 1: Replace the equal-routing test with weighted behavior tests**

Add a helper that captures selected token names over complete cycles, then add:

```ts
it("routes Anthropic requests in a 3:1 ratio", async () => {
  const d = new AnthropicDispatcher();
  d.onTokenAdded(1, "tok-A", creds(), null, 3);
  d.onTokenAdded(2, "tok-B", creds(), null, 1);

  const names = await Promise.all(
    Array.from({ length: 4 }, async () => (await d.generate(baseReq())).tokenName),
  );

  expect(names.filter((name) => name === "tok-A")).toHaveLength(3);
  expect(names.filter((name) => name === "tok-B")).toHaveLength(1);
});

it("recomputes weighted selection from quota-eligible tokens", async () => {
  const d = new AnthropicDispatcher();
  d.onTokenAdded(1, "tok-A", creds(), 80, 10);
  d.onTokenAdded(2, "tok-B", creds(), 80, 1);
  readAnthropicQuotaUsageMock
    .mockResolvedValueOnce(quotaOk(90))
    .mockResolvedValueOnce(quotaOk(10));

  expect((await d.generate(baseReq())).tokenName).toBe("tok-B");
});

it("resets the schedule when a token weight changes", async () => {
  const d = new AnthropicDispatcher();
  d.onTokenAdded(1, "tok-A", creds(), null, 1);
  d.onTokenAdded(2, "tok-B", creds(), null, 1);
  await d.generate(baseReq());

  d.onTokenUpdated(1, "tok-A", creds(), null, 1);
  d.onTokenUpdated(2, "tok-B", creds(), null, 3);
  const names = await Promise.all(
    Array.from({ length: 4 }, async () => (await d.generate(baseReq())).tokenName),
  );
  expect(names.filter((name) => name === "tok-B")).toHaveLength(3);
});
```

Retain the concurrent-quota test and update every existing add/update call to pass weight 1 where the test is not specifically checking another weight. The required call shape is:

```ts
d.onTokenAdded(1, "tok-A", creds(), 80, 1);
d.onTokenUpdated(1, "tok-A", creds(), 80, 1);
```

- [ ] **Step 2: Run Anthropic tests and confirm failure**

Run:

```bash
pnpm --filter qgrid-api exec vitest run src/utils/providers/anthropic/anthropic-dispatcher.test.ts
```

Expected: FAIL because the dispatcher ignores weight and still uses `requestCounts`/`rrIndex`.

- [ ] **Step 3: Integrate the shared selector**

Add the shared selector field to the pooled metadata already extended in Task 3:

```ts
private readonly weightedSelector = new SmoothWeightedRoundRobin();
```

For start/add/update, call `setToken(id, weight)` after storing the metadata prepared in Task 3. For remove, call `removeToken(id)`. For stop, snapshot the registered token IDs, remove them from the selector, clear the pool, and reset scores. Delete `requestCounts`, `rrIndex`, `countOf`, and `charge`.

Replace the final selection block after quota filtering:

```ts
const selectedId = this.weightedSelector.select(new Set(eligible.map((token) => token.id)));
if (selectedId === null) return null;
return this.tokenPool.get(selectedId) ?? null;
```

This selector call must remain synchronous and before token refresh or `runClaudeSession`.

- [ ] **Step 4: Run Anthropic dispatcher and quota tests**

Run:

```bash
pnpm --filter qgrid-api exec vitest run src/utils/providers/anthropic/anthropic-dispatcher.test.ts src/utils/providers/anthropic/anthropic-quota.test.ts
```

Expected: all tests pass; existing quota error and fail-open cases remain green.

- [ ] **Step 5: Commit Anthropic weighted routing**

```bash
git add packages/api/src/utils/providers/anthropic/anthropic-dispatcher.ts packages/api/src/utils/providers/anthropic/anthropic-dispatcher.test.ts
git commit -m "feat(qgrid): Anthropic 토큰 가중 라우팅"
```

---

### Task 5: Add token-level weighted routing to OpenAI workers and queue drain

**Files:**

- Modify: `packages/api/src/utils/providers/openai/openai-dispatcher.ts:84-244`
- Modify: `packages/api/src/utils/providers/openai/openai-dispatcher.ts:343-478`
- Modify: `packages/api/src/utils/providers/openai/openai-dispatcher.ts:582-670`
- Modify: `packages/api/src/utils/providers/openai/openai-dispatcher.test.ts:90-125`
- Modify: `packages/api/src/utils/providers/openai/openai-dispatcher.test.ts:220-455`

**Interfaces:**

- Consumes: `SmoothWeightedRoundRobin` from Task 1.
- Consumes: OpenAI token metadata includes `weight: number`.
- Produces: `acquireIdleWorker` selects a token by weight, then acquires an idle worker from that token.
- Preserves: `acquireReuseWorker` does not call or modify the weighted selector.

- [ ] **Step 1: Make fake workers expose capacity and write weighted cold-routing tests**

Add this getter to `fakeWorker`:

```ts
get hasCapacity() {
  return !busy;
},
```

Add tests that use two workers for one token to prove weighting is token-based rather than worker-based:

```ts
it("routes cold OpenAI requests by token weight instead of worker count", async () => {
  const dispatcher = new OpenAIDispatcher();
  const a0 = fakeWorker({ tokenId: 1, tokenName: "tok-A", workerIndex: 0 });
  const a1 = fakeWorker({ tokenId: 1, tokenName: "tok-A", workerIndex: 1 });
  const b0 = fakeWorker({ tokenId: 2, tokenName: "tok-B", workerIndex: 0 });
  addWorkers(dispatcher, [a0, a1, b0]);
  await dispatcher.onTokenUpdated(1, "tok-A", credentials(), null, 3);
  await dispatcher.onTokenUpdated(2, "tok-B", credentials(), null, 1);

  const names: string[] = [];
  for (let i = 0; i < 4; i++) {
    const worker = await dispatcher.acquireIdleWorker();
    names.push(worker!.tokenName);
    worker!.releaseTurn();
  }
  expect(names.filter((name) => name === "tok-A")).toHaveLength(3);
  expect(names.filter((name) => name === "tok-B")).toHaveLength(1);
});

it("skips a high-weight token when all of its workers are busy", async () => {
  const dispatcher = new OpenAIDispatcher();
  addWorkers(dispatcher, [
    fakeWorker({ tokenId: 1, tokenName: "tok-A", busy: true }),
    fakeWorker({ tokenId: 2, tokenName: "tok-B" }),
  ]);
  await dispatcher.onTokenUpdated(1, "tok-A", credentials(), null, 100);
  await dispatcher.onTokenUpdated(2, "tok-B", credentials(), null, 1);

  await expect(dispatcher.acquireIdleWorker()).resolves.toMatchObject({ tokenName: "tok-B" });
});
```

- [ ] **Step 2: Write queue-drain and reuse-bypass regression tests**

Add a queue test where token A is released, but the next weighted turn belongs to token B:

```ts
it("uses weighted selection when draining after a worker release", async () => {
  const dispatcher = new OpenAIDispatcher();
  const workerA = fakeWorker({ tokenId: 1, tokenName: "tok-A", busy: true });
  const workerB = fakeWorker({ tokenId: 2, tokenName: "tok-B", busy: true });
  addWorkers(dispatcher, [workerA, workerB]);
  await dispatcher.onTokenUpdated(1, "tok-A", credentials(), null, 1);
  await dispatcher.onTokenUpdated(2, "tok-B", credentials(), null, 3);

  const queued = dispatcher.enqueue(async (worker) => worker.tokenName);
  await waitForQueue(dispatcher);
  workerA.releaseTurn();
  workerB.releaseTurn();

  await dispatcher.drainQueue(workerA);
  await expect(queued).resolves.toBe("tok-B");
});
```

Add a reuse test that proves a pinned reuse does not consume the cold schedule:

```ts
it("does not advance weighted state for successful thread reuse", async () => {
  const dispatcher = new OpenAIDispatcher();
  const workerA = fakeWorker({ tokenId: 1, tokenName: "tok-A" });
  const workerB = fakeWorker({
    tokenId: 2,
    tokenName: "tok-B",
    threads: ["thread-B"],
  });
  addWorkers(dispatcher, [workerA, workerB]);
  await dispatcher.onTokenUpdated(1, "tok-A", credentials(), null, 1);
  await dispatcher.onTokenUpdated(2, "tok-B", credentials(), null, 1);
  vi.spyOn(dispatcher, "executeTurn").mockImplementation(
    async (worker, _req, reuseThreadId) => resultFor(worker, reuseThreadId ?? "thread-new"),
  );

  const cold1 = await dispatcher.generate(baseReq());
  const reused = await dispatcher.generate(
    baseReq({ reuse: { workerId: 20, threadId: "thread-B", epoch: 1 } }),
  );
  const cold2 = await dispatcher.generate(baseReq());

  expect([cold1.tokenName, cold2.tokenName]).toEqual(["tok-A", "tok-B"]);
  expect(reused).toMatchObject({ tokenName: "tok-B", threadCoord: { threadId: "thread-B" } });
});
```

The queue test's final assertion is:

```ts
await dispatcher.drainQueue(workerA);
await expect(queued).resolves.toBe("tok-B");
```

- [ ] **Step 3: Run OpenAI dispatcher tests and confirm failure**

Run:

```bash
pnpm --filter qgrid-api exec vitest run src/utils/providers/openai/openai-dispatcher.test.ts
```

Expected: weighted and queue-drain tests fail because selection is worker-level and the released-worker shortcut bypasses weighting.

- [ ] **Step 4: Add selector lifecycle to the weight metadata from Task 3**

Add selector and per-token worker cursor fields; `TokenMetadata.weight` already exists from Task 3:

```ts
private readonly weightedSelector = new SmoothWeightedRoundRobin();
private readonly workerCursorByToken = new Map<number, number>();
```

Change `setTokenMetadata` to call `weightedSelector.setToken(id, weight)` after updating the map. Remove selector and worker-cursor state in `onTokenRemoved` and `stop`.

Reset scores on actual activation transitions, not on every periodic reconcile:

```ts
onTokenActivated(id: number): void {
  const workers = this.workerPool.get(id) ?? [];
  const changed = workers.some((worker) => !worker.active);
  workers.forEach((worker) => {
    worker.active = true;
  });
  if (changed) this.weightedSelector.resetScores();
  this.requestDrainQueue();
  const label = tokenName ?? `token ${id}`;
  logger.info(`workers activated: ${label}`);
}
```

Apply the symmetric `changed` check in `onTokenDeactivated`.

- [ ] **Step 5: Replace worker-level round-robin with token-first selection**

After quota eligibility resolves, build idle groups using `hasCapacity`, select a token, and synchronously acquire one worker:

```ts
const workersByToken = new Map<number, CodexAppServerWorker[]>();
for (const worker of this.getAllReadyActiveWorkers()) {
  if (!eligibility.eligibleTokenIds.has(worker.tokenId) || !worker.hasCapacity) continue;
  const workers = workersByToken.get(worker.tokenId) ?? [];
  workers.push(worker);
  workersByToken.set(worker.tokenId, workers);
}

const selectedTokenId = this.weightedSelector.select(new Set(workersByToken.keys()));
if (selectedTokenId === null) return null;
const workers = workersByToken.get(selectedTokenId)!;
const cursor = this.workerCursorByToken.get(selectedTokenId) ?? 0;
for (let offset = 0; offset < workers.length; offset++) {
  const index = (cursor + offset) % workers.length;
  const worker = workers[index]!;
  if (worker.tryAcquireTurn()) {
    this.workerCursorByToken.set(selectedTokenId, (index + 1) % workers.length);
    return worker;
  }
}
throw new Error(`weighted token ${selectedTokenId} lost idle capacity during synchronous acquire`);
```

Remove `rrCursor`. Do not add selector calls to `acquireReuseWorker`.

- [ ] **Step 6: Remove the released-worker queue shortcut**

Change `drainQueue` and `drainQueueOnce` to ignore the released worker and always call `acquireIdleWorker` for the queue head:

```ts
async drainQueue(): Promise<void> {
  if (this.draining) {
    this.drainAgain = true;
    return;
  }
  this.draining = true;
  try {
    do {
      this.drainAgain = false;
      await this.drainQueueOnce();
    } while (this.drainAgain);
  } finally {
    this.draining = false;
  }
}
```

Use this complete `drainQueueOnce` loop so quota errors keep their current per-item behavior:

```ts
private async drainQueueOnce(): Promise<void> {
  while (this.queue.length > 0) {
    const next = this.queue[0]!;
    let worker: CodexAppServerWorker | null;
    try {
      worker = await this.acquireIdleWorker(next.excludedTokenIds);
    } catch (error) {
      if (error instanceof QuotaThresholdExceededError) {
        this.queue.shift();
        next.reject(error);
        continue;
      }
      throw error;
    }
    if (!worker) break;
    this.queue.shift();
    next.resolve(worker);
  }
}
```

Remove `isWorkerEligibleForQueueItem`. Remove the worker parameter from `requestDrainQueue`, `drainQueue`, and their call sites; `executeAndRelease` must call `this.requestDrainQueue()` after `worker.releaseTurn()`.

- [ ] **Step 7: Run OpenAI routing, quota, and worker tests**

Run:

```bash
pnpm --filter qgrid-api exec vitest run src/utils/providers/openai/openai-dispatcher.test.ts src/utils/providers/openai/openai-quota.test.ts src/utils/providers/openai/codex-worker.test.ts
```

Expected: all tests pass, including existing queue serialization, quota fallback, thread reuse, and image-generation cases.

- [ ] **Step 8: Commit OpenAI weighted routing**

```bash
git add packages/api/src/utils/providers/openai/openai-dispatcher.ts packages/api/src/utils/providers/openai/openai-dispatcher.test.ts
git commit -m "feat(qgrid): OpenAI 토큰 가중 라우팅"
```

---

### Task 6: Add dashboard weight editing and run final verification

**Files:**

- Modify: `packages/web/src/components/qgrid/UsageCard.tsx:21-37`
- Modify: `packages/web/src/components/qgrid/UsageCard.tsx:191-359`
- Modify: `packages/web/src/components/qgrid/UsageCard.tsx:390-425`
- Modify: `packages/web/src/components/qgrid/TokenTable.tsx:75-83`
- Verify: all files changed by Tasks 1 through 5

**Interfaces:**

- Consumes: generated `QgridService.useUpdateTokenMutation` with `weight`.
- Produces: dashboard validation and editing for integer weights from 1 through 100.
- Preserves: name and quota updates do not overwrite weight with an unintended value.

- [ ] **Step 1: Add a pure weight validator beside `validateThreshold`**

Add:

```ts
function validateWeight(
  raw: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: "1–100 사이 정수를 입력하세요" };
  const value = Number(trimmed);
  if (value < 1 || value > 100) {
    return { ok: false, error: "1–100 사이 정수를 입력하세요" };
  }
  return { ok: true, value };
}
```

- [ ] **Step 2: Add `WeightControl` using the existing fixed popover pattern**

Add this component beside `ThresholdControl`:

```tsx
function WeightControl({ token }: { token: Token }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [value, setValue] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const updateMutation = QgridService.useUpdateTokenMutation();
  const validation = validateWeight(value);

  const openPopover = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 240;
    const height = 150;
    const margin = 8;
    const gap = 6;
    const left = Math.min(
      Math.max(rect.right - width, margin),
      Math.max(window.innerWidth - width - margin, margin),
    );
    const above = rect.top - gap - height;
    const top = Math.min(
      Math.max(above >= margin ? above : rect.bottom + gap, margin),
      Math.max(window.innerHeight - height - margin, margin),
    );
    setValue(String(token.weight));
    setPos({ left, top });
  };

  const close = () => setPos(null);
  const adjust = (delta: number) => {
    const current = /^\d+$/.test(value.trim()) ? Number(value.trim()) : 1;
    setValue(String(Math.min(Math.max(current + delta, 1), 100)));
  };

  const save = async () => {
    if (!validation.ok) return;
    await updateMutation.mutateAsync({
      id: token.id,
      name: token.name ?? "",
      quotaThreshold: token.quota_threshold,
      weight: validation.value,
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["Token"] }),
      queryClient.invalidateQueries({ queryKey: ["Qgrid"] }),
    ]);
    close();
  };

  return (
    <div className="inline-flex" onPointerDown={stopDragPropagation} onClick={stopDragPropagation}>
      <button
        ref={triggerRef}
        type="button"
        title="라우팅 가중치 설정"
        onClick={pos ? close : openPopover}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] border border-sand-200/80 text-sand-400 hover:text-sand-600 hover:border-sand-300 transition-colors duration-150"
      >
        Weight {token.weight}
      </button>
      {pos && (
        <>
          <div className="fixed inset-0 z-40" onPointerDown={close} />
          <div className="fixed z-50 w-60 panel shadow-xl p-3" style={pos}>
            <label
              htmlFor={`weight-${token.id}`}
              className="text-[10px] uppercase tracking-wider text-sand-500 font-medium"
            >
              라우팅 가중치
            </label>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => adjust(-1)}
                className="size-9 shrink-0 rounded-md border border-sand-200 text-sand-600"
              >
                −
              </button>
              <Input
                id={`weight-${token.id}`}
                value={value}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  setValue(event.target.value)
                }
                inputMode="numeric"
                className={`h-9 w-16 border rounded-md text-center text-sm tabular-nums ${
                  validation.ok ? "border-sand-200" : "border-red-300"
                }`}
              />
              <button
                type="button"
                onClick={() => adjust(1)}
                className="size-9 shrink-0 rounded-md border border-sand-200 text-sand-600"
              >
                +
              </button>
            </div>
            <p className={`mt-1.5 text-[11px] ${validation.ok ? "text-sand-500" : "text-red-500"}`}>
              {validation.ok ? "새 요청의 상대 배정 비율입니다." : validation.error}
            </p>
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button type="button" onClick={close} className="px-2 py-1 text-[11px]">
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={updateMutation.isPending || !validation.ok}
                className="px-2 py-1 text-[11px] rounded-md bg-sienna-400 text-white disabled:opacity-50"
              >
                {updateMutation.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Preserve weight in the other token update paths**

Update `ThresholdControl.save` and `TokenTable.handleUpdate` to send:

```ts
weight: token.weight,
```

or, for the table edit target:

```ts
weight: editTarget.weight,
```

Render both controls together:

```tsx
<div className="mt-2 flex items-center justify-end gap-1.5">
  <WeightControl token={token} />
  <ThresholdControl token={token} />
</div>
```

- [ ] **Step 4: Run web and repository checks**

Run:

```bash
pnpm exec tsc -p packages/web/tsconfig.json --noEmit
pnpm exec tsc -p packages/api/tsconfig.json --noEmit
pnpm check
```

Expected: all commands exit 0 with no type, lint, or formatting errors.

- [ ] **Step 5: Run the complete focused API suite**

Run:

```bash
pnpm --filter qgrid-api exec vitest run src/utils/providers/common/smooth-weighted-round-robin.test.ts src/utils/providers/anthropic/anthropic-dispatcher.test.ts src/utils/providers/anthropic/anthropic-quota.test.ts src/utils/providers/openai/openai-dispatcher.test.ts src/utils/providers/openai/openai-quota.test.ts src/application/token/token.types.test.ts src/application/token/token.model.test.ts src/application/qgrid/qgrid.frame.test.ts src/application/qgrid/token-subscriber.test.ts src/application/qgrid/token-trigger-setup.test.ts
```

Expected: all listed test files pass.

- [ ] **Step 6: Review generated and migration diffs without touching a remote DB**

Run:

```bash
git diff --check
git diff --stat origin/main...HEAD
rg -n "weight" packages/api/src/migrations/20260710090000_alter_tokens_add_weight.ts packages/api/src/application/token packages/api/src/application/qgrid/token-subscriber.ts packages/web/src/components/qgrid/UsageCard.tsx
```

Expected: no whitespace errors; every persistence, propagation, routing, and UI layer contains the weight field. Do not run a migration against dev0 or another remote database.

- [ ] **Step 7: Optionally verify migration up/down only in the disposable local container**

Skip this step unless the execution environment is explicitly configured to the repository's local PostgreSQL container. Before any migration command, inspect the configured host and require `localhost`, `127.0.0.1`, `::1`, or the local Docker service name. Then run the repository migration up/down workflow only against that container. If the host is dev0 or any remote address, stop without running the command.

Expected: local up creates non-null `tokens.weight` with default 1; local down removes it; no remote connection is opened.

- [ ] **Step 8: Commit dashboard and verification-ready integration**

```bash
git add packages/web/src/components/qgrid/UsageCard.tsx packages/web/src/components/qgrid/TokenTable.tsx
git commit -m "feat(qgrid): 토큰 가중치 설정 UI 추가"
```

## Completion criteria

- All requirements R1 through R10 and acceptance examples AE1 through AE9 in the origin document have a passing automated test or an explicit UI/type-check verification step.
- With all weights set to 1, both providers use token-level round-robin for new requests.
- OpenAI thread reuse does not advance weighted state.
- OpenAI queue drain uses the same weighted cold-selection path as immediate requests.
- Quota threshold errors and fail-open behavior remain unchanged.
- The final diff contains migration source but no evidence of a dev0 or remote migration execution.
