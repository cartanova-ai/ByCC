#!/usr/bin/env bash
#
# dev0에서 qgrid가 사용한 Anthropic structured-output 호출을 그대로 다시 실행하고,
# Claude Code의 가공 전 stream-json 이벤트를 보존한다.
#
# 사용:
#   ./capture-dev0-anthropic-structured-output.sh REQUEST_ID SCHEMA_JSON [OUTPUT_JSONL]
#
# 전제:
#   - dev0의 cartanova 계정으로 실행
#   - REQUEST_ID는 request_logs의 기존 Anthropic 요청
#   - SCHEMA_JSON은 해당 요청에 사용한 JSON Schema
#
# 이 스크립트는 request_logs나 deti 데이터를 변경하지 않는다. PM2 설정에서 DB 접속 정보를
# 메모리로만 읽고, 해당 요청의 prompt/model/effort/token을 조회한 뒤 qgrid와 같은 Claude CLI
# 인자·환경으로 새 세션을 한 번 실행한다. OAuth token은 출력하거나 파일로 남기지 않는다.
#
# 진단 기본 제한은 360초다(QGRID_REPRO_TIMEOUT_SECONDS로 변경 가능). 실제 qgrid 제한 240초보다
# 길게 둔 이유는 240초를 넘긴 retry의 최종 result까지 캡처하기 위해서다.

set -euo pipefail

REQUEST_ID="${1:-}"
SCHEMA_PATH="${2:-}"
OUTPUT_PATH="${3:-}"
CAPTURE_TIMEOUT_SECONDS="${QGRID_REPRO_TIMEOUT_SECONDS:-360}"

if [[ ! "$REQUEST_ID" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 REQUEST_ID SCHEMA_JSON [OUTPUT_JSONL]" >&2
  exit 2
fi
if [[ ! -f "$SCHEMA_PATH" ]]; then
  echo "schema file not found: $SCHEMA_PATH" >&2
  exit 2
fi
if [[ ! "$CAPTURE_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "QGRID_REPRO_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 2
fi

PM2_CONFIG="/home/cartanova/qgrid-pm2/ecosystem.config.cjs"
CLAUDE_BIN="/home/cartanova/.local/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude"
CLAUDE_CWD="/tmp/qgrid-anthropic"
CONFIG_BASE="/tmp/qgrid-anthropic-config"

if [[ "$(hostname)" != "dev0" ]]; then
  echo "this script must run on dev0" >&2
  exit 2
fi
if [[ ! -x "$CLAUDE_BIN" ]]; then
  echo "Claude Code binary not found: $CLAUDE_BIN" >&2
  exit 2
fi

# PM2와 같은 DB/TMPDIR 환경을 사용한다. 값은 eval로만 소비하고 stdout에 노출하지 않는다.
eval "$(
  node - "$PM2_CONFIG" <<'NODE'
const configPath = process.argv[2];
const config = require(configPath);
const app = config.apps.find((entry) => entry.name === "qgrid");
if (!app?.env) throw new Error("qgrid PM2 env not found");
for (const key of [
  "QGRID_DB_HOST",
  "QGRID_DB_PORT",
  "QGRID_DB_USER",
  "QGRID_DB_PASSWORD",
  "QGRID_DB_NAME",
  "TMPDIR",
]) {
  const value = app.env[key];
  if (value === undefined) throw new Error(`missing PM2 env: ${key}`);
  process.stdout.write(`export ${key}=${JSON.stringify(String(value))}\n`);
}
NODE
)"

ROW="$(
  PGPASSWORD="$QGRID_DB_PASSWORD" psql -X -A -t -F $'\t' \
    -h "$QGRID_DB_HOST" \
    -p "$QGRID_DB_PORT" \
    -U "$QGRID_DB_USER" \
    -d "$QGRID_DB_NAME" \
    -c "
      SELECT
        translate(encode(convert_to(r.system_prompt, 'UTF8'), 'base64'), E'\n', ''),
        translate(encode(convert_to(r.user_prompt, 'UTF8'), 'base64'), E'\n', ''),
        r.model_name,
        COALESCE(r.effort, 'low'),
        t.id,
        translate(encode(convert_to(t.credentials->>'accessToken', 'UTF8'), 'base64'), E'\n', '')
      FROM request_logs r
      JOIN tokens t ON t.name = r.token_name
      WHERE r.id = $REQUEST_ID
        AND t.provider = 'anthropic';
    "
)"

if [[ -z "$ROW" ]]; then
  echo "Anthropic request/token not found: request_id=$REQUEST_ID" >&2
  exit 1
fi

IFS=$'\t' read -r SYSTEM_B64 USER_B64 MODEL EFFORT TOKEN_ID ACCESS_TOKEN_B64 <<<"$ROW"
MODEL="${MODEL##*/}"
ACCESS_TOKEN="$(printf '%s' "$ACCESS_TOKEN_B64" | base64 --decode)"
unset ACCESS_TOKEN_B64 ROW

WORK_DIR="$(mktemp -d /tmp/qgrid-structured-repro.XXXXXX)"
cleanup() {
  unset ACCESS_TOKEN CLAUDE_CODE_OAUTH_TOKEN
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

SYSTEM_PATH="$WORK_DIR/system.txt"
USER_PATH="$WORK_DIR/user.txt"
INPUT_PATH="$WORK_DIR/input.jsonl"
STDERR_PATH="${OUTPUT_PATH:-$PWD/dev0-structured-output-${REQUEST_ID}-$(date +%Y%m%d-%H%M%S).jsonl}.stderr"
if [[ -z "$OUTPUT_PATH" ]]; then
  OUTPUT_PATH="${STDERR_PATH%.stderr}"
fi

printf '%s' "$SYSTEM_B64" | base64 --decode >"$SYSTEM_PATH"
printf '%s' "$USER_B64" | base64 --decode >"$USER_PATH"
unset SYSTEM_B64 USER_B64

SESSION_ID="$(cat /proc/sys/kernel/random/uuid)"
node - "$USER_PATH" "$SESSION_ID" >"$INPUT_PATH" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const userPath = process.argv[2];
const sessionId = process.argv[3];
const line = {
  type: "user",
  message: {
    role: "user",
    content: [{ type: "text", text: fs.readFileSync(userPath, "utf8") }],
  },
  session_id: sessionId,
  uuid: crypto.randomUUID(),
  parent_tool_use_id: null,
};
process.stdout.write(`${JSON.stringify(line)}\n`);
NODE

mkdir -p "$CLAUDE_CWD/.claude" "$CONFIG_BASE/$TOKEN_ID"
printf '{}\n' >"$CLAUDE_CWD/.claude/settings.json"
printf '{}\n' >"$CONFIG_BASE/$TOKEN_ID/.claude.json"
printf '{}\n' >"$CONFIG_BASE/$TOKEN_ID/settings.json"

SCHEMA="$(<"$SCHEMA_PATH")"
SYSTEM="$(<"$SYSTEM_PATH")"

ARGS=(
  -p
  --tools ""
  --allowed-tools StructuredOutput
  --disallowedTools Monitor PushNotification RemoteTrigger
  --input-format stream-json
  --output-format stream-json
  --verbose
  --permission-mode bypassPermissions
  --setting-sources project
  --model "$MODEL"
  --system-prompt "$SYSTEM"
  --effort "$EFFORT"
  --disable-slash-commands
  --session-id "$SESSION_ID"
  --json-schema "$SCHEMA"
)

echo "[capture] request=$REQUEST_ID model=$MODEL effort=$EFFORT token_id=$TOKEN_ID"
echo "[capture] claude=$("$CLAUDE_BIN" --version)"
echo "[capture] diagnostic_timeout=${CAPTURE_TIMEOUT_SECONDS}s (qgrid production timeout=240s)"
echo "[capture] raw=$OUTPUT_PATH"
echo "[capture] stderr=$STDERR_PATH"

set +e
timeout --signal=TERM "${CAPTURE_TIMEOUT_SECONDS}s" env \
  -u MAX_STRUCTURED_OUTPUT_RETRIES \
  PATH="/home/cartanova/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  TMPDIR="$TMPDIR" \
  CLAUDE_CODE_OAUTH_TOKEN="$ACCESS_TOKEN" \
  CLAUDE_CONFIG_DIR="$CONFIG_BASE/$TOKEN_ID" \
  CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
  CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 \
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 \
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 \
  CLAUDE_CODE_DISABLE_WORKFLOWS=1 \
  CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
  "$CLAUDE_BIN" "${ARGS[@]}" \
  <"$INPUT_PATH" \
  >"$OUTPUT_PATH" \
  2>"$STDERR_PATH"
CLAUDE_EXIT=$?
set -e

unset ACCESS_TOKEN CLAUDE_CODE_OAUTH_TOKEN SCHEMA SYSTEM

node - "$OUTPUT_PATH" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const lines = fs
  .readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

const attempts = [];
const rejections = [];
let result;

for (const event of lines) {
  if (event.type === "assistant") {
    for (const part of event.message?.content ?? []) {
      if (part?.type === "tool_use" && part.name === "StructuredOutput") {
        attempts.push(part.input);
      }
    }
  }
  if (event.type === "user") {
    for (const part of event.message?.content ?? []) {
      if (part?.type === "tool_result" && part.is_error === true) {
        rejections.push(String(part.content ?? ""));
      }
    }
  }
  if (event.type === "result") result = event;
}

const objectKeys = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
const json = (value) => JSON.stringify(value);

console.log(`[summary] StructuredOutput attempts=${attempts.length} rejections=${rejections.length}`);
attempts.forEach((attempt, index) => {
  console.log(
    `[summary] attempt#${index + 1} keys=${JSON.stringify(objectKeys(attempt))} bytes=${Buffer.byteLength(json(attempt) ?? "", "utf8")}`,
  );
});
rejections.forEach((message, index) => {
  console.log(`[summary] rejection#${index + 1}=${JSON.stringify(message.slice(0, 240))}`);
});

if (!result) {
  console.log("[summary] result event missing");
  process.exitCode = 1;
} else {
  console.log(
    `[summary] result subtype=${result.subtype ?? "(none)"} structured_output=${result.structured_output !== undefined}`,
  );
  console.log(
    `[summary] final keys=${JSON.stringify(objectKeys(result.structured_output))} bytes=${Buffer.byteLength(json(result.structured_output) ?? "", "utf8")}`,
  );
  if (attempts.length > 0 && result.structured_output !== undefined) {
    console.log(`[summary] first_equals_final=${json(attempts[0]) === json(result.structured_output)}`);
    console.log(
      `[summary] last_equals_final=${json(attempts.at(-1)) === json(result.structured_output)}`,
    );
  }
}
NODE

exit "$CLAUDE_EXIT"
