import "./environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

const TASK = {
  valueOptions: ["cwd", "model", "effort", "prompt-file", "thread"],
  booleanOptions: ["write", "full-access", "resume-last", "fresh", "background", "wait", "json"],
  aliasMap: { m: "model" },
  allowRawArgs: true,
  stopAtPositional: true
};

test("ordinary CLI task arguments preserve quotes, backslashes, JSON, and shell syntax literally", () => {
  const prompt = String.raw`Fix "quoted text" in C:\src\project; keep {"path":"a\\b","text":"don't"} and $(touch sentinel).`;
  const argv = [prompt];
  assert.deepEqual(parseArgs(argv, TASK), { options: {}, positionals: [prompt] });
  assert.deepEqual(argv, [prompt]);
});

test("task controls end at the first task argument", () => {
  const task = ["Explain the flags", "--write", "--model", "another-model", "--raw-args", "--full-access"];
  assert.deepEqual(parseArgs(["--model", "chosen-model", ...task], TASK), {
    options: { model: "chosen-model" }, positionals: task
  });
});

test("the explicit task boundary preserves every subsequent argument", () => {
  const task = ["--full-access", String.raw`"quoted" C:\src\file.json`, "--raw-args", "--write"];
  assert.deepEqual(parseArgs(["--wait", "--", ...task], TASK), {
    options: { wait: true }, positionals: task
  });
});

test("raw arguments decode only the control prefix and preserve the complete task tail", () => {
  const prompt = String.raw`Fix "quoted text" in C:\src\project with {"path":"a\\b"}; $(touch sentinel)
Keep  two spaces, --full-access, and an unmatched "quote.  `;
  const raw = `--model "chosen model" --effort=high --cwd '/tmp/project with spaces' --wait ${prompt}`;
  assert.deepEqual(parseArgs(["--raw-args", raw], TASK), {
    options: { model: "chosen model", effort: "high", cwd: "/tmp/project with spaces", wait: true },
    positionals: [prompt]
  });
});

test("raw quoted task text and raw explicit boundaries remain literal", () => {
  for (const prompt of [String.raw`"--write" keep C:\src and 'quotes'`, String.raw`--full-access {"key":"value"}  `]) {
    const prefix = prompt.startsWith("--") ? "-- " : "";
    assert.deepEqual(parseArgs(["--raw-args", prefix + prompt], TASK), {
      options: {}, positionals: [prompt]
    });
  }
});

test("explicit controls and raw controls can be combined without reparsing the body", () => {
  const prompt = String.raw`Implement {"literal":"--write=false"} in C:\src\file`;
  assert.deepEqual(parseArgs(["--write", "--raw-args", `-m chosen-model ${prompt}`], TASK), {
    options: { write: true, model: "chosen-model" }, positionals: [prompt]
  });
  assert.deepEqual(parseArgs([`--raw-args=--write=false ${prompt}`], TASK), {
    options: { write: false }, positionals: [prompt]
  });
});

test("raw arguments cannot recursively expand another raw control", () => {
  assert.throws(() => parseArgs(["--raw-args", '--raw-args "--write Injected task"'], TASK), /only once/);
  assert.throws(() => parseArgs(["--raw-args", "--write", "--raw-args", "More text"], TASK), /only once/);
  const prompt = 'Explain --raw-args "--write" without changing it';
  assert.deepEqual(parseArgs(["--raw-args", prompt], TASK), { options: {}, positionals: [prompt] });
});

test("unknown leading options fail for ordinary and raw arguments", () => {
  for (const argv of [["--typo", "Task"], ["-z", "Task"], ["--raw-args", "--typo Task"]]) {
    assert.throws(() => parseArgs(argv, TASK), /Unknown option/);
  }
});

test("missing control values fail rather than consuming another option", () => {
  for (const argv of [
    ["--model"], ["--model="], ["--model", ""], ["--model", "--write"],
    ["-m"], ["-m", ""], ["-m", "--write"], ["--raw-args"],
    ["--raw-args", "--model"], ["--raw-args", '--model "" Task'],
    ["--raw-args", "--model --write Task"]
  ]) {
    assert.throws(() => parseArgs(argv, TASK), /Missing value/, JSON.stringify(argv));
  }
});

test("boolean controls accept true or false and reject malformed values", () => {
  assert.deepEqual(parseArgs(["--write=false", "--wait=true", "Task"], TASK), {
    options: { write: false, wait: true }, positionals: ["Task"]
  });
  for (const argv of [["--write=yes", "Task"], ["--write=", "Task"], ["--raw-args", "--full-access=1 Task"]]) {
    assert.throws(() => parseArgs(argv, TASK), /expected true or false/);
  }
});

test("raw control quoting is validated while task-tail quoting stays opaque", () => {
  assert.throws(() => parseArgs(["--raw-args", '--model "unfinished'], TASK), /Unclosed quote/);
  assert.throws(() => splitRawArgumentString("--cwd 'unfinished"), /Unclosed quote/);
  assert.deepEqual(splitRawArgumentString(String.raw`--cwd "C:\project folder" --model='chosen model'`), [
    "--cwd", String.raw`C:\project folder`, "--model=chosen model"
  ]);
});

test("management commands can decode raw controls after a positional job ID", () => {
  assert.deepEqual(parseArgs(["--raw-args", "job-123 --timeout-ms 60000 --json"], {
    valueOptions: ["timeout-ms"], booleanOptions: ["json"], allowRawArgs: true
  }), { options: { "timeout-ms": "60000", json: true }, positionals: ["job-123"] });
});


test("one ordinary argv string starting with flag-like text is a literal task", () => {
  const request = '--full-access inspect {"quote":"a\\b"}';
  assert.deepEqual(parseArgs([request], { valueOptions: ["model"], booleanOptions: ["full-access"], stopAtPositional: true, allowRawArgs: true }), { options: {}, positionals: [request] });
  assert.throws(() => parseArgs(["--raw-args", "--unknown inspect"], { stopAtPositional: true, allowRawArgs: true }), /Unknown option/);
});
