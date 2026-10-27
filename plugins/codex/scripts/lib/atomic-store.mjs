import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Cannot read state ${file}: ${error.message}`);
  }
}

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function validOwner(owner) {
  return owner && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.token === "string" && owner.token;
}

function recoverAbandonedLock(directory, observed) {
  const generation = crypto.createHash("sha256").update(observed.token).digest("hex");
  const reaper = path.join(directory, `reap-${generation}`);
  const nonce = crypto.randomUUID();
  try { fs.mkdirSync(reaper); }
  catch (error) {
    if (error.code === "ENOENT") return false;
    if (error.code !== "EEXIST") throw error;
    let owner;
    const pending = `Abandoned lock recovery has initializing, missing or unreadable reaper ownership; inspect ${reaper} before removing it.`;
    try {
      const source = fs.readFileSync(path.join(reaper, "owner.json"), "utf8");
      try { owner = JSON.parse(source); } catch { return pending; }
    } catch (readError) { if (readError.code === "ENOENT") return pending; throw readError; }
    if (!validOwner(owner) || !processAlive(owner.pid)) {
      throw new Error(`Abandoned lock recovery has corrupt or dead reaper ownership; inspect ${reaper} before removing it.`);
    }
    return false;
  }
  // No recursive mkdir or atomicJson here: either could recreate a lock that
  // its owner just retired after this contender observed an older generation.
  try { fs.writeFileSync(path.join(reaper, "owner.json"), JSON.stringify({ pid: process.pid, token: nonce }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const current = readJson(path.join(directory, "owner.json"), null);
  if (!validOwner(current) || current.token !== observed.token || processAlive(current.pid)) {
    // Leave this harmless stale-generation child for the current lock owner's
    // normal retirement. Cleaning via the shared path could affect a later
    // directory generation after another rename, so never recursively remove it.
    return false;
  }
  // Only one reaper can own this generation. All stale contenders must re-read
  // the root token before renaming, so they cannot retire a replacement owner.
  const retired = `${directory}.abandoned.${nonce}`;
  fs.renameSync(directory, retired);
  fs.rmSync(retired, { recursive: true, force: true });
  return true;
}

// Fully initialized lock directories are published atomically. Recovery has its
// own generation-qualified mutex, so stale snapshots cannot steal a newer lock.
export function withFileLock(directory, fn, timeoutMs = 10000) {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const token = crypto.randomUUID();
  const candidate = `${directory}.${process.pid}.${token}`;
  fs.mkdirSync(candidate);
  atomicJson(path.join(candidate, "owner.json"), { pid: process.pid, token });
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (fs.existsSync(directory)) {
        const owner = readJson(path.join(directory, "owner.json"), null);
        let recoveryPending = null;
        if (owner && !validOwner(owner)) {
          throw new Error(`State lock has corrupt ownership data: ${directory}`);
        }
        if (owner && !processAlive(owner.pid)) {
          const recovery = recoverAbandonedLock(directory, owner);
          if (recovery === true) continue;
          if (typeof recovery === "string") recoveryPending = recovery;
        }
        if (Date.now() >= deadline) throw new Error(recoveryPending ?? `${owner ? "State lock is busy" : "State lock has missing ownership data"}: ${directory}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      try { fs.renameSync(candidate, directory); break; }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
        if (Date.now() >= deadline) throw new Error(`State lock is busy: ${directory}`);
      }
    }
    try { return fn(); }
    finally {
      const owner = readJson(path.join(directory, "owner.json"), null);
      if (owner?.token === token) {
        // Removing owner.json in place would expose an empty shared directory
        // which rename() could replace before the releasing process finishes.
        const retired = `${directory}.released.${token}`;
        fs.renameSync(directory, retired);
        fs.rmSync(retired, { recursive: true, force: true });
      }
    }
  } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
}
