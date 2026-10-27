export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const leadingOnlyOptions = new Set(config.leadingOnlyOptions ?? []);
  const options = {};
  const positionals = [];
  let passthrough = false;
  let expandedRaw = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!expandedRaw && config.stopAtPositional && /\s/.test(token) && !/^--?[^=\s]+=/.test(token)) {
      positionals.push(token);
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      if (config.stopAtPositional) passthrough = true;
      continue;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const separator = body.indexOf("=");
      const rawKey = separator === -1 ? body : body.slice(0, separator);
      const inlineValue = separator === -1 ? undefined : body.slice(separator + 1);
      const key = aliasMap[rawKey] ?? rawKey;

      if (leadingOnlyOptions.has(key) && positionals.length > 0) {
        positionals.push(token);
        continue;
      }

      if (key === "raw-args" && config.allowRawArgs) {
        if (expandedRaw) throw new Error("Use --raw-args only once.");
        const value = inlineValue ?? argv[index + 1];
        if (value === undefined) throw new Error("Missing value for --raw-args.");
        argv = [...argv.slice(0, index), ...expandRawArguments(value, config), ...argv.slice(index + (inlineValue === undefined ? 2 : 1))];
        expandedRaw = true;
        index -= 1;
        continue;
      }

      if (booleanOptions.has(key)) {
        if (inlineValue !== undefined && inlineValue !== "true" && inlineValue !== "false") {
          throw new Error(`Invalid value for --${rawKey}: expected true or false.`);
        }
        options[key] = inlineValue !== "false";
        config.onOption?.(key, options[key]);
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined || nextValue === "" || (inlineValue === undefined && nextValue.startsWith("-"))) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      throw new Error(`Unknown option --${rawKey}. Put -- before literal task text.`);
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined || nextValue === "" || nextValue.startsWith("-")) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option -${shortKey}. Put -- before literal task text.`);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\" && quote !== "\'" && /[\\\s\'\"]/.test(raw[index + 1] ?? "")) {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (quote) throw new Error("Unclosed quote in --raw-args.");
  if (escaping) current += "\\";

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

// Decode only the control prefix. The prompt tail is an opaque string, including
// its quotes, backslashes, whitespace and JSON.
function expandRawArguments(raw, config) {
  if (!config.stopAtPositional) return splitRawArgumentString(raw);
  const result = [];
  const values = new Set(config.valueOptions ?? []);
  let index = 0;
  let expectingValue = false;
  while (index < raw.length) {
    while (/\s/.test(raw[index] ?? "") && index < raw.length) index++;
    if (index === raw.length) break;
    const start = index;
    let quote = null;
    for (; index < raw.length; index++) {
      const c = raw[index];
      if (c === "\\" && quote !== "'" && /[\\\s'"]/.test(raw[index + 1] ?? "")) { index++; continue; }
      if (quote) { if (c === quote) quote = null; }
      else if (c === "'" || c === '"') quote = c;
      else if (/\s/.test(c)) break;
    }
    const spelling = raw.slice(start, index);
    // Unquoted task text starts here: do not parse or normalize its contents.
    if (!expectingValue && !spelling.startsWith("-")) { result.push(raw.slice(start)); break; }
    const token = splitRawArgumentString(spelling)[0] ?? "";
    result.push(token);
    if (expectingValue) { expectingValue = false; continue; }
    if (token === "--") {
      while (/\s/.test(raw[index] ?? "") && index < raw.length) index++;
      if (index < raw.length) result.push(raw.slice(index));
      break;
    }
    const key = token.replace(/^--?/, "").split("=")[0];
    expectingValue = !token.includes("=") && values.has(config.aliasMap?.[key] ?? key);
  }
  return result;
}
