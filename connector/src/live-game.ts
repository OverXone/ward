/**
 * Tells League's loading screen apart from a game that has started.
 *
 * The client reports the gameflow phase InProgress as soon as the game launches, which is
 * before the loading screen. The game itself serves Riot's Live Client Data API on
 * https://127.0.0.1:2999. Its event list (/liveclientdata/eventdata) gets a "GameStart" event
 * once everyone has loaded in; only the event names and that event's time are read.
 *
 * The game clock (`gameTime` in /liveclientdata/gamestats) can't tell: seen in a real game
 * (2026-11-28), it sits at about 0.036 s for the last part of the loading screen and only runs
 * from the start. The event list went: no connection, then a 404, then an empty list, then
 * GameStart (with that same 0.036 s as its time) when the clock started. Anything but a GameStart
 * event counts as loading, and each kind of answer is logged once per game.
 *
 * The game serves a self-signed certificate. Verification is off only on the agent below, which
 * never talks to anything but 127.0.0.1, and no credentials are sent.
 */

import https from "node:https";
import { log } from "./log";

export const LIVE_GAME_HOST = "127.0.0.1";
export const LIVE_GAME_PORT = 2999;
export const EVENTDATA_PATH = "/liveclientdata/eventdata";

/**
 * What one look at the game gave: its event list (how many events, and the game time in seconds
 * of the GameStart event if there is one), another HTTP status, or no answer.
 */
export type GameProbe = { events: number; gameStart: number | null } | { status: number } | { error: string };

/** Loading screen, or the game has started. */
export type GameStage = "loading" | "playing";

/** The game's port: 2999, or WARD_LIVE_GAME_PORT (the dev tools use it to point Ward at the mock). */
export function liveGamePort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WARD_LIVE_GAME_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : LIVE_GAME_PORT;
}

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false, maxSockets: 1 });

/** Reads the game's event list from the Live Client Data API. Never throws. */
export function probeLiveGame(port = liveGamePort(), timeoutMs = 1500): Promise<GameProbe> {
  return new Promise((resolve) => {
    const req = https.request(
      { host: LIVE_GAME_HOST, port, path: EVENTDATA_PATH, method: "GET", agent, headers: { Accept: "application/json" }, timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          // The list grows during a game; Ward may start mid-game, so allow a long one.
          if (size > 2 * 1024 * 1024) return req.destroy(new Error("answer too large"));
          chunks.push(c);
        });
        res.on("end", () => {
          if (status < 200 || status >= 300) return resolve({ status });
          resolve(parseEvents(Buffer.concat(chunks)) ?? { status });
        });
        res.on("error", (e) => resolve({ error: errorName(e) }));
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "TIMEOUT" })));
    req.on("error", (e) => resolve({ error: errorName(e) }));
    req.end();
  });
}

function parseEvents(body: Buffer): GameProbe | null {
  try {
    const events = (JSON.parse(body.toString("utf8")) as { Events?: unknown } | null)?.Events;
    if (!Array.isArray(events)) return null;
    const start = events.find((e) => (e as { EventName?: unknown } | null)?.EventName === "GameStart") as { EventTime?: unknown } | undefined;
    const at = start?.EventTime;
    return { events: events.length, gameStart: start ? (typeof at === "number" && Number.isFinite(at) ? at : 0) : null };
  } catch {
    return null;
  }
}

const errorName = (e: unknown): string => String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? "error").slice(0, 40);

/** Short description of a probe for the log. */
export function describeProbe(p: GameProbe): string {
  if ("events" in p) {
    if (p.gameStart !== null) return `GameStart event at ${p.gameStart.toFixed(1)}s`;
    return p.events === 0 ? "an empty event list" : `${p.events} events but no GameStart`;
  }
  if ("status" in p) return `HTTP ${p.status} without an event list`;
  return `no answer (${p.error})`;
}

/** The game has started once it has sent its GameStart event. */
export const hasStarted = (p: GameProbe): boolean => "events" in p && p.gameStart !== null;

export interface LiveGameOptions {
  probe?: () => Promise<GameProbe>;
  intervalMs?: number;
  /** After this long without a GameStart event the game counts as started (the API may be off). */
  giveUpMs?: number;
}

/**
 * Watches one game from launch until it has loaded, then stops asking.
 * start() and stop() never call onChange; only an answer from the game does.
 */
export class LiveGameWatch {
  stage: GameStage | null = null;
  private timer: NodeJS.Timeout | null = null;
  private run = 0;
  private startedAt = 0;
  private seen = new Set<string>();
  private readonly probe: () => Promise<GameProbe>;
  private readonly intervalMs: number;
  private readonly giveUpMs: number;

  constructor(
    private readonly onChange: () => void,
    opts: LiveGameOptions = {},
  ) {
    this.probe = opts.probe ?? (() => probeLiveGame());
    this.intervalMs = opts.intervalMs ?? 2000;
    // Long enough for a slow loader on the loading screen.
    this.giveUpMs = opts.giveUpMs ?? 10 * 60_000;
  }

  /** A game is launching or running. Does nothing if this game is already watched. */
  start(): void {
    if (this.stage !== null) return;
    this.stage = "loading";
    this.startedAt = Date.now();
    this.seen.clear();
    const run = ++this.run;
    void this.poll(run);
  }

  /** No game any more. */
  stop(): void {
    if (this.stage === null) return;
    this.stage = null;
    this.run++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async poll(run: number): Promise<void> {
    this.timer = null;
    const answer = await this.probe();
    if (run !== this.run) return;
    const waited = Math.round((Date.now() - this.startedAt) / 1000);
    if (hasStarted(answer)) {
      log.info(`Game loaded (${describeProbe(answer)}, ${waited}s after launch)`);
      return this.played();
    }
    const line = describeProbe(answer);
    if (this.seen.size < 5 && !this.seen.has(line)) {
      this.seen.add(line);
      log.info(`Loading screen: the game's live data gave ${line}`);
    }
    if (Date.now() - this.startedAt >= this.giveUpMs) {
      log.info(`No GameStart event after ${waited}s; showing the game as started`);
      return this.played();
    }
    this.timer = setTimeout(() => void this.poll(run), this.intervalMs);
    this.timer.unref?.();
  }

  private played(): void {
    this.stage = "playing";
    this.onChange();
  }
}
