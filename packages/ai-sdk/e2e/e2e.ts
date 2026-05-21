/**
 * @cartanova/qgrid-ai-sdk E2E Test Suite
 *
 * 실제 qgrid 서버(localhost:44900)에 요청을 보내는 통합 테스트.
 * 서버가 떠 있어야 합니다.
 *
 * 사용법: pnpm --filter @cartanova/qgrid-ai-sdk e2e
 */
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { qgrid } from "../src/index";

const SERVER = process.env.QGRID_URL ?? "http://localhost:44900";
const MODEL = (process.env.QGRID_MODEL ?? "openai/gpt-5.5") as Parameters<typeof qgrid>[0];

// ── Test runner ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(e as Error).message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ── Mock data ──────────────────────────────────────────────────────

const WEATHER_DB: Record<string, { temperature: number; condition: string }> = {
  Seoul: { temperature: 22, condition: "sunny" },
  Busan: { temperature: 26, condition: "partly cloudy" },
  Daegu: { temperature: 28, condition: "hot" },
  Jeju: { temperature: 24, condition: "rainy" },
};

const RESTAURANT_DB: Record<string, Array<{ id: string; name: string; cuisine: string; rating: number }>> = {
  Daegu: [
    { id: "r6", name: "대구 막창", cuisine: "BBQ", rating: 4.4 },
    { id: "r7", name: "안지랑 곱창", cuisine: "Korean", rating: 4.7 },
  ],
  Busan: [
    { id: "r3", name: "해운대 회센터", cuisine: "Seafood", rating: 4.7 },
    { id: "r4", name: "서면 돼지국밥", cuisine: "Korean", rating: 4.9 },
  ],
};

// ── Tests ──────────────────────────────────────────────────────────

async function main() {
  console.log(`\n@cartanova/qgrid-ai-sdk E2E (server: ${SERVER}, model: ${MODEL})\n`);

  // 1. 단순 텍스트
  await test("simple text generation", async () => {
    const result = await generateText({
      model: qgrid(MODEL),
      prompt: 'Respond with exactly: "hello-e2e"',
    });
    assert(result.text.length > 0, "empty response");
    assert(result.finishReason === "stop", `unexpected finishReason: ${result.finishReason}`);
    assert(result.usage?.inputTokens, "missing input token usage");
    console.log(`    text="${result.text.slice(0, 80)}"`);
  });

  // 2. system prompt
  await test("system prompt", async () => {
    const result = await generateText({
      model: qgrid(MODEL),
      system: "You must reply in exactly one word.",
      prompt: "What color is the sky?",
    });
    assert(result.text.length > 0, "empty response");
    console.log(`    text="${result.text.slice(0, 80)}"`);
  });

  // 3. single tool call
  await test("single tool call", async () => {
    const result = await generateText({
      model: qgrid(MODEL),
      prompt: "What is the weather in Seoul? Use the getWeather tool.",
      tools: {
        getWeather: tool({
          description: "Get current weather for a city",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => WEATHER_DB[city] ?? { temperature: 0, condition: "unknown" },
        }),
      },
      stopWhen: stepCountIs(3),
    });
    assert(result.steps.length >= 2, `expected at least 2 steps, got ${result.steps.length}`);
    assert(result.steps[0].toolCalls.length > 0, "step 0 should have tool calls");
    assert(result.finishReason === "stop", `unexpected finishReason: ${result.finishReason}`);
    assert(result.text.length > 0, "empty final text");
    console.log(`    steps=${result.steps.length}, text="${result.text.slice(0, 80)}"`);
  });

  // 4. multi-tool, multi-step
  await test("multi-tool multi-step", async () => {
    const result = await generateText({
      model: qgrid(MODEL),
      prompt:
        "Step 1: Use the getWeather tool for Seoul, Busan, and Daegu. Step 2: Identify the warmest city. Step 3: Use the searchRestaurants tool for that warmest city. Then give a final summary.",
      tools: {
        getWeather: tool({
          description: "Get weather for a city (English name: Seoul, Busan, Daegu, Jeju)",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => WEATHER_DB[city] ?? { temperature: 0, condition: "unknown" },
        }),
        searchRestaurants: tool({
          description: "Search restaurants in a city",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => RESTAURANT_DB[city] ?? [],
        }),
      },
      stopWhen: stepCountIs(5),
    });

    const allToolCalls = result.steps.flatMap((s) => s.toolCalls);
    const weatherCalls = allToolCalls.filter((tc) => tc.toolName === "getWeather");
    const restaurantCalls = allToolCalls.filter((tc) => tc.toolName === "searchRestaurants");
    const toolNames = [...new Set(allToolCalls.map((tc) => tc.toolName))];

    assert(allToolCalls.length >= 2, `expected at least 2 total tool calls, got ${allToolCalls.length}`);
    assert(weatherCalls.length >= 2, `expected at least 2 getWeather calls, got ${weatherCalls.length}`);
    assert(result.steps.length >= 2, `expected at least 2 steps, got ${result.steps.length}`);
    assert(result.finishReason === "stop", `unexpected finishReason: ${result.finishReason}`);
    console.log(
      `    steps=${result.steps.length}, tools=${toolNames.join(",")}, weatherCalls=${weatherCalls.length}, restaurantCalls=${restaurantCalls.length}`,
    );
    console.log(`    text="${result.text.slice(0, 100)}"`);
  });

  // 5. auto lifecycle — run이 DB에 기록되었는지 검증
  await test("auto lifecycle (createRun → appendStep → finishRun)", async () => {
    const result = await generateText({
      model: qgrid(MODEL),
      prompt: "What is the weather in Busan? Use the getWeather tool.",
      tools: {
        getWeather: tool({
          description: "Get weather for a city",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => WEATHER_DB[city] ?? { temperature: 0, condition: "unknown" },
        }),
      },
      stopWhen: stepCountIs(3),
    });
    assert(result.finishReason === "stop", `unexpected finishReason: ${result.finishReason}`);

    // fire-and-forget appendStep 완료 대기
    await new Promise((r) => setTimeout(r, 1500));

    // 가장 최근 request_log 조회
    const logRes = await fetch(
      `${SERVER}/api/requestLog/findMany?subset=A&rawParams%5Bnum%5D=1&rawParams%5Bpage%5D=1&rawParams%5BorderBy%5D=id-desc`,
    );
    const logData = (await logRes.json()) as { rows: Array<Record<string, unknown>> };
    const log = logData.rows[0];
    assert(log, "no request_log found");
    assert(log.status === "succeeded", `expected status=succeeded, got ${log.status}`);
    assert((log.input_tokens as number) > 0, "input_tokens should be > 0");
    assert((log.tool_call_count as number) >= 1, `expected tool_call_count >= 1, got ${log.tool_call_count}`);
    assert((log.response as string)?.length > 0, "response should not be empty");

    // steps 검증
    const stepsRes = await fetch(
      `${SERVER}/api/requestLogStep/findMany?subset=A&rawParams%5Bnum%5D=50&rawParams%5Bpage%5D=1&rawParams%5Brequest_log_id%5D=${log.id}&rawParams%5BorderBy%5D=id-asc`,
    );
    const stepsData = (await stepsRes.json()) as { rows: Array<Record<string, unknown>>; total: number };
    const generateSteps = stepsData.rows.filter((s) => s.type === "generate");
    const toolSteps = stepsData.rows.filter((s) => s.type === "tool_call");

    assert(generateSteps.length >= 2, `expected at least 2 generate steps, got ${generateSteps.length}`);
    assert(toolSteps.length >= 1, `expected at least 1 tool_call step, got ${toolSteps.length}`);

    console.log(
      `    requestLogId=${log.id}, status=${log.status}, tool_call_count=${log.tool_call_count}, steps=${stepsData.total}`,
    );
  });

  // ── Summary ──────────────────────────────────────────────────────

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("E2E failed:", e);
  process.exit(1);
});
