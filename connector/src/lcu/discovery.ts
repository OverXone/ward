/**
 * Finds the running League Client (LCU) and its credentials.
 *
 * 1. Primary: the command line of LeagueClientUx.exe (`--app-port`, `--remoting-auth-token`),
 *    read via PowerShell / CIM (wmic is gone on current Windows 11 builds).
 * 2. Fallback: the `lockfile` in the League install directory
 *    (`name:pid:port:password:protocol`).
 *
 * A cheap `tasklist` check runs first so we only spawn PowerShell when the
 * client is actually running.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface LcuCredentials {
  port: number;
  password: string;
  pid: number;
  source: "process" | "lockfile";
  installDir: string | null;
}

export interface DiscoveryResult {
  credentials: LcuCredentials | null;
  /** Human-readable diagnostics (never contain the password). */
  notes: string[];
}

const UX_EXE = "LeagueClientUx.exe";
const DEFAULT_INSTALL_DIRS = ["C:\\Riot Games\\League of Legends"];
const PRODUCT_SETTINGS =
  "C:\\ProgramData\\Riot Games\\Metadata\\league_of_legends.live\\league_of_legends.live.product_settings.yaml";

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** true/false if we could tell, undefined if tasklist itself failed. */
export async function isClientRunning(): Promise<boolean | undefined> {
  try {
    const out = await run("tasklist.exe", ["/FI", `IMAGENAME eq ${UX_EXE}`, "/FO", "CSV", "/NH"], 5000);
    return out.toLowerCase().includes(UX_EXE.toLowerCase());
  } catch {
    return undefined;
  }
}

interface ProcessInfo {
  pid: number;
  exePath: string | null;
  commandLine: string | null;
}

export async function queryUxProcess(): Promise<ProcessInfo | null> {
  const script =
    `$p = Get-CimInstance -ClassName Win32_Process -Filter "Name = '${UX_EXE}'" | ` +
    `Select-Object -First 1 ProcessId, ExecutablePath, CommandLine; ` +
    `if ($p) { $p | ConvertTo-Json -Compress }`;
  // -EncodedCommand avoids every quoting pitfall between Node, Windows and PowerShell.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const out = (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], 15000)).trim();
  if (!out) return null;
  const parsed = JSON.parse(out) as { ProcessId?: number; ExecutablePath?: string | null; CommandLine?: string | null };
  if (typeof parsed.ProcessId !== "number") return null;
  return {
    pid: parsed.ProcessId,
    exePath: parsed.ExecutablePath ?? null,
    commandLine: parsed.CommandLine ?? null,
  };
}

export function parseCommandLine(commandLine: string): { port: number; password: string } | null {
  const port = /--app-port=(\d+)/.exec(commandLine)?.[1];
  const password = /--remoting-auth-token=([^\s"]+)/.exec(commandLine)?.[1];
  if (!port || !password) return null;
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return { port: n, password };
}

export function parseLockfile(content: string): { pid: number; port: number; password: string } | null {
  const parts = content.trim().split(":");
  if (parts.length < 5) return null;
  const [, pidStr, portStr, password, protocol] = parts;
  const pid = Number(pidStr);
  const port = Number(portStr);
  if (!Number.isInteger(pid) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!password || protocol !== "https") return null;
  return { pid, port, password };
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function installDirFromProductSettings(): Promise<string | null> {
  try {
    const yaml = await readFile(PRODUCT_SETTINGS, "utf8");
    const m = /product_install_full_path:\s*"?([^"\r\n]+?)"?\s*$/m.exec(yaml);
    return m?.[1] ? path.normalize(m[1]) : null;
  } catch {
    return null;
  }
}

async function readLockfileIn(dir: string): Promise<{ pid: number; port: number; password: string } | null> {
  try {
    const content = await readFile(path.join(dir, "lockfile"), "utf8");
    const parsed = parseLockfile(content);
    if (parsed && isPidAlive(parsed.pid)) return parsed;
  } catch {
    // missing / unreadable
  }
  return null;
}

export interface DiscoveryOptions {
  /** Explicit install dir: only its lockfile is used (also how the mock LCU is wired up). */
  leagueDir?: string;
}

export async function discover(opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const notes: string[] = [];

  if (opts.leagueDir) {
    const lf = await readLockfileIn(opts.leagueDir);
    if (!lf) {
      notes.push(`no live lockfile in ${opts.leagueDir}`);
      return { credentials: null, notes };
    }
    return {
      credentials: { ...lf, source: "lockfile", installDir: opts.leagueDir },
      notes: [`lockfile found in ${opts.leagueDir}`],
    };
  }

  const running = await isClientRunning();
  if (running === false) {
    notes.push(`${UX_EXE} is not running`);
    return { credentials: null, notes };
  }
  if (running === undefined) notes.push("tasklist failed; trying anyway");

  let proc: ProcessInfo | null = null;
  try {
    proc = await queryUxProcess();
  } catch (e) {
    notes.push(`process query failed: ${(e as Error).message.split("\n")[0]}`);
  }

  if (proc) {
    const installDir = proc.exePath ? path.dirname(proc.exePath) : null;
    if (proc.commandLine) {
      const parsed = parseCommandLine(proc.commandLine);
      if (parsed) {
        notes.push(`read ${UX_EXE} command line (pid ${proc.pid})`);
        return { credentials: { ...parsed, pid: proc.pid, source: "process", installDir }, notes };
      }
      notes.push("command line found but --app-port/--remoting-auth-token missing (client still starting?)");
    } else {
      notes.push(`${UX_EXE} found (pid ${proc.pid}) but its command line is not readable; is the client running as admin?`);
    }
  }

  const candidates: string[] = [];
  if (proc?.exePath) candidates.push(path.dirname(proc.exePath));
  const fromSettings = await installDirFromProductSettings();
  if (fromSettings) candidates.push(fromSettings);
  candidates.push(...DEFAULT_INSTALL_DIRS);

  for (const dir of [...new Set(candidates)]) {
    const lf = await readLockfileIn(dir);
    if (lf) {
      notes.push(`using lockfile in ${dir}`);
      return { credentials: { ...lf, source: "lockfile", installDir: dir }, notes };
    }
  }
  notes.push(`no live lockfile in: ${[...new Set(candidates)].join(", ")}`);
  return { credentials: null, notes };
}
