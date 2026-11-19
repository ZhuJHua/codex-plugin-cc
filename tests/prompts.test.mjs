import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildTaskPrompt, interpolateTemplate, loadPromptTemplate } from "../plugins/codex/scripts/lib/prompts.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/codex");

test("bundled prompt placeholders match their runtime inputs", () => {
  const inputs = {
    task: ["HANDOFF_STYLE", "TASK_GUIDANCE", "TASK_REQUEST"],
    "adversarial-review": ["REVIEW_INPUT", "REVIEW_COLLECTION_GUIDANCE", "TARGET_LABEL", "USER_FOCUS"],
    "stop-review-gate": ["CLAUDE_RESPONSE_BLOCK"]
  };
  const files = fs.readdirSync(path.join(PLUGIN_ROOT, "prompts")).sort();
  assert.deepEqual(files, Object.keys(inputs).map((name) => `${name}.md`).sort());
  for (const [name, keys] of Object.entries(inputs)) {
    const template = loadPromptTemplate(PLUGIN_ROOT, name);
    const placeholders = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(placeholders)].sort(), keys.slice().sort(), name);
    const rendered = interpolateTemplate(template, Object.fromEntries(keys.map((key) => [key, `sentinel-${key}`])));
    assert.doesNotMatch(rendered, /\{\{[A-Z_]+\}\}/, name);
    for (const key of keys) assert.ok(rendered.includes(`sentinel-${key}`), `${name}: lost ${key}`);
  }
});

test("prompt interpolation preserves literal task content without recursive expansion", () => {
  const request = 'Return exactly {"value":"$&", "template":"{{TASK_REQUEST}}"}.\nPath: C:\\repo\\file';
  for (const model of ["gpt-6-astra", "gpt-6.2-sol", "gpt-5.3-codex-spark"]) {
    const rendered = buildTaskPrompt(PLUGIN_ROOT, request, { model, modelProvider: "openai" });
    assert.equal(rendered.slice(rendered.indexOf("\nRequest:\n") + "\nRequest:\n".length), request);
    assert.equal(rendered.split(request).length, 2);
  }
});

test("fresh task guidance distinguishes OpenAI model families and falls back for other models", () => {
  const request = "Check the existing behavior.";
  const build = (model, modelProvider = "openai") => buildTaskPrompt(PLUGIN_ROOT, request, { model, modelProvider });
  const generic = build(null);
  const gpt6 = build("gpt-6-astra");
  const gpt62 = build("gpt-6.2-astra");

  assert.match(gpt6, /checks proportional to the change/);
  assert.match(gpt6, /concise handoff/);
  assert.equal(build("gpt-6.1-sol"), gpt6);
  assert.match(gpt62, /reasonable, reversible assumptions/);
  assert.match(gpt62, /self-contained handoff/);
  assert.equal(build("gpt-6.2-sol"), gpt62);

  assert.match(generic, /concise handoff/);
  assert.doesNotMatch(generic, /checks proportional to the change|reversible assumptions/);
  for (const model of ["gpt-5.3-codex-spark", "gpt-6.20-astra", "gpt-6.3-astra", "gpt-60-astra"]) {
    assert.equal(build(model), generic);
  }
  assert.equal(build("gpt-6.2-astra", "custom"), generic);
  assert.equal(build("gpt-6.2-astra", null), generic);
});
