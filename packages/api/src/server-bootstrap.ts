import { Sonamu } from "sonamu";

import { runRequiredMigrations } from "./startup-migrations";

type BootstrapSteps = {
  init: () => Promise<void>;
  migrate: () => Promise<void>;
  listen: () => Promise<unknown>;
};

export async function bootstrapServer(
  steps: BootstrapSteps = {
    init: () => Sonamu.init(),
    migrate: runRequiredMigrations,
    listen: () => Sonamu.createServer(),
  },
): Promise<void> {
  await steps.init();
  await steps.migrate();
  await steps.listen();
}
