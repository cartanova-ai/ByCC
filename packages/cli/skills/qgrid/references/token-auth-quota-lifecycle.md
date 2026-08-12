# Token Auth Quota Lifecycle

Use this reference before changing token storage, OAuth flows, token activation, token subscriber behavior, quota thresholds, usage APIs, or provider token routing.

## Contents

- Source files
- Token table contract
- Token APIs
- Anthropic OAuth flow
- OpenAI OAuth and refresh flow
- Token sync and reconcile
- Provider runtime consequences
- Quota threshold semantics

## Source Files

- Token model/types: `packages/api/src/application/token/token.model.ts`, `token.types.ts`, `token.entity.json`.
- qgrid API frame and OAuth endpoints: `packages/api/src/application/qgrid/qgrid.frame.ts`.
- Anthropic OAuth utilities and usage API: `packages/api/src/application/qgrid/oauth.ts`.
- Token DB trigger setup: `packages/api/src/application/qgrid/token-trigger-setup.ts`.
- Token subscriber: `packages/api/src/application/qgrid/token-subscriber.ts`.
- OpenAI direct OAuth/refresh/quota: `packages/api/src/utils/providers/openai/openai-oauth.ts`, `openai-refresh.ts`, `openai-quota.ts`.
- Anthropic quota: `packages/api/src/utils/providers/anthropic/anthropic-quota.ts`.
- Provider token event handlers: `openai-dispatcher.ts`, `anthropic-dispatcher.ts`.

## Token Table Contract

`tokens` stores:

- `provider`: provider string such as `openai` or `anthropic`.
- `credentials`: JSONB credentials.
- `name`: display/logging name.
- `active`: whether provider dispatchers may use it.
- `ord`: dashboard ordering.
- `quota_threshold`: nullable integer percentage, validated as 1..100 when present.
- `weight`: non-null integer 1..100, database default 1. Relative share for weighted round-robin routing of new requests. Weight does not enable or disable a token; that stays on `active`.

On creation, `TokenModel.save` applies defaults `quota_threshold = 80` and `weight = 1` independently for any field not provided (skipped entirely when `id` is present).

OpenAI credentials:

```ts
{
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accessTokenExpiresAt: number;
  idTokenExpiresAt?: number;
  accountId: string;
  planType?: string;
}
```

Anthropic credentials:

```ts
{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountUuid: string;
}
```

Duplicate account replacement is account-identifier based:

- OpenAI: `credentials.accountId`.
- Anthropic: `credentials.accountUuid`.

## Token APIs

`QgridFrame` exposes token APIs:

- `addToken(provider, credentials, name)`: saves a token directly.
- `updateToken(id, name?, quotaThreshold?, weight?)`: partial field update through `TokenModel.updateFields`; omitted fields preserve stored values, so one control cannot overwrite another control's setting. `weight` is validated as an integer 1..100. The web client uses a hand-written `useUpdateTokenMutation` hook instead of the generated tanstack-mutation client for this endpoint.
- `removeToken(id)`: deletes token row.
- `toggleToken(id)`: flips `active`.
- `stats()`: reports dispatcher cache stats.
- `health()`: reports active token cache count and subscriber status.
- `usage(tokenId?)`: returns provider usage/rate-limit summary.

When updating a token, preserve existing provider and credentials unless intentionally rotating credentials.

## Anthropic OAuth Flow

Anthropic OAuth is implemented directly in qgrid.

1. `oauthStart(name)` generates PKCE verifier/challenge/state.
2. qgrid builds the Claude OAuth authorize URL with Claude Code-like scopes.
3. Pending state is cached under `oauth:state:<state>` for 5 minutes.
4. `/callback` calls `handleOAuthCallback(code, state, reply)`.
5. qgrid exchanges the code for tokens.
6. Existing Anthropic tokens with the same `accountUuid` are deleted.
7. qgrid saves a new `provider: "anthropic"` token.

The Anthropic OAuth client enforces a redirect-URI allowlist: loopback (`http://localhost:*/callback`) and the console callback (`https://console.anthropic.com/oauth/code/callback`) only — arbitrary public URLs cannot be registered. qgrid therefore picks the flow per request from the `Origin` header (falling back to `X-Forwarded-Host`/`Host`):

- Loopback origin: redirect flow — the callback returns to the request-derived base URL (`mode: "redirect"`).
- Remote origin: code flow — `redirect_uri` is the console callback; after login the console page shows `code#state`, which the user pastes into the dashboard and `oauthComplete` exchanges (`mode: "code"`, same flow as Claude Code CLI).
- No HTTP context (direct calls/tests): falls back to `http://localhost:${PORT}/callback`.

Refresh:

- `refreshToken(token)` uses the stored refresh token and `refreshAccessToken`.
- Refreshed credentials are saved back through `TokenModel.save`.
- `usage()` refreshes expired Anthropic access tokens before usage lookup when a refresh token exists.
- `AnthropicDispatcher` also preemptively refreshes when expiration is within 60 seconds.

Usage/quota:

- Usage API is `https://api.anthropic.com/api/oauth/usage`.
- qgrid caches Anthropic usage by access-token suffix for 60 seconds.
- Quota threshold uses `five_hour.utilization`.
- Usage lookup failure is fail-open for routing.

## OpenAI OAuth And Refresh Flow

OpenAI OAuth is implemented directly with authorization-code PKCE.

Browser registration:

1. `oauthStartOpenAI(name)` generates verifier, SHA-256 challenge, and state.
2. qgrid stores pending state and builds the OpenAI authorize URL with Codex CLI-compatible client, scope, simplified-flow, and originator fields.
3. The callback validates state and exchanges the code directly at `https://auth.openai.com/oauth/token`.
4. qgrid parses account id and plan claims from the returned JWTs.
5. Existing OpenAI tokens with the same `accountId` are deleted.
6. qgrid saves the access, refresh, and id tokens as a new `provider: "openai"` token.

Refresh:

- qgrid posts the stored refresh token directly to the OpenAI token endpoint through `handleChatgptAuthTokensRefresh(tokenId)`.
- Refresh is deduplicated per token with an in-flight promise.
- Refresh has a 5-second minimum interval; too-soon calls read current DB credentials.
- Refresh token rotation is saved immediately. If DB save fails after rotation, treat it as token-death risk because the old refresh token may already be invalid.

Usage/quota:

- OpenAI quota threshold uses direct `GET https://chatgpt.com/backend-api/wham/usage` with Codex CLI identity headers.
- Rate limit data is cached for 60 seconds.
- Threshold uses primary `usedPercent`.
- Usage lookup failure is fail-open for routing.

## Token Sync And Reconcile

On server start, qgrid creates PostgreSQL triggers for `tokens_changed`.

Triggers notify on:

- INSERT
- DELETE
- UPDATE when `active`, `credentials`, `provider`, `name`, or `quota_threshold` changes.
- UPDATE when `weight` changes, through a separate `tokens_weight_changed_upd` trigger owned by the versioned migration `20260710090000_alter_tokens_add_weight.ts`. The boot-time setup SQL intentionally leaves `weight` out of its WHEN clause (test-enforced in `token-trigger-setup.test.ts`) so exactly one trigger fires per weight-only change.

`TokenSubscriber`:

- connects to PostgreSQL and `LISTEN`s on `tokens_changed`;
- reconnects with jittered exponential backoff up to 30 seconds;
- runs periodic reconcile every 10 minutes because LISTEN/NOTIFY can miss changes while disconnected;
- replaces dispatcher cache from `TokenModel.findActive("A")`;
- serializes notification handling and reconcile through an internal operation chain, so dispatcher updates (now awaited, including weight propagation) apply in arrival order;
- passes `weight` through add, update, and reconcile calls for both provider dispatchers.

On DELETE or missing row:

- remove from `QgridDispatcher.tokens`;
- call OpenAI `onTokenRemoved`;
- call Anthropic `onTokenRemoved`.

OpenAI row changes:

- active INSERT: `onTokenAdded` spawns workers.
- active UPDATE: `onTokenUpdated`, then `onTokenActivated`.
- inactive row: `onTokenDeactivated`.
- reconcile uses `replaceTokens`, which removes absent tokens, updates existing tokens, adds new tokens, and activates rows present in active DB set.

Anthropic row changes:

- active INSERT: add to in-memory pool.
- active UPDATE: update in-memory pool.
- inactive row: remove from pool.
- reconcile uses active Anthropic rows to replace the in-memory pool.

## Provider Runtime Consequences

OpenAI token changes create, update, deactivate, or remove in-memory credential and permit metadata.

- Weight-only changes update token metadata and reset the weighted selector's scores.
- Credential changes replace the direct client's credentials without spawning a process.
- If no active OpenAI tokens remain, queued OpenAI requests are rejected.

Anthropic token changes only affect the in-memory token pool because every request fresh-spawns Claude Code.

## Auth-Dead Detection And Token Registration

When a refresh fails in a way that only re-login can fix, qgrid removes the token from routing instead of letting every subsequent request 401.

- Detection lives at the existing refresh failure points, not a background scanner. OpenAI classifies on the error code (`refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`) regardless of HTTP status; Anthropic treats refresh 400/401 as auth-dead.
- Before deactivating, qgrid re-reads the token and confirms the refresh token used by the failed attempt still matches the stored one. Anthropic refresh tokens rotate, so a late retry carrying an already-rotated token is a normal race, not a death — those are logged and skipped. `QgridFrame.refreshToken` also dedups concurrent refreshes per token.
- Deactivation is one conditional `active=true → false` update. The process whose update affects a row is the only one that sends the Slack death notification, so a shared database produces exactly one alert per event.
- The provider's last active token is never auto-deactivated. A systemic failure (client_id revocation, OAuth contract change) would otherwise empty the pool; qgrid logs an error, keeps the token, and sends its own Slack alert. That path leaves no state change behind, so every following request would re-alert — a per-provider 30-minute cooldown holds it to one. The cooldown is in-process, so N instances can each emit once per window.
- The other notification is registration: every completed login sends one alert, whether the account is new or replacing an existing row through the account dedup. Manually toggling a token back to active is not a registration and sends nothing.
- Quiet hours suppress non-urgent Slack notifications: weekends, plus 20:00–08:00 on weekdays, in `Asia/Seoul`. All three parts are settings (`slack.quietFromHour`, `slack.quietUntilHour`, `slack.notifyOnWeekends`), defaulting to that window. The hour is computed through `Intl` with an explicit timezone rather than `getHours()` — dev0 runs in UTC, where "20:00" would land at 05:00 Korean time. Expiry alerts repeat, so one dropped in quiet hours returns on the first cycle of the next working window. The last-active-token death alert sets `urgent: true` and ignores quiet hours: it means the provider pool is empty, which cannot wait for the next working day.
- `slack.enabled` exists because holidays cannot be expressed as a recurring rule — substitute holidays, one-off national days, and company closures change every year, so an operator turns notifications off directly instead. It gates the same non-urgent path as quiet hours, which keeps the escape hatch for pool-empty alerts identical in both mechanisms.
- Notifications are fail-open: unset `SLACK_BOT_TOKEN`/`SLACK_CHANNEL_ID` is a silent no-op, and send failures (including HTTP 200 with `ok:false`) only warn. Payloads carry an internal reason code such as `anthropic:400`, never the raw provider response body.
- `expired-token-reminder.ts` repeats the session-expiry alert for tokens that are still inactive, because the one-shot alert is lost on anyone not watching the channel at that moment and re-login only happens when a person does it. It reuses the same `세션 만료` title rather than inventing a second name — there is one event, so a differently-named alert would read as a separate problem. It runs once at startup and then every `SLACK_EXPIRY_REMINDER_INTERVAL_MINUTES` (unset or 0 disables), batches every inactive token into one message, and sends nothing when none are inactive. The startup run matters because a restart is exactly when someone is watching, and waiting a full interval to learn a token is already dead is backwards; the cost is one extra alert per restart — a periodic "all clear" trains people to ignore the channel.
- Owners are mentioned through `SLACK_USER_MAP` (`tokenName:SlackUserId`) on every token notification, not just the reminder. The map is explicit rather than resolved through `users.list`: Slack handles diverge from token names often enough (`haze`→`haze.lee`, `byeongjun`→`potados`) that auto-matching drops the mention silently, and an alert nobody is tagged in has no one to act on it. Shared accounts are left out of the map on purpose and appear by name only. Each instance sends its own reminder — unlike deactivation there is no state change to gate on, and a few duplicates a day cost less than a locking scheme.

## Quota Threshold Semantics

`quota_threshold` is a routing gate, not a hard external-provider guarantee.

- Null means no threshold gate.
- Lookup failure is fail-open.
- Individual over-threshold tokens are excluded from selection.
- OpenAI keeps this exclusion as an in-memory `quota-blocked` runtime state without changing the
  token's persisted `active` value or stopping its workers. It logs `over_threshold` only when a
  token enters the blocked state, skips that token during normal burst scale-up, and logs
  `recovered` once a later quota check falls below the threshold. Metadata generations prevent an
  in-flight lookup from restoring a block after a threshold or lifecycle change. The state is not
  persisted across server restarts.
- If all ready/eligible tokens are over threshold, qgrid throws `QuotaThresholdExceededError`.
- Log messages use `quota_threshold gate` with reasons such as `over_threshold`, `lookup_fail_open`, and `all_exceeded`.

OpenAI queue items keep an `excludedTokenIds` set so a token found over threshold for a request is not immediately reselected for that same queued request.
