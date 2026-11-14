/**
 * Ward in the background, and the windows that show it.
 *
 * A console window can't refuse to close: Windows ends the program a few seconds after the
 * window's X is clicked. So Ward.exe runs in two parts:
 *   - the background Ward (no window): the phone server, the League connection and the tray icon;
 *   - Ward windows: consoles that show the background Ward's output and pass typed commands to it.
 * Closing a window (or hiding it to the tray) leaves the background Ward running.
 *
 * They talk over a named pipe, one JSON object per line. The pipe's name and a 32-byte secret are
 * in instance.json in the data folder (%APPDATA%\Ward), which only this Windows user can read.
 * Other users on the PC can see that the pipe exists, but the background Ward sends nothing until
 * the secret arrives, and the output (QR codes) never reaches them.
 *
 *   window -> Ward:  {"t":"hello","token":"...","pid":123}  {"t":"line","line":"phones"}  {"t":"quit"}
 *   Ward -> window:  {"t":"out","text":"..."}  {"t":"hide"}  {"t":"bye","text":"...","error":true}
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

export interface InstanceInfo {
  pid: number;
  pipe: string;
  token: string;
}

const AUTH_TIMEOUT_MS = 3000;
const MAX_LINE = 4096;

export const instanceFile = (dataDir: string) => path.join(dataDir, "instance.json");

export function readInstance(dataDir: string): InstanceInfo | null {
  try {
    const j = JSON.parse(readFileSync(instanceFile(dataDir), "utf8")) as Partial<InstanceInfo>;
    if (typeof j.pid !== "number" || typeof j.pipe !== "string" || typeof j.token !== "string") return null;
    if (!j.pipe.startsWith("\\\\.\\pipe\\ward-")) return null;
    return j as InstanceInfo;
  } catch {
    return null;
  }
}

function sameToken(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Reads JSON lines from a socket, dropping anything malformed or too long. */
function jsonLines(socket: net.Socket, onMessage: (msg: Record<string, unknown>) => void): void {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as unknown;
        if (msg && typeof msg === "object") onMessage(msg as Record<string, unknown>);
      } catch {
        // ignore
      }
    }
    if (buf.length > MAX_LINE * 16) socket.destroy();
  });
}

function write(socket: net.Socket, msg: object): void {
  if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(msg) + "\n");
}

// ---- the background Ward's side ----

export interface ViewerEvents {
  line: [line: string];
  quit: [];
  close: [];
}

/** One open Ward window, as seen from the background Ward. */
export class Viewer extends EventEmitter<ViewerEvents> {
  constructor(
    private readonly socket: net.Socket,
    /** The window's process id (so the tray can bring it to the front). */
    readonly pid: number,
  ) {
    super();
  }

  print(text: string): void {
    write(this.socket, { t: "out", text });
  }

  /** Closes the window (Ward keeps running in the tray). */
  hide(): void {
    write(this.socket, { t: "hide" });
  }

  /** Tells the window Ward is quitting, then hangs up. */
  bye(text = "", error = false): void {
    write(this.socket, { t: "bye", text, error });
    this.socket.end();
  }

  /** Hangs up without a goodbye: the window waits for Ward to come back (after an update). */
  drop(): void {
    this.socket.end();
  }
}

export interface ControlEvents {
  viewer: [viewer: Viewer];
}

export class ControlServer extends EventEmitter<ControlEvents> {
  readonly viewers = new Set<Viewer>();

  private constructor(
    private readonly server: net.Server,
    private readonly dataDir: string,
  ) {
    super();
  }

  /** Opens the pipe and writes instance.json. */
  static start(dataDir: string): Promise<ControlServer> {
    const info: InstanceInfo = {
      pid: process.pid,
      pipe: `\\\\.\\pipe\\ward-${randomBytes(16).toString("hex")}`,
      token: randomBytes(32).toString("hex"),
    };
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      const control = new ControlServer(server, dataDir);
      server.on("connection", (socket) => control.accept(socket, info.token));
      server.once("error", reject);
      server.listen(info.pipe, () => {
        server.off("error", reject);
        try {
          mkdirSync(dataDir, { recursive: true });
          writeFileSync(instanceFile(dataDir), JSON.stringify(info), { mode: 0o600 });
        } catch (e) {
          server.close();
          return reject(e);
        }
        resolve(control);
      });
    });
  }

  private accept(socket: net.Socket, token: string): void {
    let viewer: Viewer | null = null;
    socket.on("error", () => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
    jsonLines(socket, (msg) => {
      if (!viewer) {
        clearTimeout(timer);
        if (msg.t !== "hello" || !sameToken(msg.token, token)) return void socket.destroy();
        viewer = new Viewer(socket, Number.isInteger(msg.pid) ? (msg.pid as number) : 0);
        this.viewers.add(viewer);
        this.emit("viewer", viewer);
        return;
      }
      if (msg.t === "line" && typeof msg.line === "string") viewer.emit("line", msg.line.slice(0, MAX_LINE));
      else if (msg.t === "quit") viewer.emit("quit");
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!viewer) return;
      this.viewers.delete(viewer);
      viewer.emit("close");
    });
  }

  broadcast(text: string): void {
    for (const v of this.viewers) v.print(text);
  }

  close(): void {
    this.server.close();
    // Only remove the file if it's still ours (a newer Ward may have replaced it).
    if (readInstance(this.dataDir)?.pid === process.pid) rmSync(instanceFile(this.dataDir), { force: true });
  }
}

// ---- the window's side ----

/** Connects to the running background Ward. Null if none is running (or it doesn't answer). */
export function connectToInstance(dataDir: string, timeoutMs = 2000): Promise<net.Socket | null> {
  const info = readInstance(dataDir);
  if (!info) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = net.connect(info.pipe);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      write(socket, { t: "hello", token: info.token, pid: process.pid });
      resolve(socket);
    });
  });
}

/** Tries to connect for up to `waitMs` (while a background Ward is starting or restarting). */
export async function waitForInstance(dataDir: string, waitMs: number): Promise<net.Socket | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    const socket = await connectToInstance(dataDir);
    if (socket || Date.now() > until) return socket;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Runs this process as a Ward window: shows the background Ward's output and passes typed lines
 * to it. Ctrl+C quits Ward entirely; closing the window leaves it running in the tray.
 */
export function runViewer(first: net.Socket, dataDir: string): void {
  let socket = first;
  let quitting = false;
  const pressEnterToClose = (code: number) => {
    if (!rl) process.exit(code);
    console.log("\nPress Enter to close.");
    rl.removeAllListeners("line");
    rl.once("line", () => process.exit(code));
  };

  const attach = (s: net.Socket) => {
    socket = s;
    s.on("error", () => s.destroy());
    jsonLines(s, (msg) => {
      if (msg.t === "out" && typeof msg.text === "string") console.log(msg.text);
      else if (msg.t === "hide") process.exit(0);
      else if (msg.t === "bye") {
        quitting = true;
        if (typeof msg.text === "string" && msg.text) console.log(msg.text);
        if (msg.error) pressEnterToClose(1);
        else process.exit(0);
      }
    });
    s.on("close", () => {
      if (quitting || s !== socket) return;
      // No goodbye: Ward is restarting (an update). Wait for the new one.
      void waitForInstance(dataDir, 30_000).then((next) => {
        if (next) attach(next);
        else {
          console.log("\n  Ward isn't running any more.");
          quitting = true;
          pressEnterToClose(1);
        }
      });
    });
  };
  attach(first);

  const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin }) : null;
  rl?.on("line", (line) => write(socket, { t: "line", line }));
  // Ctrl+C quits Ward (the window's text says so); the background Ward answers with "bye".
  const quit = () => {
    if (quitting) process.exit(0);
    quitting = true;
    write(socket, { t: "quit" });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  rl?.on("SIGINT", quit);
  process.on("SIGINT", quit);
}
