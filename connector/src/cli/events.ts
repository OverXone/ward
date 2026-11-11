/**
 * Test mode: `ward --events`
 *
 * Finds the client, probes every endpoint the connector uses, then prints the
 * live LCU events we listen to plus what the connector derives from them.
 * No LAN server is started in this mode.
 *
 *   --all    also print the URI of every other LCU event (no payloads)
 *   --dump   append whitelisted events + probe results to lcu-events-<time>.jsonl
 *            (account ids, names and chat credentials are scrubbed)
 */

import { appendFileSync } from "node:fs";
import path from "node:path";
import { Champions } from "../champions";
import type { DiscoveryOptions } from "../lcu/discovery";
import type { LcuHttp } from "../lcu/http";
import { LcuManager } from "../lcu/manager";
import { log } from "../log";
import { findHoverTarget, findMyActiveAction, type LcuSession } from "../state/champ-select";
import { Store, URI, WATCHED_URIS } from "../state/store";

const IDENTITY_KEY =
  /puuid|summonerId|accountId|gameName|tagLine|displayName|summonerName|internalName|playerId|nameVisibility|chatRoom|multiUserChat|jwt|password|token/i;

export function scrubIdentity(value: unknown, depth = 0): unknown {
  if (depth > 20) return "<deep>";
  if (Array.isArray(value)) return value.map((v) => scrubIdentity(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = IDENTITY_KEY.test(k) && v !== "" && v !== 0 && v !== null ? "<scrubbed>" : scrubIdentity(v, depth + 1);
    }
    return out;
  }
  return value;
}

function summarize(uri: string, data: unknown): string {
  if (data === null || data === undefined) return "(empty)";
  const d = data as Record<string, any>;
  switch (uri) {
    case URI.phase:
      return JSON.stringify(data);
    case URI.lobby:
      return `queueId=${d.gameConfig?.queueId} canStartActivity=${d.canStartActivity} isLeader=${d.localMember?.isLeader} members=${d.members?.length}`;
    case URI.search:
      return `searchState=${d.searchState} timeInQueue=${d.timeInQueue} estimated=${d.estimatedQueueTime} errors=${JSON.stringify(
        (d.errors ?? []).map((e: any) => ({ type: e.errorType, penalty: e.penaltyTimeRemaining })),
      )}`;
    case URI.readyCheck:
      return `state=${d.state} playerResponse=${d.playerResponse} timer=${d.timer}`;
    case URI.session: {
      const s = data as LcuSession;
      const mine = findMyActiveAction(s);
      const target = findHoverTarget(s);
      const acts = (s.actions ?? []).flat();
      const hasFlag = acts.some((a) => typeof a.isInProgress === "boolean");
      return (
        `timer.phase=${s.timer?.phase} timeLeft=${Math.round((s.timer?.adjustedTimeLeftInPhase ?? 0) / 1000)}s ` +
        `localCell=${s.localPlayerCellId} actions=${acts.length} (isInProgress field: ${hasFlag ? "yes" : "NO"}) ` +
        `→ myTurn=${mine ? `${mine.type}#${mine.id} champ=${mine.championId}` : "no"} ` +
        `hoverTarget=${target ? `${target.type}#${target.id}` : "none"}`
      );
    }
    case URI.pickable:
    case URI.bannable:
      return Array.isArray(data) ? `${data.length} ids` : "(not an array)";
    default:
      return "";
  }
}

const PROBES: [string, string][] = [
  ["gameflow phase", URI.phase],
  ["lobby", URI.lobby],
  ["matchmaking search", URI.search],
  ["ready check", URI.readyCheck],
  ["champ select session", URI.session],
  ["pickable champions", URI.pickable],
  ["bannable champions", URI.bannable],
];

async function probe(http: LcuHttp, dump: (r: object) => void): Promise<void> {
  log.plain("\n--- Probing endpoints (404 is normal for things you're not currently in) ---");
  for (const [label, p] of PROBES) {
    try {
      const { status, data } = await http.json("GET", p);
      log.plain(`  ${String(status).padEnd(4)} GET ${p.padEnd(46)} ${label}: ${status === 200 ? summarize(p, data) : ""}`);
      dump({ probe: p, status, data: scrubIdentity(data) });
    } catch (e) {
      log.plain(`  ERR  GET ${p}: ${(e as Error).message}`);
    }
  }
  const champions = new Champions();
  champions.attach(http);
  const list = await champions.list();
  log.plain(`  ${list ? "200 " : "FAIL"} GET /lol-game-data/assets/v1/champion-summary.json   ${list ? `${list.length} champions` : ""}`);
  const first = list?.[0];
  if (first) {
    const icon = await champions.icon(first.id);
    log.plain(`  ${icon ? "200 " : "FAIL"} GET /lol-game-data/assets/v1/champion-icons/${first.id}.png   ${icon ? `${icon.length} bytes (${first.name})` : ""}`);
  }
  log.plain("--- Live events (Ctrl+C to quit) ---\n");
}

export function runEventsMode(opts: DiscoveryOptions & { all: boolean; dump: boolean }): void {
  const dumpFile = opts.dump ? path.resolve(`lcu-events-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`) : null;
  const dump = (record: object) => {
    if (dumpFile) appendFileSync(dumpFile, JSON.stringify({ t: Date.now(), ...record }) + "\n");
  };
  if (dumpFile) log.info(`Dumping events to ${dumpFile}`);

  const manager = new LcuManager(opts);
  const store = new Store();
  let lastDerived = "";

  manager.on("discovery", (r) => {
    if (r.credentials) {
      const c = r.credentials;
      log.info(`Found League client: port=${c.port} pid=${c.pid} via=${c.source} installDir=${c.installDir ?? "?"} (password hidden)`);
    } else {
      log.info(`Waiting for League client: ${r.notes.join("; ")}`);
    }
  });
  manager.on("status", (s) => {
    log.info(`LCU status: ${s}`);
    store.setLcuStatus(s);
  });
  manager.on("connected", (http) => {
    store.attach(http);
    void probe(http, dump);
  });
  manager.on("disconnected", () => {
    store.detach();
    log.info("League client went away; waiting for it to come back...");
  });
  manager.on("event", (e) => {
    if (WATCHED_URIS.has(e.uri)) {
      log.info(`${e.eventType.padEnd(6)} ${e.uri}  ${summarize(e.uri, e.data)}`);
      dump({ uri: e.uri, eventType: e.eventType, data: scrubIdentity(e.data) });
      store.handleEvent(e);
    } else if (opts.all) {
      log.info(`${e.eventType.padEnd(6)} ${e.uri}`);
    }
  });
  store.on("change", (state) => {
    const cs = state.champSelect;
    const line =
      `derived: phase=${state.phase} ` +
      (state.readyCheck ? `readyCheck=${state.readyCheck.state}/${state.readyCheck.playerResponse} ` : "") +
      (state.queue ? `queue=${state.queue.timeInQueue}s ` : "") +
      (state.lobby ? `lobby=${state.lobby.queueName ?? state.lobby.queueId} leader=${state.lobby.isLeader} ` : "") +
      (cs
        ? `champSelect=${cs.phase} myTurn=${cs.myTurn ? `${cs.myTurn.type}(${cs.myTurn.championId})` : "no"} ` +
          `intent=${cs.canHoverIntent} locked=${cs.hasLockedPick} bans=${cs.bans.myTeam.length}/${cs.bans.theirTeam.length}`
        : "");
    if (line !== lastDerived) {
      lastDerived = line;
      log.info(`  ↳ ${line}`);
    }
  });

  process.on("SIGINT", () => {
    manager.stop();
    process.exit(0);
  });
  log.info("Events test mode. Start/close the League client any time; this keeps reconnecting.");
  manager.start();
}
