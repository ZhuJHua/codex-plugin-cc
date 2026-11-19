import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}

export function buildTaskPrompt(rootDir, request, { model, modelProvider }) {
  let guidance = "";
  let handoffStyle = "concise";
  if (modelProvider === "openai") {
    if (/^gpt-6\.2(?:-|$)/.test(model ?? "")) {
      guidance = "Proceed on reasonable, reversible assumptions within scope and state material assumptions in the handoff. Before handing back, check the result against the requested outcome and finish any remaining authorized steps. For code changes, reuse suitable repository patterns and preserve behavior outside the requested change.";
      handoffStyle = "self-contained";
    } else if (/^gpt-6(?:\.1)?(?:-|$)/.test(model ?? "")) {
      guidance = "Complete the work already authorized before asking about a remaining blocker. Run checks proportional to the change and broaden them when failures or unresolved risks warrant it.";
    }
  }
  const template = loadPromptTemplate(rootDir, "task").replace(/\r?\n$/, "");
  return interpolateTemplate(template, {
    TASK_REQUEST: request,
    TASK_GUIDANCE: guidance ? `\n\n${guidance}` : "",
    HANDOFF_STYLE: handoffStyle
  });
}
