/**
 * Ward entry point.
 *
 *   ward                 run the LAN server for the phone
 *   ward --events        test mode: print LCU events, no server
 *
 * Options: --host <lan-ip>  --port <n>  --league-dir <path>  --no-update-check  --no-tray  --all  --dump  --help
 *
 * Ward.exe runs in the background with a tray icon, and its console window only shows it (see
 * instance.ts for why). Double-clicking Ward.exe starts the background Ward if it isn't running
 * and opens a window on it. Run from source, or with --no-tray, it's one plain console program.
 */

import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import * as sea from "node:sea";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { Champions } from "./champions";
import { CHAT_CONVERSATIONS } from "./chat";
import { runEventsMode } from "./cli/events";
import { connectToInstance, ControlServer, runViewer, type Viewer, waitForInstance } from "./instance";
import { LcuManager } from "./lcu/manager";
import { Loadout } from "./loadout";
import { addSecret, log, redact, setLogSink } from "./log";
import { WATCHED_URIS, Store } from "./state/store";
import { staticFiles } from "./server/assets";
import { FailureLimiter, formatCode, Pairing } from "./server/auth";
import { defaultDataDir, Devices, type Phone } from "./server/devices";
import { createHttpServer, expectedHost } from "./server/http";
import { isPrivateIPv4, lanCandidates } from "./server/net";
import { attachPhoneSocket } from "./server/phone-ws";
import { Tray } from "./tray";
import {
  checkForUpdate,
  cleanUpAfterUpdate,
  downloadUpdate,
  JUST_UPDATED_ENV,
  openInNewWindow,
  startInBackground,
  swapInPlace,
  type UpdateManifest,
} from "./update";
import { VERSION } from "./version";

const DEFAULT_PORT = 47800;
const RELEASES_URL = "https://github.com/OverXone/ward/releases/latest";
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** After a phone pairs, the window waits this long (so the "paired" line can be read), then hides. */
const HIDE_AFTER_PAIRING_MS = 2500;

const HELP = `Ward ${VERSION}: control the League client from your phone (same Wi-Fi).

Usage: ward [options]

  --events            Test mode: print League client events, don't start the phone server
    --all             (with --events) also list every other LCU event URI
    --dump            (with --events) save events to lcu-events-*.jsonl (ids/names scrubbed)
  --host <ip>         LAN IPv4 to listen on (default: auto-detected Wi-Fi/Ethernet address)
  --port <n>          Port to listen on (default ${DEFAULT_PORT})
  --league-dir <dir>  Use only the lockfile in this folder (skip process detection)
  --no-update-check   Don't check GitHub for a newer Ward (Ward.exe only)
  --no-tray           Run in this window only, without the tray icon (Ward.exe only)
  -h, --help          Show this help
`;

class FatalError extends Error {}

/** Throw from synchronous startup code; caught in main(). */
function fatal(message: string): never {
  throw new FatalError(message);
}

/** Logs the error and exits. When run by double-click, keeps the window open until Enter. */
let onFatal = (message: string): void => {
  log.error(message);
  if (process.stdin.isTTY) {
    console.log("\nPress Enter to close.");
    process.stdin.resume();
    process.stdin.once("data", () => process.exit(1));
  } else {
    process.exit(1);
  }
};

function exitWithError(message: string): void {
  onFatal(message);
}

/** Somewhere to print: this console, or one Ward window. */
interface Out {
  plain(text: string, raw?: boolean): void;
}

/** This console, or (in the background Ward) every open window. */
const everyone: Out = { plain: (text, raw) => log.plain(text, raw) };

function windowOut(v: Viewer): Out {
  return { plain: (text, raw = false) => v.print(raw ? text : redact(text)) };
}

function ago(t: number): string {
  const days = Math.floor((Date.now() - t) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function printPhones(out: Out, phones: readonly Phone[]): void {
  if (!phones.length) {
    out.plain("  No phones remembered.");
    return;
  }
  out.plain("  Remembered phones (they connect by themselves):");
  phones.forEach((p, i) => out.plain(`    ${i + 1}. ${p.name}, last used ${ago(p.lastSeenAt)}`));
  out.plain('  Type "forget 1" (a number) or "forget all" to remove phones.');
}

async function printPairing(out: Out, base: string, ticket: string, code: string): Promise<void> {
  // The ticket goes after #, so the phone never sends it in a request line or Referer.
  const qr = await QRCode.toString(`${base}/#p=${ticket}`, { type: "terminal", small: true, errorCorrectionLevel: "L" });
  out.plain("  To add a phone, scan with its camera (same Wi-Fi as this PC):");
  out.plain(qr, true);
  out.plain(`  Or open  ${base}  on the phone and enter code:  ${formatCode(code)}`);
  out.plain("  (the QR code works once; the code works once, for 5 minutes. Press Enter for new ones)");
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/**
 * Downloads `manifest`'s exe and puts it in place of this one, then calls `stop` and `restart`.
 * Returns false (with Ward.exe untouched) if anything before the swap fails; the caller carries on
 * with the current version.
 */
async function installUpdate(
  manifest: UpdateManifest,
  stop: () => void,
  restart: (version: string) => boolean,
): Promise<boolean> {
  const exe = process.execPath;
  const next = `${exe}.new`;
  log.plain(`  Downloading Ward ${manifest.version} (${mb(manifest.size)})...`);
  const tty = process.stdout.isTTY;
  try {
    await downloadUpdate({
      manifest,
      dest: next,
      current: VERSION,
      onProgress: (p) => tty && process.stdout.write(`\r  ${p}%`),
    });
    if (tty) process.stdout.write("\n");
  } catch (e) {
    if (tty) process.stdout.write("\n");
    log.plain(`  The update didn't download (${(e as Error).message}). Carrying on with ${VERSION}.`);
    return false;
  }
  try {
    swapInPlace(exe, next);
  } catch (e) {
    rmSync(next, { force: true });
    log.plain(`  Couldn't replace ${path.basename(exe)} (${(e as Error).message}).`);
    log.plain(`  Carrying on with ${VERSION}. To update, download Ward ${manifest.version} from ${RELEASES_URL}`);
    return false;
  }
  stop();
  if (restart(manifest.version)) return true;
  // Only when an argument can't be passed through cmd.exe safely (it contains " % or ^).
  exitWithError(`Updated to Ward ${manifest.version}. Start ${path.basename(exe)} again (with the same options).`);
  return true;
}

/** Restarts in a new console window (the current one closes). */
function restartInNewWindow(version: string): boolean {
  const args = process.argv.slice(2).filter((a) => a !== "--background" && a !== "--attach");
  if (!openInNewWindow(process.execPath, args, { [JUST_UPDATED_ENV]: version })) return false;
  log.plain(`  Updated to Ward ${version}. Restarting in a new window...`);
  process.exit(0);
}

/** Checked once before the server starts, so updating never interrupts a connected phone. */
async function updateAtStartup(): Promise<boolean> {
  log.plain(`  Ward ${VERSION}: checking for updates...`);
  const result = await checkForUpdate({ current: VERSION });
  if (result.kind === "error") {
    log.plain(`  Couldn't check for updates (${result.message}). Starting anyway.`);
    return false;
  }
  if (result.kind === "current") return false;
  return installUpdate(result.manifest, () => {}, restartInNewWindow);
}

interface ServerOptions {
  host?: string;
  port: number;
  leagueDir?: string;
  updates: boolean;
}

interface ServerHooks {
  /** The last line of the banner: how to keep Ward running and how to quit. */
  footer: string;
  onPaired(): void;
  onUpdateAvailable(version: string): void;
  /** After an update was put in place: start the new Ward (and exit). False if it can't. */
  restart(version: string): boolean;
  quit(): void;
}

interface WardServer {
  /** Resolves once phones can connect. */
  listening: Promise<void>;
  /** Version, a fresh QR code and pairing code, phones, and how to quit. */
  banner(out: Out): Promise<void>;
  /** A line typed in the window. */
  command(line: string, out: Out): void;
  update(out: Out): Promise<void>;
  stop(): void;
}

/** The phone server and the League connection. Prints through `log` (console or windows). */
function startServer(opts: ServerOptions, hooks: ServerHooks): WardServer {
  const devices = new Devices({ file: path.join(defaultDataDir(), "phones.json") });
  const previousAddress = devices.previousAddress;
  const candidates = lanCandidates();
  let host = opts.host;
  if (host) {
    if (!isPrivateIPv4(host)) fatal(`--host ${host} is not a private LAN address (10.x, 172.16-31.x, 192.168.x).`);
    const local = Object.values(os.networkInterfaces()).flat().some((i) => i?.address === host);
    if (!local) fatal(`--host ${host} is not an address of this PC.`);
  } else {
    // Prefer last run's address when this PC still has it, so remembered phones keep working
    // even if Windows lists the network adapters in a different order.
    const lastIp = previousAddress?.split(":")[0];
    host = candidates.find((c) => c.address === lastIp)?.address ?? candidates[0]?.address;
    if (!host) fatal("No private LAN (Wi-Fi/Ethernet) IPv4 address found. Is this PC connected to your home network?");
  }
  const lanHost = host as string;
  const others = candidates.map((c) => `${c.address} (${c.name})`).filter((s) => !s.startsWith(lanHost + " "));

  const pairing = new Pairing();
  const base = `http://${lanHost}:${opts.port}`;
  const newTicket = () => {
    const t = pairing.issueTicket();
    addSecret(t);
    return t;
  };
  const limiter = new FailureLimiter();
  const store = new Store();
  const champions = new Champions();
  const loadout = new Loadout();
  const manager = new LcuManager({ leagueDir: opts.leagueDir });

  manager.on("status", (s) => store.setLcuStatus(s));
  manager.on("connected", (http, creds) => {
    store.attach(http);
    champions.attach(http);
    loadout.attach(http);
    log.info(`League client connected (port ${creds.port}, found via ${creds.source}).`);
  });
  manager.on("disconnected", () => {
    store.detach();
    champions.detach();
    loadout.attach(null);
    log.info("League client closed. Waiting for it to start again...");
  });
  manager.on("discovery", (r) => {
    if (!r.credentials) log.info(`Waiting for the League client (${r.notes.join("; ")})`);
  });
  manager.on("event", (e) => {
    if (WATCHED_URIS.has(e.uri) || e.uri.startsWith(CHAT_CONVERSATIONS)) store.handleEvent(e);
  });
  store.on("phase", (p) => log.info(`Game phase: ${p ?? "unknown"}`));

  const server = createHttpServer({
    host: lanHost,
    port: opts.port,
    devices,
    pairing,
    onPaired: (_phone, via) => {
      log.plain(
        via === "qr"
          ? "\n  Phone paired. It will reconnect by itself from now on. The QR code is used up; press Enter for a new one.\n"
          : "\n  Phone paired. It will reconnect by itself from now on.\n",
      );
      hooks.onPaired();
    },
    limiter,
    champions,
    loadout,
    store,
    getLcu: () => manager.http,
    staticFiles: staticFiles(),
  });
  const phoneSocket = attachPhoneSocket(server, { host: expectedHost({ host: lanHost, port: opts.port }), devices, limiter, store });

  // Right after an update the previous Ward may still be letting go of the port.
  let portRetries = process.env[JUST_UPDATED_ENV] ? 10 : 0;
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE" && portRetries-- > 0) {
      setTimeout(() => server.listen(opts.port, lanHost), 500);
      return;
    }
    manager.stop();
    if (e.code === "EADDRINUSE") exitWithError(`Port ${opts.port} is already in use. Is Ward already running? (or use --port)`);
    else if (e.code === "EADDRNOTAVAIL") exitWithError(`Can't listen on ${lanHost}. Did the network change? Try again or use --host.`);
    else exitWithError(`Server error: ${e.message}`);
  });

  const listening = new Promise<void>((resolve) =>
    server.listen(opts.port, lanHost, () => {
      devices.rememberAddress(`${lanHost}:${opts.port}`);
      resolve();
    }),
  );
  // The League connection starts after the first banner, so its log lines come below the QR code.
  let managerStarted = false;

  const banner = async (out: Out): Promise<void> => {
    const phones = devices.list();
    out.plain("");
    out.plain(`  Ward ${VERSION}`);
    await printPairing(out, base, newTicket(), pairing.issue());
    if (others.length) out.plain(`  Other LAN addresses found: ${others.join(", ")} (use --host to pick one)`);
    out.plain("");
    printPhones(out, phones);
    if (phones.length && previousAddress && `http://${previousAddress}` !== base)
      out.plain(
        `  This PC's address changed (it was ${previousAddress}), so these phones need to scan the QR code once more.`,
      );
    out.plain(`  ${hooks.footer}\n`);
    if (!managerStarted) {
      managerStarted = true;
      manager.start();
    }
  };

  const stop = () => {
    phoneSocket.close();
    manager.stop();
    server.close();
  };

  // While running: look for a new release now and then, and say so once.
  let available: UpdateManifest | null = null;
  let updating = false;
  const checkNow = async (): Promise<void> => {
    const result = await checkForUpdate({ current: VERSION });
    if (result.kind !== "update" || result.manifest.version === available?.version) return;
    available = result.manifest;
    log.plain(
      `\n  Ward ${available.version} is available. Type "update" to install it and restart (phones reconnect by themselves).\n`,
    );
    hooks.onUpdateAvailable(available.version);
  };
  if (opts.updates) setInterval(() => void checkNow(), UPDATE_CHECK_EVERY_MS).unref();

  const update = async (out: Out): Promise<void> => {
    if (!sea.isSea()) return out.plain("\n  Updating only works in Ward.exe. From source, use git pull.\n");
    if (updating) return;
    updating = true;
    try {
      if (!available) {
        out.plain("");
        const result = await checkForUpdate({ current: VERSION });
        if (result.kind === "error") return out.plain(`  Couldn't check for updates (${result.message}).\n`);
        if (result.kind === "current") return out.plain(`  Ward ${VERSION} is the latest version.\n`);
        available = result.manifest;
      }
      log.plain("");
      await installUpdate(available, stop, hooks.restart);
      log.plain("");
    } finally {
      updating = false;
    }
  };

  const command = (line: string, out: Out): void => {
    const cmd = line.trim().toLowerCase();
    if (updating) return;
    if (cmd === "update") return void update(out);
    if (cmd === "quit" || cmd === "exit") return hooks.quit();
    if (cmd === "phones") {
      out.plain("");
      printPhones(out, devices.list());
      out.plain("");
      return;
    }
    const forget = /^forget\s+(all|\d+)$/.exec(cmd);
    if (forget) {
      const phones = devices.list();
      if (forget[1] === "all") {
        const n = devices.clear();
        out.plain(`\n  Forgot ${n} phone${n === 1 ? "" : "s"}. They need to pair again.\n`);
      } else {
        const p = phones[Number(forget[1]) - 1];
        if (p && devices.remove(p.id)) out.plain(`\n  Forgot ${p.name}. It needs to pair again.\n`);
        else out.plain(`\n  There's no phone ${forget[1]}. Type "phones" to see the list.\n`);
      }
      return;
    }
    if (cmd !== "") {
      out.plain(
        '\n  Commands: Enter = new QR code and pairing code, "phones", "forget <number>", "forget all", "update", "quit".\n',
      );
      return;
    }
    out.plain("");
    void printPairing(out, base, newTicket(), pairing.issue()).then(() => out.plain(""));
  };

  return { listening, banner, command, update, stop };
}

/** One plain console program: from source, with --no-tray, or if the background Ward can't start. */
function runInConsole(opts: ServerOptions): void {
  let rl: readline.Interface | null = null;
  const shutdown = () => {
    log.info("Shutting down.");
    rl?.close();
    server.stop();
    process.exit(0);
  };
  const server = startServer(opts, {
    footer: 'Keep this window open while you play. Type "phones" to list phones, Ctrl+C to quit.',
    onPaired: () => {},
    onUpdateAvailable: () => {},
    restart: (version) => {
      rl?.close();
      return restartInNewWindow(version);
    },
    quit: shutdown,
  });
  void server.listening.then(() => server.banner(everyone));
  if (process.stdin.isTTY) {
    rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => server.command(line, everyone));
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * The background Ward: no window of its own. It shows a tray icon, and everything it prints goes
 * to the open Ward windows. Windows can come and go; closing them keeps Ward running.
 */
async function runInBackground(opts: ServerOptions): Promise<void> {
  const dataDir = defaultDataDir();
  let control: ControlServer;
  try {
    control = await ControlServer.start(dataDir);
  } catch {
    process.exit(1); // the window waiting for us falls back to running Ward itself
  }

  // Windows opened later get the last few log lines, then a fresh banner.
  const recent: string[] = [];
  setLogSink((text, kind) => {
    if (kind !== "plain") {
      recent.push(text);
      if (recent.length > 15) recent.shift();
    }
    control.broadcast(text);
  });

  let dying = false;
  let leaving = false; // quitting or restarting: windows closing is expected
  let tray: Tray | null = null;
  onFatal = (message) => {
    log.error(message);
    dying = true;
    for (const v of control.viewers) v.bye("", true);
    // Give a window that is still connecting a moment to show the error.
    setTimeout(
      () => {
        tray?.dispose();
        control.close();
        process.exit(1);
      },
      control.viewers.size ? 500 : 5000,
    );
  };

  const exe = process.execPath;
  cleanUpAfterUpdate(exe);
  if (process.env[JUST_UPDATED_ENV]) log.info(`Ward updated to ${VERSION}.`);

  tray = await Tray.start({ exe, dataDir });
  if (!tray) log.warn("Couldn't show the tray icon, so closing the window quits Ward.");

  const shutdown = () => {
    if (leaving) return;
    leaving = true;
    log.info("Shutting down.");
    for (const v of control.viewers) v.bye("  Ward has quit.");
    server.stop();
    tray?.dispose();
    control.close();
    setTimeout(() => process.exit(0), 300);
  };

  const openWindow = () => {
    const first = [...control.viewers][0];
    if (first && tray) tray.focus(first.pid);
    else openInNewWindow(exe, ["--attach"]);
  };

  let toldAboutTray = false;
  let hiding = false;

  const server = startServer(opts, {
    footer: tray
      ? 'Closing this window keeps Ward running in the tray. Type "phones" to list phones, "quit" or Ctrl+C to quit.'
      : 'Keep this window open while you play. Type "phones" to list phones, "quit" or Ctrl+C to quit.',
    onPaired: () => {
      if (!tray || !control.viewers.size) return;
      setTimeout(() => {
        if (!tray || leaving) return;
        hiding = true;
        for (const v of control.viewers) v.hide();
        setTimeout(() => (hiding = false), 2000);
        toldAboutTray = true;
        tray.notify("Ward is running in the tray", "Your phone is paired. Click the Ward icon to open the window again.");
      }, HIDE_AFTER_PAIRING_MS);
    },
    onUpdateAvailable: (version) => {
      tray?.setUpdate(version);
      tray?.notify(`Ward ${version} is available`, "Right-click the Ward icon and choose Update.");
    },
    restart: (version) => {
      leaving = true;
      log.plain(`  Updated to Ward ${version}. Restarting...`);
      // No goodbye: the windows wait for the new Ward and reconnect to it.
      for (const v of control.viewers) v.drop();
      tray?.dispose();
      control.close();
      startInBackground(exe, process.argv.slice(2), { [JUST_UPDATED_ENV]: version });
      setTimeout(() => process.exit(0), 300);
      return true;
    },
    quit: shutdown,
  });

  let listening = false;
  const welcomed = new WeakSet<Viewer>();
  const welcome = (v: Viewer) => {
    if (welcomed.has(v)) return;
    welcomed.add(v);
    void server.banner(windowOut(v));
  };
  void server.listening.then(() => {
    listening = true;
    for (const v of control.viewers) welcome(v);
  });

  control.on("viewer", (v) => {
    for (const line of recent) v.print(line);
    if (dying) return v.bye("", true);
    if (listening) welcome(v);
    v.on("line", (line) => server.command(line, windowOut(v)));
    v.on("quit", shutdown);
    v.on("close", () => {
      if (leaving || dying || control.viewers.size) return;
      // Without a tray icon there'd be no way back to Ward, so closing the window quits it, as before.
      if (!tray) return shutdown();
      if (!hiding && !toldAboutTray) {
        toldAboutTray = true;
        tray.notify("Ward is still running", "It keeps your phone connected. Click the Ward icon to open it, or right-click it to quit.");
      }
    });
  });

  tray?.on("open", openWindow);
  tray?.on("openNew", () => openInNewWindow(exe, ["--attach"]));
  tray?.on("update", () => void server.update(everyone));
  tray?.on("quit", shutdown);
  tray?.on("gone", () => {
    tray = null;
    log.warn("The tray icon stopped, so closing the window quits Ward.");
    if (!control.viewers.size) shutdown();
  });
  process.on("SIGTERM", shutdown);
}

/** This process is a Ward window: start the background Ward if needed and show it. */
async function runWindow(opts: ServerOptions, attachOnly: boolean): Promise<boolean> {
  process.title = "Ward";
  const dataDir = defaultDataDir();
  const running = await connectToInstance(dataDir);
  if (running) {
    runViewer(running, dataDir);
    return true;
  }
  if (attachOnly) {
    exitWithError("Ward isn't running. Start Ward.exe.");
    return true;
  }

  cleanUpAfterUpdate(process.execPath);
  const justUpdated = process.env[JUST_UPDATED_ENV];
  if (justUpdated) log.plain(`  Ward updated to ${VERSION}.`);
  else if (opts.updates && (await updateAtStartup())) return true;

  log.plain("  Starting Ward...");
  startInBackground(process.execPath, [...process.argv.slice(2), "--background"]);
  const socket = await waitForInstance(dataDir, 20_000);
  if (socket) {
    runViewer(socket, dataDir);
    return true;
  }
  log.warn("Ward couldn't start in the background, so it runs in this window instead.");
  return false;
}

async function main(): Promise<void> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        events: { type: "boolean" },
        all: { type: "boolean" },
        dump: { type: "boolean" },
        host: { type: "string" },
        port: { type: "string" },
        "league-dir": { type: "string" },
        "no-update-check": { type: "boolean" },
        "no-tray": { type: "boolean" },
        // Internal: the background Ward, and a window opened from the tray.
        background: { type: "boolean" },
        attach: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (e) {
    console.log(HELP);
    return fatal((e as Error).message);
  }

  if (values.help) {
    console.log(HELP);
    return;
  }

  const leagueDir = typeof values["league-dir"] === "string" ? values["league-dir"] : undefined;

  if (values.events) {
    runEventsMode({ leagueDir, all: !!values.all, dump: !!values.dump });
    return;
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fatal("--port must be a number between 1024 and 65535");

  // Only the packaged exe updates itself and has a tray icon; from source, git pull updates.
  const opts: ServerOptions = {
    host: typeof values.host === "string" ? values.host : undefined,
    port,
    leagueDir,
    updates: sea.isSea() && !values["no-update-check"],
  };

  if (values.background) return runInBackground(opts);
  if (sea.isSea() && !values["no-tray"]) {
    if (await runWindow(opts, !!values.attach)) return;
  } else {
    if (sea.isSea()) cleanUpAfterUpdate(process.execPath);
    if (process.env[JUST_UPDATED_ENV]) log.plain(`  Ward updated to ${VERSION}.`);
    else if (opts.updates && (await updateAtStartup())) return;
  }
  runInConsole(opts);
}

process.on("uncaughtException", (e) => exitWithError(`Unexpected error: ${e.message}`));
main().catch((e) => exitWithError(e instanceof FatalError ? e.message : `Unexpected error: ${(e as Error).message}`));
