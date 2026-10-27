/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import { sanitizeStderr } from "./diagnostics.mjs";
import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { processIdentity } from "./process-identity.mjs";
import { processAlive } from "./atomic-store.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

export class CodexAppServerClient {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.transport = "direct";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`codex app-server ${method} control request timed out.`);
        Object.assign(error, { code: "CONTROL_TIMEOUT" });
        reject(error);
      }, this.options.requestTimeoutMs ?? 60000);
      timer.unref();
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }, method
      });
      try { this.sendMessage({ id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      try { this.notificationHandler(/** @type {AppServerNotification} */ (message)); }
      catch (error) { this.handleExit(error); }
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true,
      detached: true
    });

    this.processExit = new Promise(resolve => { this.proc.once("exit", resolve); this.proc.once("error", resolve); });

    if (this.proc.pid) {
      this.options.onProcess?.({ appServerPid: this.proc.pid, appServerIdentity: null, appServerPgid: process.platform === "win32" ? null : this.proc.pid });
    }

    this.proc.stdout.on("end", () => this.handleExit(new Error("Codex output connection closed before a terminal result.")));
    this.proc.stdout.on("error", error => this.handleExit(error));
    this.proc.stdin.on("error", error => this.handleExit(error));
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = sanitizeStderr(this.stderr);
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
    if (this.proc.pid) this.options.onProcess?.({ appServerPid: this.proc.pid, appServerIdentity: processIdentity(this.proc.pid), appServerPgid: process.platform === "win32" ? null : this.proc.pid });
  }

  async waitForExit(ms) {
    let timer;
    try { await Promise.race([this.processExit, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
    finally { clearTimeout(timer); }
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.proc?.pid) {
      const pid = this.proc.pid;
      if (this.proc.exitCode === null && this.proc.signalCode === null) {
        try { terminateProcessTree(pid, { processGroup: process.platform !== "win32" }); } catch {}
      }
      await this.waitForExit(500);
      if (this.proc.exitCode === null && this.proc.signalCode === null) {
        try { terminateProcessTree(pid, { processGroup: process.platform !== "win32", signal: "SIGKILL" }); } catch {}
      }
      await this.waitForExit(500);
      this.readline?.close();
      let groupAlive = false;
      if (process.platform !== "win32") {
        try { process.kill(-pid, 0); groupAlive = true; } catch (error) { if (error.code !== "ESRCH") groupAlive = true; }
      }
      if (processAlive(pid) || groupAlive) throw Object.assign(new Error("Private runtime termination is unconfirmed; inspect partial changes and the recorded process IDs."), { code: "TERMINATION_UNCONFIRMED" });
      return;
    }

    this.readline?.close();
    await this.processExit;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }

  static async connect(cwd, options = {}) {
    options.signal?.throwIfAborted();
    const client = new CodexAppServerClient(cwd, options);
    let abortHandler;
    const aborted = new Promise((_, reject) => {
      abortHandler = () => reject(options.signal.reason ?? new Error("Runtime initialization cancelled."));
      if (options.signal?.aborted) abortHandler();
      else options.signal?.addEventListener("abort", abortHandler, { once: true });
    });
    try { await Promise.race([client.initialize(), aborted]); return client; }
    catch (error) {
      try { await client.close(); }
      catch (closeError) { if (closeError.code === "TERMINATION_UNCONFIRMED") throw closeError; }
      finally { options.onStderr?.(sanitizeStderr(client.stderr)); }
      throw error;
    }
    finally { options.signal?.removeEventListener("abort", abortHandler); }
  }
}
