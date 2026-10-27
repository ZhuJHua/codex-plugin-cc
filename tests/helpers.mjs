import { testEnvironment } from "./environment.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { cleanupCoordination, registerTestRoot, cleanupTestProcesses } from "./cleanup.mjs";
import { after } from "node:test";
import { spawnSyncTestProcess as spawnSync } from "./cleanup.mjs";
import { processIdentity } from "../plugins/codex/scripts/lib/process-identity.mjs";

export function requireProcessIdentity(t) {
  if (processIdentity(process.pid) !== null) return true;
  t.skip("process identity unavailable (ps blocked by sandbox or OS inspection restricted)");
  return false;
}

const temporaryDirectories = new Set();
after(async () => {
  const { resolveStateDir } = await import("../plugins/codex/scripts/lib/state.mjs");
  const { stopOwnedProcesses } = await import("../plugins/codex/scripts/lib/job-lifecycle.mjs");
  for (const directory of temporaryDirectories) {
    const stateDir = resolveStateDir(directory);
    const jobsDir = path.join(stateDir, "jobs");
    if (fs.existsSync(jobsDir)) for (const file of fs.readdirSync(jobsDir).filter(file => file.endsWith(".json"))) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(jobsDir, file), "utf8"));
        if (job.runtimeKind === "private" && (["queued", "running"].includes(job.status) || job.terminationUnconfirmed)) stopOwnedProcesses(job, "SIGKILL");
      } catch {}
    }
    cleanupCoordination(directory, path.join(directory, "codex-home"));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  await cleanupTestProcesses();
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

export function makeTempDir(prefix = "codex-plugin-test-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  registerTestRoot(directory);
  return directory;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? testEnvironment(),
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout ?? 35000,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
