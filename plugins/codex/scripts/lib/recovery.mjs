import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../codex-companion.mjs", import.meta.url));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function recoveryCommand(job) {
  const request = job.request ?? {};
  const review = request.kind === "review" || job.jobClass === "review";
  const command = review ? job.kind === "adversarial-review" ? "adversarial-review" : "review" : "task";
  const args = [process.execPath, runner, command, "--cwd", job.workspaceRoot];
  if (!review) {
    if (!job.threadId) return null;
    args.push("--thread", job.threadId);
    if (request.fullAccess) args.push("--full-access");
    else if (request.network) args.push("--network");
    else if (job.write) args.push("--write");
  } else {
    if (request.base) args.push("--base", request.base);
    if (request.scope) args.push("--scope", request.scope);
  }
  const model = request.model ?? request.requestedModel ?? job.requested?.model ?? job.resolved?.model;
  const effort = request.effort ?? request.requestedEffort ?? job.requested?.effort ?? job.resolved?.effort;
  if (model) args.push("--model", model);
  if (effort && command !== "review") args.push("--effort", effort);
  if (!review) args.push("--", "Continue after inspecting existing changes and partial results.");
  else if (request.focusText) args.push("--", request.focusText);
  return args.map(quote).join(" ");
}


export function jobActions(job, jobFile) {
  const args = [process.execPath, runner];
  const prefix = job.pluginDataRoot ? `env ${quote(`CLAUDE_PLUGIN_DATA=${job.pluginDataRoot}`)} ` : "";
  const command = action => prefix + [...args, action, job.id, "--cwd", job.workspaceRoot].map(quote).join(" ");
  return `Use /codex:await ${job.id} or /codex:cancel ${job.id}. CLI await: ${command("await")}. CLI cancel: ${command("cancel")}. Record: ${jobFile}`;
}
