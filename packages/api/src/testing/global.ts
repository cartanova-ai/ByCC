import dotenv from "dotenv";

dotenv.config();

type SonamuGlobalSetupModule = {
  setup: () => Promise<(() => Promise<void>) | void>;
};

// sonamu/test 의 barrel export 는 bootstrap.js 를 함께 로드하고, bootstrap.js 는 top-level 에서
// vitest 를 import 한다. Vitest 4 globalSetup 컨텍스트에서는 이 import 가 internal state 에러를
// 만들기 때문에 global-setup.js 만 직접 로드한다.
export async function setup(): Promise<(() => Promise<void>) | void> {
  const globalSetupUrl = new URL(
    "../../node_modules/sonamu/dist/testing/global-setup.js",
    import.meta.url,
  );
  const { setup: sonamuSetup } = (await import(globalSetupUrl.href)) as SonamuGlobalSetupModule;

  return sonamuSetup();
}
