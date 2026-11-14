/**
 * The tray icon, drawn by a separate small program (Windows Forms NotifyIcon) that Ward talks to
 * over its stdin/stdout. Normally that's the Ward tray helper (tray/WardTray.cs, ~20 KB, built into
 * Ward.exe and unpacked to the data folder), so Windows labels the icon and its notifications
 * "Ward". If it can't run, the same thing is done by a Windows PowerShell script written to the
 * data folder (Windows then shows "Windows PowerShell"). One line per message:
 *
 *   Ward -> tray:  notify<TAB>title<TAB>text   update<TAB>version (or empty to hide)   focus<TAB>pid   exit
 *   tray -> Ward:  ready   open   open-new (focus didn't work)   update   quit
 *
 * The script quits and removes the icon when its stdin closes, so the icon never outlives Ward.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

export const TRAY_SCRIPT = String.raw`param([Parameter(Mandatory = $true)][string]$Exe)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$utf8 = New-Object System.Text.UTF8Encoding $false
$stdin = New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), $utf8
$stdout = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput()), $utf8
$stdout.AutoFlush = $true
function Send([string]$msg) { $stdout.WriteLine($msg) }

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe)
$tray.Text = 'Ward'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open Ward')
$open.Font = New-Object System.Drawing.Font ($open.Font, [System.Drawing.FontStyle]::Bold)
$update = $menu.Items.Add('Update')
$update.Visible = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit = $menu.Items.Add('Quit Ward')
$open.add_Click({ Send 'open' })
$update.add_Click({ Send 'update' })
$quit.add_Click({ Send 'quit' })
$tray.ContextMenuStrip = $menu
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send 'open' } })
$tray.add_BalloonTipClicked({ Send 'open' })

function Stop-Tray {
  $timer.Stop()
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

# Read Ward's messages without blocking the UI thread: one pending read, checked by a timer.
$script:pending = $stdin.ReadLineAsync()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.add_Tick({
  while ($script:pending.IsCompleted) {
    if ($script:pending.IsFaulted) { Stop-Tray; return }
    $line = $script:pending.Result
    if ($null -eq $line -or $line -eq 'exit') { Stop-Tray; return }
    $parts = $line.Split([char]9)
    if ($parts[0] -eq 'notify' -and $parts.Length -ge 3) {
      $tray.ShowBalloonTip(5000, $parts[1], $parts[2], [System.Windows.Forms.ToolTipIcon]::Info)
    } elseif ($parts[0] -eq 'focus' -and $parts.Length -ge 2) {
      # Bring the open Ward window to the front; if that doesn't work (Windows Terminal), open another.
      $ok = $false
      try { $ok = (New-Object -ComObject WScript.Shell).AppActivate([int]$parts[1]) } catch { }
      if (-not $ok) { Send 'open-new' }
    } elseif ($parts[0] -eq 'update') {
      if ($parts.Length -ge 2 -and $parts[1]) { $update.Text = "Update to Ward $($parts[1])"; $update.Visible = $true }
      else { $update.Visible = $false }
    }
    $script:pending = $stdin.ReadLineAsync()
  }
})
$timer.Start()
$tray.Visible = $true
Send 'ready'
[System.Windows.Forms.Application]::Run()
`;

const READY_TIMEOUT_MS = 15_000;

function powershellPath(): string {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Writes the tray helper exe to the data folder, named after its hash so a running copy (from an
 * older Ward) is never overwritten, and deletes helpers older versions left behind. Null on failure.
 */
export function unpackHelper(dataDir: string, body: Buffer): string | null {
  const name = `ward-tray-${createHash("sha256").update(body).digest("hex").slice(0, 12)}.exe`;
  const file = path.join(dataDir, name);
  try {
    if (!existsSync(file) || statSync(file).size !== body.length) writeFileSync(file, body);
  } catch {
    return null;
  }
  for (const other of readdirSync(dataDir)) {
    if (!/^ward-tray-[0-9a-f]{12}\.exe$/.test(other) || other === name) continue;
    try {
      rmSync(path.join(dataDir, other), { force: true });
    } catch {
      // still running (an older Ward); removed on a later start
    }
  }
  return file;
}

/** Single-line text for the tray protocol (no tabs or newlines; Windows caps balloon text anyway). */
function clean(text: string, max: number): string {
  return text.replace(/[\t\r\n]+/g, " ").slice(0, max);
}

export interface TrayEvents {
  open: [];
  /** "focus" couldn't bring the window forward: open a new one. */
  openNew: [];
  update: [];
  quit: [];
  /** The tray script exited on its own (it crashed or was killed). */
  gone: [];
  // From the Ward app window:
  newQr: [];
  /** A phone's number in the list (1-based), or "all". */
  forget: [which: string];
  /** The user closed the window (it's hidden; Ward keeps running). */
  closed: [];
}

export class Tray extends EventEmitter<TrayEvents> {
  private disposed = false;
  /** True when the Ward tray helper runs (it has the Ward window); false for the PowerShell icon. */
  hasWindow = false;

  private constructor(private readonly child: ChildProcess) {
    super();
  }

  /**
   * Starts the tray icon: the Ward tray helper built into Ward.exe (so Windows labels it "Ward"),
   * else the PowerShell script. Resolves to null if neither can be shown (Windows Forms blocked by
   * policy, ...); Ward then works like a plain console app.
   *
   * `helper` is the helper exe's bytes (from the SEA asset), or a path to an existing one (tests).
   */
  static async start(opts: {
    exe: string;
    dataDir: string;
    helper?: Buffer | string;
    timeoutMs?: number;
  }): Promise<Tray | null> {
    if (process.platform !== "win32") return null;
    try {
      mkdirSync(opts.dataDir, { recursive: true });
    } catch {
      return null;
    }
    const helperPath = typeof opts.helper === "string" ? opts.helper : opts.helper && unpackHelper(opts.dataDir, opts.helper);
    if (helperPath) {
      // Not started hidden: Windows would apply that to the helper's first window (the Ward window).
      const tray = await Tray.launch(helperPath, [], opts.timeoutMs, false);
      if (tray) {
        tray.hasWindow = true;
        return tray;
      }
    }
    try {
      const script = path.join(opts.dataDir, "tray.ps1");
      writeFileSync(script, TRAY_SCRIPT, "utf8");
      return await Tray.launch(
        powershellPath(),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", script, "-Exe", opts.exe],
        opts.timeoutMs,
      );
    } catch {
      return null;
    }
  }

  /** Runs a tray program that speaks the protocol above; null if it doesn't say "ready" in time. */
  private static launch(command: string, args: string[], timeoutMs = READY_TIMEOUT_MS, hide = true): Promise<Tray | null> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: hide });
      } catch {
        return resolve(null);
      }
      const tray = new Tray(child);
      let ready = false;
      const timer = setTimeout(() => {
        if (ready) return;
        child.kill();
        resolve(null);
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        if (!ready) resolve(null);
      });
      child.stdin?.on("error", () => {}); // the script may exit first; handled by "exit"
      child.on("exit", () => {
        clearTimeout(timer);
        if (!ready) return resolve(null);
        if (!tray.disposed) tray.emit("gone");
      });
      readline.createInterface({ input: child.stdout! }).on("line", (line) => {
        const msg = line.trim();
        if (msg === "ready" && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(tray);
        } else if (ready && (msg === "open" || msg === "update" || msg === "quit")) {
          tray.emit(msg);
        } else if (ready && msg === "open-new") {
          tray.emit("openNew");
        } else if (ready && (msg === "newqr" || msg === "closed")) {
          tray.emit(msg === "newqr" ? "newQr" : "closed");
        } else if (ready && /^forget\t(all|\d{1,4})$/.test(msg)) {
          tray.emit("forget", msg.slice("forget\t".length));
        }
      });
    });
  }

  private send(line: string): void {
    if (!this.disposed && this.child.stdin?.writable) this.child.stdin.write(line + "\n");
  }

  /** A Windows notification from the tray icon. Clicking it opens Ward. */
  notify(title: string, text: string): void {
    this.send(`notify\t${clean(title, 60)}\t${clean(text, 250)}`);
  }

  /** Brings the window of process `pid` to the front (emits "openNew" if it can't). */
  focus(pid: number): void {
    this.send(`focus\t${pid}`);
  }

  // ---- The Ward app window (only the Ward tray helper has one; the PowerShell script ignores these) ----

  /** Shows the window and brings it to the front. */
  show(): void {
    this.send("show");
  }

  hide(): void {
    this.send("hide");
  }

  title(text: string): void {
    this.send(`title\t${clean(text, 100)}`);
  }

  /** Adds lines to the window's activity log. */
  log(text: string): void {
    for (const line of text.split(/\r?\n/)) if (line.trim()) this.send(`log\t${clean(line.trimEnd(), 500)}`);
  }

  /** The pairing QR code (a small PNG, one pixel per module), the address to type and the code. */
  pairing(png: Buffer, address: string, code: string): void {
    this.send(`qr\t${png.toString("base64")}\t${clean(address, 100)}\t${clean(code, 20)}`);
  }

  /** Paired phones as "name" and "last used" pairs. */
  phones(list: Array<{ name: string; lastUsed: string }>): void {
    const sep = (s: string) => clean(s, 80).replace(/[\u001e\u001f]/g, "");
    this.send(`phones\t${list.map((p) => `${sep(p.name)}\u001f${sep(p.lastUsed)}`).join("\u001e")}`);
  }

  /** Shows "Update to Ward x" in the tray menu (null hides it). */
  setUpdate(version: string | null): void {
    this.send(`update\t${version ?? ""}`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.send("exit");
    this.disposed = true;
    this.child.stdin?.end();
    // If the script hangs, don't leave it behind.
    setTimeout(() => this.child.kill(), 2000).unref();
  }
}
