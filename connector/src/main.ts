/**
 * Ward entry point.
 *
 *   ward                 run the LAN server for the phone
 *   ward --events        test mode: print LCU events, no server
 *
 * Options: --host <lan-ip>  --port <n>  --league-dir <path>  --all  --dump  --help
 */

import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { Champions } from "./champions";
import { runEventsMode } from "./cli/events";
import { LcuManager } from "./lcu/manager";
import { Loadout } from "./loadout";
import { addSecret, log } from "./log";
import { WATCHED_URIS, Store } from "./state/store";
import { staticFiles } from "./server/assets";
import { FailureLimiter, formatCode, Pairing } from "./server/auth";
import { defaultDataDir, Devices, type Phone } from "./server/devices";
import { createHttpServer, expectedHost } from "./server/http";
import { isPrivateIPv4, lanCandidates } from "./server/net";
import { attachPhoneSocket } from "./server/phone-ws";

const VERSION = "0.3.0";
const DEFAULT_PORT = 47800;

const HELP = `Ward ${VERSION}: control the League client from your phone (same Wi-Fi).

Usage: ward [options]

  --events            Test mode: print League client events, don't start the phone server
    --all             (with --events) also list every other LCU event URI
    --dump            (with --events) save events to lcu-events-*.jsonl (ids/names scrubbed)
  --host <ip>         LAN IPv4 to listen on (default: auto-detected Wi-Fi/Ethernet address)
  --port <n>          Port to listen on (default ${DEFAULT_PORT})
  --league-dir <dir>  Use only the lockfile in this folder (skip process detection)
  -h, --help          Show this help
`;

class FatalError extends Error {}

/** Throw from synchronous startup code; caught in main(). */
function fatal(message: string): never {
  throw new FatalError(message);
}

/** Logs the error and exits. When run by double-click, keeps the window open until Enter. */
function exitWithError(message: string): void {
  log.error(message);
  if (process.stdin.isTTY) {
    console.log("\nPress Enter to close.");
    process.stdin.resume();
    process.stdin.once("data", () => process.exit(1));
  } else {
    process.exit(1);
  }
}

function ago(t: number): string {
  const days = Math.floor((Date.now() - t) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function printPhones(phones: readonly Phone[]): void {
  if (!phones.length) {
    log.plain("  No phones remembered.");
    return;
  }
  log.plain("  Remembered phones (they connect by themselves):");
  phones.forEach((p, i) => log.plain(`    ${i + 1}. ${p.name}, last used ${ago(p.lastSeenAt)}`));
  log.plain('  Type "forget 1" (a number) or "forget all" to remove phones.');
}

async function printPairing(base: string, ticket: string, code: string): Promise<void> {
  // The ticket goes after #, so the phone never sends it in a request line or Referer.
  const qr = await QRCode.toString(`${base}/#p=${ticket}`, { type: "terminal", small: true, errorCorrectionLevel: "L" });
  log.plain("  To add a phone, scan with its camera (same Wi-Fi as this PC):");
  log.plain(qr, true);
  log.plain(`  Or open  ${base}  on the phone and enter code:  ${formatCode(code)}`);
  log.plain("  (the QR code works once; the code works once, for 5 minutes. Press Enter for new ones)");
}

async function printBanner(opts: {
  base: string;
  ticket: string;
  code: string;
  others: string[];
  phones: readonly Phone[];
  previousAddress?: string;
}): Promise<void> {
  log.plain("");
  log.plain(`  Ward ${VERSION}`);
  await printPairing(opts.base, opts.ticket, opts.code);
  if (opts.others.length) log.plain(`  Other LAN addresses found: ${opts.others.join(", ")} (use --host to pick one)`);
  log.plain("");
  printPhones(opts.phones);
  if (opts.phones.length && opts.previousAddress && `http://${opts.previousAddress}` !== opts.base)
    log.plain(
      `  This PC's address changed (it was ${opts.previousAddress}), so these phones need to scan the QR code once more.`,
    );
  log.plain('  Keep this window open while you play. Type "phones" to list phones, Ctrl+C to quit.\n');
}

function runServer(opts: { host?: string; port: number; leagueDir?: string }): void {
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
    if (WATCHED_URIS.has(e.uri)) store.handleEvent(e);
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
    },
    limiter,
    champions,
    loadout,
    store,
    getLcu: () => manager.http,
    staticFiles: staticFiles(),
  });
  const phoneSocket = attachPhoneSocket(server, { host: expectedHost({ host: lanHost, port: opts.port }), devices, limiter, store });

  server.on("error", (e: NodeJS.ErrnoException) => {
    manager.stop();
    if (e.code === "EADDRINUSE") exitWithError(`Port ${opts.port} is already in use. Is Ward already running? (or use --port)`);
    else if (e.code === "EADDRNOTAVAIL") exitWithError(`Can't listen on ${lanHost}. Did the network change? Try again or use --host.`);
    else exitWithError(`Server error: ${e.message}`);
  });

  server.listen(opts.port, lanHost, () => {
    const phones = devices.list();
    devices.rememberAddress(`${lanHost}:${opts.port}`);
    void printBanner({ base, ticket: newTicket(), code: pairing.issue(), others, phones, previousAddress }).then(() =>
      manager.start(),
    );
  });

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const cmd = line.trim().toLowerCase();
      if (cmd === "phones") {
        log.plain("");
        printPhones(devices.list());
        log.plain("");
        return;
      }
      const forget = /^forget\s+(all|\d+)$/.exec(cmd);
      if (forget) {
        const phones = devices.list();
        if (forget[1] === "all") {
          const n = devices.clear();
          log.plain(`\n  Forgot ${n} phone${n === 1 ? "" : "s"}. They need to pair again.\n`);
        } else {
          const p = phones[Number(forget[1]) - 1];
          if (p && devices.remove(p.id)) log.plain(`\n  Forgot ${p.name}. It needs to pair again.\n`);
          else log.plain(`\n  There's no phone ${forget[1]}. Type "phones" to see the list.\n`);
        }
        return;
      }
      if (cmd !== "") {
        log.plain('\n  Commands: Enter = new QR code and pairing code, "phones", "forget <number>", "forget all".\n');
        return;
      }
      log.plain("");
      void printPairing(base, newTicket(), pairing.issue()).then(() => log.plain(""));
    });
  }

  const shutdown = () => {
    log.info("Shutting down.");
    phoneSocket.close();
    manager.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function main(): void {
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

  runServer({ host: typeof values.host === "string" ? values.host : undefined, port, leagueDir });
}

process.on("uncaughtException", (e) => exitWithError(`Unexpected error: ${e.message}`));
try {
  main();
} catch (e) {
  exitWithError(e instanceof FatalError ? e.message : `Unexpected error: ${(e as Error).message}`);
}
