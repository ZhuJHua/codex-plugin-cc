import { stripVTControlCharacters } from "node:util";

export function sanitizeStderr(value) {
  return stripVTControlCharacters(String(value ?? "")).trim();
}
