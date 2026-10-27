// Test-only preload: simulate macOS workspace-write denying process inspection.
// Run with NODE_OPTIONS="--require=$PWD/tests/block-process-identity.cjs".
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = function(command, args, options) {
  if (process.platform === "darwin" && command === "/bin/ps" &&
      args?.[0] === "-p" && args.includes("lstart=") && args.includes("comm=")) {
    return { status: 1, signal: null, stdout: "", stderr: "ps: Operation not permitted (simulated sandbox)\n" };
  }
  // The real sandbox also blocks the leak check's process table. Exercise its
  // existing tracked-process fallback so failed baseline fixtures still exit.
  if (process.platform === "darwin" && command === "ps" && args?.[0] === "-axww") {
    return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync ps EPERM (simulated sandbox)"), { code: "EPERM" }) };
  }
  return spawnSync(command, args, options);
};
syncBuiltinESMExports();
