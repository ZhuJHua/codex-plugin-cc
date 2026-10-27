import fs from "node:fs";
import { spawnSync } from "node:child_process";

// A persisted PID alone is not proof of ownership after the worker dies. Failure
// to inspect identity is explicit uncertainty, never permission to kill a PID.
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return boot && /^\d+$/.test(fields[19] ?? "") ? `linux:${boot}:${fields[19]}` : null;
    }
    if (process.platform === "darwin") {
      const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
      return result.status === 0 && result.stdout.trim() ? `darwin:${result.stdout.trim()}` : null;
    }
    if (process.platform === "win32") {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: "utf8", timeout: 3000, windowsHide: true });
      return result.status === 0 && /^\d+$/.test(result.stdout.trim()) ? `win32:${result.stdout.trim()}` : null;
    }
  } catch {}
  return null;
}
