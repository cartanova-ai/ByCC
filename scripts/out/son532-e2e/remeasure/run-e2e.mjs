// SON-532 e2e — 민상님 실물 요청(1090711/1091748) 재현.
// 새 경로(프롬프트 계약 주입 → CC 텍스트 → 펜스 스트리핑)를 로컬 서버로 통과시켜
// 스키마 준수·성능을 실측하고, 사후 검토 가능하게 전 과정을 파일로 남긴다.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = new URL(".", import.meta.url).pathname;
const OUT = `${DIR}results`;
mkdirSync(OUT, { recursive: true });

const SERVER = "http://localhost:44900";
const MODEL = "anthropic/claude-sonnet-5";
const EFFORT = "low";
const schema = readFileSync(`${DIR}schema.json`, "utf8");
const required = JSON.parse(schema).required;

const CASES = [
  {
    name: "v1-1090711",
    note: "1090711 재현 — 구 structured(--json-schema) 요청과 동일 입력을 새 경로로",
    system: readFileSync(`${DIR}system-v1.txt`, "utf8"),
    prompt: readFileSync(`${DIR}prompt-v1.txt`, "utf8"),
    baseline: { id: 1090711, durationMs: 509408, inTok: 122532, outTok: 55098, costMicro: 1117375 },
  },
  {
    name: "v2-1091748",
    note: "1091748 재현 — 민상님 수동 주입분을 제거한 base system + 서버 자동 주입",
    system: readFileSync(`${DIR}system-v2-base.txt`, "utf8"),
    prompt: readFileSync(`${DIR}prompt-v2.txt`, "utf8"),
    baseline: { id: 1091748, durationMs: 57936, inTok: 18852, outTok: 6782, costMicro: 110412 },
  },
];

// 판정은 표준 Ajv Draft 2020-12 전체 검증 — 축약 검증(top-level required 만)은
// anyOf/oneOf 내부 위반을 놓쳐 4/4 오판을 냈다 (2차 검토 #3 정정).
import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);
const Ajv2020 = require2(
  "/Users/yoodongseon/Desktop/dev/qgrid/packages/api/node_modules/ajv/dist/2020",
).default;
const ajvValidate = new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(schema));

function classify(text) {
  const trimmed = text.trim();
  const fence = trimmed.startsWith("```") || trimmed.endsWith("```");
  let parsed;
  let syntax = "ok";
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    syntax = `fail: ${e.message.slice(0, 120)}`;
  }
  const keys = syntax === "ok" && parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
  const schemaValid = syntax === "ok" ? ajvValidate(parsed) : false;
  const schemaErrors = schemaValid
    ? []
    : (ajvValidate.errors ?? []).map((e) => `${e.instancePath}: ${e.message}`).slice(0, 12);
  return {
    syntax,
    schemaValid,
    schemaErrors,
    fenceResidue: fence,
    firstChar: text[0],
    lastChar: text[text.length - 1],
    startsWhitespace: /^\s/.test(text),
    missingRequired:
      syntax === "ok" && parsed && typeof parsed === "object"
        ? required.filter((k) => !Object.hasOwn(parsed, k))
        : required,
    extraTopLevelKeys: keys.filter((k) => !required.includes(k)),
    topLevelKeys: keys,
  };
}

function body(c) {
  // sonamu @api 규약: 파라미터는 { args: QueryInput } 로 감싼다
  return JSON.stringify({
    args: {
      prompt: c.prompt,
      system: c.system,
      model: MODEL,
      effort: EFFORT,
      jsonSchema: schema,
      projectName: "son532-e2e",
    },
  });
}

async function generate(c) {
  const t0 = Date.now();
  const res = await fetch(`${SERVER}/api/qgrid/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(c),
  });
  const wall = Date.now() - t0;
  if (!res.ok) return { transportError: `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`, wall };
  const d = await res.json();
  return { text: d.text, usage: d.usage, costUsd: d.costUsd, durationMs: d.durationMs, ttftMs: d.ttftMs, finishReason: d.finishReason, model: d.model, wall };
}

async function stream(c) {
  const t0 = Date.now();
  const prep = await fetch(`${SERVER}/api/qgrid/prepareStream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(c),
  });
  if (!prep.ok) return { transportError: `prepare HTTP ${prep.status}: ${(await prep.text()).slice(0, 500)}`, wall: Date.now() - t0 };
  const { streamId } = await prep.json();
  const res = await fetch(`${SERVER}/api/qgrid/queryStream?streamId=${streamId}`);
  if (!res.ok || !res.body) return { transportError: `stream HTTP ${res.status}`, wall: Date.now() - t0 };

  let deltaText = "";
  let deltaCount = 0;
  let firstDeltaAt = null;
  let done;
  let errMsg;
  let event = "";
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).trimEnd();
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (event === "delta") {
        firstDeltaAt ??= Date.now();
        deltaCount += 1;
        deltaText += JSON.parse(payload).text;
      } else if (event === "done") done = JSON.parse(payload);
      else if (event === "error") errMsg = JSON.parse(payload).message;
    }
  }
  const wall = Date.now() - t0;
  if (errMsg) return { transportError: `stream error: ${errMsg}`, wall, deltaText, deltaCount };
  return {
    text: done?.text,
    deltaText,
    deltaCount,
    firstDeltaMs: firstDeltaAt ? firstDeltaAt - t0 : null,
    usage: done?.usage,
    costUsd: done?.costUsd,
    durationMs: done?.durationMs,
    ttftMs: done?.ttftMs,
    finishReason: done?.finishReason,
    model: done?.model,
    wall,
  };
}

const summary = [];
for (const c of CASES) {
  for (const mode of ["generate", "stream"]) {
    const label = `${c.name}-${mode}`;
    console.log(`[${new Date().toISOString()}] START ${label}`);
    const r = mode === "generate" ? await generate(c) : await stream(c);
    const record = {
      label,
      note: c.note,
      model: MODEL,
      effort: EFFORT,
      baseline: c.baseline,
      transportError: r.transportError,
      wallMs: r.wall,
      serverDurationMs: r.durationMs,
      ttftMs: r.ttftMs,
      firstDeltaMs: r.firstDeltaMs,
      deltaCount: r.deltaCount,
      finishReason: r.finishReason,
      servedModel: r.model,
      usage: r.usage,
      costUsd: r.costUsd,
      responseChars: r.text?.length,
      classification: r.text !== undefined ? classify(r.text) : undefined,
      deltaDoneMismatch:
        mode === "stream" && r.text !== undefined ? r.deltaText !== r.text : undefined,
    };
    appendFileSync(`${OUT}/records.jsonl`, `${JSON.stringify(record)}\n`);
    if (r.text !== undefined) writeFileSync(`${OUT}/${label}.response.json`, r.text);
    if (mode === "stream" && r.deltaText !== undefined)
      writeFileSync(`${OUT}/${label}.deltas.txt`, r.deltaText);
    summary.push(record);
    console.log(
      `[${new Date().toISOString()}] DONE ${label}`,
      r.transportError
        ? `transport✗ ${r.transportError.slice(0, 120)}`
        : `syntax=${record.classification.syntax} schemaValid=${record.classification.schemaValid} errs=${record.classification.schemaErrors.length} fence=${record.classification.fenceResidue} wall=${r.wall}ms out=${r.usage?.output_tokens} cost=$${r.costUsd?.toFixed?.(4)}`,
    );
  }
}
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log("ALL DONE");
