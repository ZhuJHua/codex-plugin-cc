import "./environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { requireProcessIdentity, run } from "./helpers.mjs";
import { processIdentity } from "../plugins/codex/scripts/lib/process-identity.mjs";

test("process identity prerequisite probes the OS and explains unavailable inspection", () => {
  const reasons = [];
  const available = processIdentity(process.pid) !== null;
  assert.equal(requireProcessIdentity({ skip: reason => reasons.push(reason) }), available);
  assert.deepEqual(reasons, available ? [] : ["process identity unavailable (ps blocked by sandbox or OS inspection restricted)"]);
});

test("test preload denies macOS process inspection and preserves other subprocesses", { skip: process.platform !== "darwin" }, () => {
  const preload = fileURLToPath(new URL("./block-process-identity.cjs", import.meta.url));
  const identityModule = new URL("../plugins/codex/scripts/lib/process-identity.mjs", import.meta.url).href;
  const result = run(process.execPath, ["--require", preload, "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { spawnSync } from "node:child_process";
    import { processIdentity } from ${JSON.stringify(identityModule)};
    assert.equal(processIdentity(process.pid), null);
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write('available')"], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "available");
  `]);
  assert.equal(result.status, 0, result.stderr);
});
