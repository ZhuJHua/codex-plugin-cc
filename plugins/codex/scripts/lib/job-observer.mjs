import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_OBSERVER_TIMEOUT_MS = 540000;

export function createJobProgressReader({ replayLimit = 20, write = text => process.stderr.write(text) } = {}) {
  let offset = 0;
  let pendingLog = "";
  let attaching = true;
  const decoder = new StringDecoder("utf8");
  return job => {
    if (!job.logFile || !fs.existsSync(job.logFile) || process.stderr.destroyed) return;
    const size = fs.statSync(job.logFile).size;
    if (size < offset) { offset = 0; pendingLog = ""; decoder.end(); }
    const replay = [];
    let count = 0;
    if (size > offset) {
      const fd = fs.openSync(job.logFile, "r");
      try {
        const chunk = Buffer.alloc(Math.min(65536, size - offset));
        while (offset < size) {
          const bytes = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
          if (!bytes) break;
          pendingLog += decoder.write(chunk.subarray(0, bytes));
          const lines = pendingLog.split("\n");
          pendingLog = lines.pop();
          for (const line of lines) {
            const progress = line.match(/^(\[[^\]]+\]) \[progress\] (.*)$/);
            if (!progress) continue;
            const text = `${progress[1]} ${progress[2]}\n`;
            if (attaching) {
              count += 1;
              replay.push(text);
              if (replay.length > replayLimit) replay.shift();
            } else write(text);
          }
          offset += bytes;
        }
      } finally { fs.closeSync(fd); }
    }
    if (count > replay.length) write(`… ${count - replay.length} earlier progress lines in ${job.logFile}\n`);
    for (const line of replay) write(line);
    attaching = false;
  };
}
