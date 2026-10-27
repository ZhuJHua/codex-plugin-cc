import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { interpolateTemplate, loadPromptTemplate } from "../plugins/codex/scripts/lib/prompts.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/codex");

test("bundled prompt placeholders match their runtime inputs", () => {
  const inputs = {
    task: ["TASK_REQUEST"],
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
  const template = loadPromptTemplate(PLUGIN_ROOT, "task");
  const rendered = interpolateTemplate(template, { TASK_REQUEST: request });
  assert.equal(rendered.slice(rendered.indexOf("\nRequest:\n") + "\nRequest:\n".length).trimEnd(), request);
  assert.equal(rendered.split(request).length, 2);
});
