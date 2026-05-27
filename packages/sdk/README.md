# @cartanova/qgrid-sdk (deprecated)

> **이 패키지는 deprecated되었습니다.** [`@cartanova/qgrid-ai-sdk`](https://www.npmjs.com/package/@cartanova/qgrid-ai-sdk)를 사용하세요.

## 마이그레이션

```diff
-import { queryQgrid } from "@cartanova/qgrid-sdk";
+import { generateText } from "ai";
+import { qgrid } from "@cartanova/qgrid-ai-sdk";

-const { data } = await queryQgrid({
-  system: "요약해주세요",
-  prompt: text,
-  model: "anthropic/claude-sonnet-4.6",
-});
+const { text } = await generateText({
+  model: qgrid("openai/gpt-5.4-mini"),
+  system: "요약해주세요",
+  prompt: text,
+});
```

새 SDK는 AI SDK v6 `LanguageModelV3` custom provider로 구현되어 `generateText`, `streamText`, tool-call, structured output을 모두 지원합니다.

자세한 사용법은 [`@cartanova/qgrid-ai-sdk` README](../ai-sdk/README.md)를 참조하세요.
