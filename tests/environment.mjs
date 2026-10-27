import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLAUDE_VARIABLES = [
  "CODEX_COMPANION_SESSION_ID", "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CLAUDE_PLUGIN_DATA", "CLAUDE_ENV_FILE", "CLAUDE_PLUGIN_ROOT",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT", "CODEX_COMPANION_APP_SERVER_PID_FILE",
  "CODEX_COMPANION_APP_SERVER_LOG_FILE"
];

export function testEnvironment(overrides = {}, base = process.env) {
  const env = { ...base };
  for (const name of CLAUDE_VARIABLES) delete env[name];
  return { ...env, CLAUDE_PLUGIN_DATA: testDataRoot, ...overrides };
}

const testDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-env-"));

const inherited = Object.fromEntries(CLAUDE_VARIABLES.map(name => [name, process.env[name]]));
for (const name of CLAUDE_VARIABLES) delete process.env[name];
process.env.CLAUDE_PLUGIN_DATA = testDataRoot;
process.once("exit", () => {
  fs.rmSync(testDataRoot, { recursive: true, force: true });
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
