# Repository Toolchain

- The root `mise.toml` resolves automatically from every repository subdirectory.
- Set up tools with `mise install --locked node npm:pnpm`.
- Run project tasks with `mise run <task>`.
- Run raw or package-local `node`, `npm`, `npx`, or `pnpm` commands with `mise exec -- <command>`.
- Never invoke the host Node.js toolchain directly. Commands intentionally run inside publication containers, if any, are exempt.
