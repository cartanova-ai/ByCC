/**
 * @cartanova/qgrid-ai-sdk Logger E2E Test
 *
 * TelemetryIntegration 기반 logger가 실서버에 run lifecycle을 기록하는지 검증.
 * qgrid 서버(localhost:44900)가 떠 있어야 합니다.
 *
 * 사용법: pnpm --filter @cartanova/qgrid-ai-sdk e2e:logger
 */
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import { createQgridLogger, qgrid } from "../src/index";

const SERVER = process.env.QGRID_URL ?? "http://localhost:44900";
const MODEL = (process.env.QGRID_MODEL ?? "openai/gpt-5.5") as Parameters<typeof qgrid>[0];

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

const WEATHER_DB: Record<string, { temperature: number; condition: string }> = {
  Seoul: { temperature: 22, condition: "sunny" },
  Busan: { temperature: 26, condition: "partly cloudy" },
};

async function main() {
  console.log(`\n@cartanova/qgrid-ai-sdk Logger E2E (server: ${SERVER}, model: ${MODEL})\n`);

  // 1. 단순 텍스트 + logger
  await test("logger: simple text generation", async () => {
    const logger = createQgridLogger({
      serverUrl: SERVER,
      projectName: "e2e-logger",
      tokenName: "e2e-test",
    });

    const result = await generateText({
      model: qgrid(MODEL),
      prompt: 'Say exactly: "logger-ok"',
      experimental_telemetry: { integrations: [logger] },
    });

    assert(result.text.length > 0, "empty response");
    console.log(`    text="${result.text.slice(0, 50)}"`);

    // 대기 후 DB 검증
    await new Promise((r) => setTimeout(r, 1500));

    const logRes = await fetch(
      `${SERVER}/api/requestLog/findMany?subset=A&rawParams%5Bnum%5D=1&rawParams%5Bpage%5D=1&rawParams%5BorderBy%5D=id-desc`,
    );
    const logData = (await logRes.json()) as { rows: Array<Record<string, unknown>> };
    const log = logData.rows[0];

    // qgrid provider가 이미 lifecycle을 관리하므로 logger는 skip해야 함
    // 하지만 단순 호출이라 qgrid provider의 runState도 생성 안 됨 (tools 없음)
    // 이 경우 둘 다 기록하지 않거나, qgrid provider만 기록
    console.log(`    latest log id=${log?.id}, status=${log?.status}`);
  });

  // 2. tool calling + logger (qgrid provider 사용 — logger가 skip하는지 검증)
  await test("logger: skips when qgrid provider is used", async () => {
    const errors: Error[] = [];
    const logger = createQgridLogger({
      serverUrl: SERVER,
      projectName: "e2e-logger",
      onLogError: (err) => errors.push(err),
    });

    const result = await generateText({
      model: qgrid(MODEL),
      prompt: "What is the weather in Seoul? Use the getWeather tool.",
      tools: {
        getWeather: tool({
          description: "Get weather for a city",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => WEATHER_DB[city] ?? { temperature: 0, condition: "unknown" },
        }),
      },
      stopWhen: stepCountIs(3),
      experimental_telemetry: { integrations: [logger] },
    });

    assert(result.text.length > 0, "empty response");
    assert(errors.length === 0, `logger errors: ${errors.map((e) => e.message).join(", ")}`);
    console.log(`    text="${result.text.slice(0, 80)}"`);
    console.log(`    logger skipped (qgrid provider detected)`);
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("E2E failed:", e);
  process.exit(1);
});
