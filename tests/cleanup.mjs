import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveWorkspaceRoot } from '../plugins/codex/scripts/lib/workspace.mjs';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
export function cleanupCoordination(cwd, codexHome) {
  let canonical = path.resolve(cwd);
  try { canonical = fs.realpathSync.native(resolveWorkspaceRoot(canonical)); } catch {}
  const root = path.join(os.tmpdir(), 'codex-companion');
  fs.rmSync(path.join(root, 'workspace-leases', `${hash(canonical)}.json`), { force: true });
  if (codexHome) {
    let homePath = path.resolve(codexHome);
    try { homePath = fs.realpathSync.native(homePath); } catch {}
    fs.rmSync(path.join(root, 'thread-leases', hash(homePath)), { recursive: true, force: true });
  }
}

const testRoots = new Set();
export function registerTestRoot(directory) {
  testRoots.add(path.resolve(directory));
  try { testRoots.add(fs.realpathSync.native(directory)); } catch {}
}

export function readProcessTable() {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    : spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error(`Cannot verify test process cleanup: ${result.error?.message ?? result.stderr}`);
  if (process.platform === 'win32') return [].concat(JSON.parse(result.stdout || '[]')).map(row => ({ pid: row.ProcessId, ppid: row.ParentProcessId, group: null, command: row.CommandLine ?? '' }));
  return result.stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), group: Number(match[3]), command: match[4] }] : [];
  });
}

export function testProcesses(roots = [...testRoots]) {
  if (!roots.length) return [];
  const processes = readProcessTable();
  const excluded = new Set([process.pid]);
  let parent = processes.find(row => row.pid === process.pid)?.ppid;
  while (parent && !excluded.has(parent)) { excluded.add(parent); parent = processes.find(row => row.pid === parent)?.ppid; }
  const owned = new Set(processes.filter(row => !excluded.has(row.pid) && roots.some(root => row.command.includes(root))).map(row => row.pid));
  let changed;
  do {
    changed = false;
    for (const row of processes) if (!excluded.has(row.pid) && owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
  } while (changed);
  return processes.filter(row => owned.has(row.pid));
}

export function assertNoTestProcesses(roots) {
  const remaining = testProcesses(roots);
  if (remaining.length) throw new Error(`Leaked test processes:\n${remaining.map(row => `${row.pid}: ${row.command}`).join('\n')}`);
}

export async function cleanupTestProcesses(roots) {
  for (const row of testProcesses(roots)) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(row.pid), '/T', '/F'], { windowsHide: true });
    else try { process.kill(row.group === row.pid ? -row.group : row.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + 3000;
  while (testProcesses(roots).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assertNoTestProcesses(roots);
}
