// Which runner drives an agent on each second backend. The one file that ties a backend kind to a provider's CLI.
import { CODEX_CLI_VERSION, CODEX_RUNNER, projectInstructions } from "./codex-cli.js";
import type { BackendRunner, SecondBackendKind } from "./index.js";

export const BACKEND_RUNNERS: Record<SecondBackendKind, BackendRunner> = {
  responses: { version: CODEX_CLI_VERSION, script: CODEX_RUNNER, workspaceFiles: projectInstructions },
};
