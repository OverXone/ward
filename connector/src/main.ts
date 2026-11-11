/**
 * Ward entry point.
 *
 *   ward                 run the LAN server for the phone
 *   ward --events        test mode: print LCU events, no server
 *
 * Options: --host <lan-ip>  --port <n>  --league-dir <path>  --all  --dump  --help
 */

import os from "node:os";
import readline from "node:readline";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { Champions } from "./champions";
import { runEventsMode } from "./cli/events";
import { LcuManager } from "./lcu/manager";
import { addSecret, log } from "./log";
import { WATCHED_URIS, Store } from "./state/store";
import { staticFiles } from "./server/assets";
import { FailureLimiter, formatCode, generateToken, Pairing } from "./server/auth";
import { createHttpServer, expectedHost } from "./server/http";
import { isPrivateIPv4, lanCandidates } from "./server/net";
import { attachPhoneSocket } from "./server/phone-ws";

const VERSION = "0.1.0";
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

async function printBanner(host: string, port: number, token: string, code: string, others: string[]): Promise<void> {
  const base = `http://${host}:${port}`;
  const qr = await QRCode.toString(`${base}/?t=${token}`, { type: "terminal", small: true, errorCorrectionLevel: "L" });
  log.plain("");
  log.plain(`  Ward ${VERSION}`);
  log.plain("  Scan with your phone camera (phone must be on the same Wi-Fi):");
  log.plain(qr, true);
  log.plain(`  Or open  ${base}  on the phone and enter code:  ${formatCode(code)}`);
  log.plain("  (code works once, for 5 minutes. Press Enter here for a new one)");
  if (others.length) log.plain(`  Other LAN addresses found: ${others.join(", ")} (use --host to pick one)`);
  log.plain("  Keep this window open while you play. Ctrl+C to quit.\n");
}

function runServer(opts: { host?: string; port: number; leagueDir?: string }): void {
  const candidates = lanCandidates();
  let host = opts.host;
  if (host) {
    if (!isPrivateIPv4(host)) fatal(`--host ${host} is not a private LAN address (10.x, 172.16-31.x, 192.168.x).`);
    const local = Object.values(os.networkInterfaces()).flat().some((i) => i?.address === host);
    if (!local) fatal(`--host ${host} is not an address of this PC.`);
  } else {
    host = candidates[0]?.address;
    if (!host) fatal("No private LAN (Wi-Fi/Ethernet) IPv4 address found. Is this PC connected to your home network?");
  }
  const lanHost = host as string;
  const others = candidates.map((c) => `${c.address} (${c.name})`).filter((s) => !s.startsWith(lanHost + " "));

  const token = generateToken();
  addSecret(token);
  const pairing = new Pairing();
  const limiter = new FailureLimiter();
  const store = new Store();
  const champions = new Champions();
  const manager = new LcuManager({ leagueDir: opts.leagueDir });

  manager.on("status", (s) => store.setLcuStatus(s));
  manager.on("connected", (http, creds) => {
    store.attach(http);
    champions.attach(http);
    log.info(`League client connected (port ${creds.port}, found via ${creds.source}).`);
  });
  manager.on("disconnected", () => {
    store.detach();
    champions.detach();
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
    token,
    pairing,
    limiter,
    champions,
    store,
    getLcu: () => manager.http,
    staticFiles: staticFiles(),
  });
  const phoneSocket = attachPhoneSocket(server, { host: expectedHost({ host: lanHost, port: opts.port }), token, limiter, store });

  server.on("error", (e: NodeJS.ErrnoException) => {
    manager.stop();
    if (e.code === "EADDRINUSE") exitWithError(`Port ${opts.port} is already in use. Is Ward already running? (or use --port)`);
    else if (e.code === "EADDRNOTAVAIL") exitWithError(`Can't listen on ${lanHost}. Did the network change? Try again or use --host.`);
    else exitWithError(`Server error: ${e.message}`);
  });

  server.listen(opts.port, lanHost, () => {
    void printBanner(lanHost, opts.port, token, pairing.issue(), others).then(() => manager.start());
  });

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", () => {
      const code = pairing.issue();
      log.plain(`\n  New pairing code:  ${formatCode(code)}  (works once, 5 minutes)\n`);
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
