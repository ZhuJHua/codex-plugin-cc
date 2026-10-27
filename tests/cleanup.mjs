import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveWorkspaceRoot } from '../plugins/codex/scripts/lib/workspace.mjs';
import { resolveStateRoot } from '../plugins/codex/scripts/lib/state.mjs';
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
const trackedProcesses = [];
const trackedStateRoots = new Set();
let warned = false;

function warnUnavailableProbe(message) {
  if (!warned) { warned = true; process.stderr.write(`WARNING: Skipping unavailable test process leak probes: ${message}\n`); }
}

export function registerTestProcess(pid, group, command, child = null) {
  if (!pid) return;
  const row = { pid, group, command, child };
  trackedProcesses.push(row);
  child?.once('exit', () => {
    if (!group) row.retired = true;
    else try { process.kill(-group, 0); } catch (error) { if (error.code === 'ESRCH') row.retired = true; }
  });
}

function trackSpawn(command, args, options, launch) {
  const stateRoot = options?.env?.CLAUDE_PLUGIN_DATA ? path.join(options.env.CLAUDE_PLUGIN_DATA, 'state') : resolveStateRoot();
  trackedStateRoots.add(stateRoot);
  const child = launch(command, args, options);
  if (launch === spawn) registerTestProcess(child.pid, options?.detached && process.platform !== 'win32' ? child.pid : null, [options?.cwd, command, ...args].filter(Boolean).join(' '), child);
  return child;
}

export const spawnTestProcess = (command, args, options) => trackSpawn(command, args, options, spawn);
export const spawnSyncTestProcess = (command, args, options) => trackSpawn(command, args, options, spawnSync);

function trackedTestProcesses(roots, kill = process.kill) {
  const candidates = trackedProcesses.filter(row => !row.retired && roots.some(root => row.command.includes(root)) &&
    (row.group || !row.child || (row.child.exitCode === null && row.child.signalCode === null)));
  // Detached workers outlive their CLI parent; their own job records retain both
  // runtime PIDs and groups. Only read state roots used by this test process.
  for (const root of new Set([resolveStateRoot(), ...trackedStateRoots])) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, entry.name, 'jobs');
      if (!fs.existsSync(directory)) continue;
      for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.json'))) {
        let job;
        try {
          job = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
          if (!job || typeof job !== 'object') throw new Error(`Invalid job record: ${file}`);
        } catch (error) {
          if (error.code !== 'ENOENT') warnUnavailableProbe(`${path.join(directory, file)}: ${error.message}`);
          continue;
        }
        if (!roots.some(root => job.workspaceRoot?.startsWith(`${root}${path.sep}`) || job.workspaceRoot === root)) continue;
        for (const [pid, group] of [[job.pid, job.workerPgid], [job.appServerPid, job.appServerPgid]]) {
          const trackedPid = pid ?? group;
          if (trackedPid && trackedPid !== process.pid) candidates.push({ pid: trackedPid, group, command: `tracked job ${job.id} in ${job.workspaceRoot}` });
        }
      }
    }
  }
  return [...new Map(candidates.map(row => [row.pid, row])).values()].filter(row => {
    try { kill(row.group ? -row.group : row.pid, 0); return true; }
    catch (error) {
      if (error.code === 'ESRCH') { row.retired = true; return false; }
      if (error.code === 'EPERM') return true;
      warnUnavailableProbe(error.message);
      return false;
    }
  });
}
export function registerTestRoot(directory) {
  testRoots.add(path.resolve(directory));
  try { testRoots.add(fs.realpathSync.native(directory)); } catch {}
}

export function readProcessTable() {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    : spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) throw Object.assign(new Error(`Cannot verify test process cleanup: ${result.error?.message ?? result.stderr}`), { code: result.error?.code });
  if (process.platform === 'win32') return [].concat(JSON.parse(result.stdout || '[]')).map(row => ({ pid: row.ProcessId, ppid: row.ParentProcessId, group: null, command: row.CommandLine ?? '' }));
  return result.stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), group: Number(match[3]), command: match[4] }] : [];
  });
}

export function testProcesses(roots = [...testRoots], { readTable = readProcessTable, kill = process.kill } = {}) {
  if (!roots.length) return [];
  let processes;
  try { processes = readTable(); }
  catch (error) {
    if (!['EPERM', 'ENOENT', 'EACCES'].includes(error.code)) throw error;
    return trackedTestProcesses(roots, kill);
  }
  for (const row of trackedProcesses) {
    if (!processes.some(value => row.group ? value.group === row.group : value.pid === row.pid)) row.retired = true;
  }
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

export function assertNoTestProcesses(roots, options) {
  const remaining = testProcesses(roots, options);
  if (remaining.length) throw new Error(`Leaked test processes:\n${remaining.map(row => `${row.pid}: ${row.command}`).join('\n')}`);
}

export async function cleanupTestProcesses(roots, options) {
  for (const row of testProcesses(roots, options)) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(row.pid), '/T', '/F'], { windowsHide: true });
    else try { process.kill(row.group === row.pid ? -row.group : row.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + 3000;
  while (testProcesses(roots, options).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assertNoTestProcesses(roots, options);
}
