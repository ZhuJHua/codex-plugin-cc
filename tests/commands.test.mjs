import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

function frontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "expected plugin frontmatter");
  return match[1];
}

test("reviews are model-callable and keep explicit runtime background ownership", () => {
  for (const command of ["review", "adversarial-review"]) {
    const source = read(`commands/${command}.md`);
    const header = frontmatter(source);
    assert.doesNotMatch(header, /disable-model-invocation:\s*true/);
    assert.match(header, /allowed-tools:\s*Bash\(node:\*\)/);
    assert.ok(source.includes(`codex-companion.mjs" ${command} --raw-args "$ARGUMENTS"`));
    assert.match(source, /user requested.*review|accepted task plan/i);
    assert.match(source, /review-only/i);
    assert.doesNotMatch(source, /run_in_background:\s*true|AskUserQuestion|git diff --shortstat/);
  }
  assert.match(read("commands/review.md"), /rejects.*`--effort`/i);
  assert.ok(frontmatter(read("commands/adversarial-review.md")).includes("--effort <effort>"));
});

test("rescue defaults to the direct task interface and retains the parallel Agent entrypoint", () => {
  const source = read("commands/rescue.md");
  const header = frontmatter(source);
  assert.match(header, /allowed-tools:.*\bAgent\b/);
  assert.doesNotMatch(header, /^context:\s*fork\b/m);
  assert.match(source, /current Claude session by default/i);
  assert.ok(source.includes('codex-companion.mjs" task --raw-args "$ARGUMENTS"'));
  assert.ok(source.includes('Agent(subagent_type: "codex:codex-rescue")'));
  assert.match(source, /do not.*call `Skill\(codex:codex-rescue\)`/i);
  assert.match(source, /task-resume-candidate --json/);
  for (const flag of ["--wait", "--background", "--resume", "--fresh", "--full-access", "--model", "--effort"]) {
    assert.ok(header.includes(flag), `rescue hint missing ${flag}`);
  }
  assert.doesNotMatch(source, /run_in_background:\s*true/);
});

test("rescue preloads existing version-neutral skills with valid local references", () => {
  const header = frontmatter(read("agents/codex-rescue.md"));
  const skills = [...header.matchAll(/^  - ([a-z0-9-]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(skills, ["codex-cli-runtime", "codex-prompting"]);
  for (const name of skills) {
    const source = read(`skills/${name}/SKILL.md`);
    assert.match(frontmatter(source), new RegExp(`^name: ${name}$`, "m"));
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^https?:/.test(match[1])) continue;
      const reference = path.join(PLUGIN_ROOT, "skills", name, match[1]);
      assert.ok(fs.statSync(reference).isFile(), `missing skill reference ${reference}`);
    }
  }
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "skills", "gpt-5-4-prompting")), false);
});

test("forwarding instructions require literal task text and verbatim output", () => {
  for (const file of ["agents/codex-rescue.md", "skills/codex-cli-runtime/SKILL.md"]) {
    const source = read(file);
    assert.match(source, /Pass task text verbatim/);
    assert.match(source, /never reword it/);
    assert.match(source, /Prefer a prompt file or literal argv/);
    assert.match(source, /[Rr]eturn companion stdout verbatim/);
    assert.match(source, /Either omit stderr progress lines or copy them verbatim; never summarise or annotate them/);
    assert.match(source, /Copy actionable failure stderr verbatim/);
  }
});

test("plugin exposes task recovery through the await command", () => {
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort(), [
    "adversarial-review.md", "await.md", "cancel.md", "rescue.md", "result.md",
    "review.md", "setup.md", "status.md", "transfer.md"
  ]);
});

test("query and wait commands are model-callable explicit Bash entrypoints", () => {
  for (const command of ["status", "result", "await"]) {
    const source = read(`commands/${command}.md`);
    assert.doesNotMatch(frontmatter(source), /disable-model-invocation:\s*true/);
    assert.ok(source.includes(`codex-companion.mjs" ${command} --raw-args "$ARGUMENTS"`));
    assert.doesNotMatch(source, /^!`/m);
  }
  const wait = read("commands/await.md");
  assert.match(wait, /124/);
  assert.match(wait, /do not cancel|does not cancel/i);
});

test("cancel requires an explicit request and transfer remains manual", () => {
  const cancel = read("commands/cancel.md");
  assert.match(cancel, /Only run this command when the user explicitly asked/i);
  assert.doesNotMatch(cancel, /^!`/m);
  assert.ok(cancel.includes('codex-companion.mjs" cancel --raw-args "$ARGUMENTS"'));
  const transfer = read("commands/transfer.md");
  assert.match(frontmatter(transfer), /disable-model-invocation:\s*true/);
  assert.ok(transfer.includes('codex-companion.mjs" transfer --raw-args "$ARGUMENTS"'));
});

test("command adapters use loaded plugin paths and explicit raw arguments", () => {
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, "commands"))) {
    const source = read(`commands/${file}`);
    assert.ok(source.includes('${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs'), file);
    assert.ok(source.includes('--raw-args "$ARGUMENTS"'), file);
    assert.match(source, /single-quoted values/, file);
    assert.match(source, /Never use `eval`/, file);
    assert.doesNotMatch(source, /plugins\/cache|installed_plugins\.json|process\.env\.CLAUDE_PLUGIN_ROOT/, file);
  }
});

test("hooks preserve session cleanup and the optional stop gate", () => {
  const hooks = JSON.parse(read("hooks/hooks.json")).hooks;
  for (const name of ["SessionStart", "SessionEnd", "Stop"]) {
    assert.ok(hooks[name]?.length, `missing ${name} hook`);
  }
});

test("setup retains installation and login guidance", () => {
  const source = read("commands/setup.md");
  assert.match(source, /npm install -g @openai\/codex/);
  assert.match(source, /codex-companion\.mjs" setup --json --raw-args "\$ARGUMENTS"/);
  assert.match(source, /!codex login/);
});

test('fork installation identity preserves the codex command namespace', () => {
  const market = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(market.name, 'zhujhua-codex');
  assert.equal(plugin.name, 'codex');
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].version, plugin.version);
  assert.match(frontmatter(read('agents/codex-rescue.md')), /^model: haiku$/m);
  assert.match(read('commands/rescue.md'), /--network/);
});
