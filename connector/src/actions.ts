/**
 * The complete list of things the phone is allowed to make the League client do.
 *
 * This is deliberately NOT a proxy: each action has a fixed LCU method + path,
 * validates its input, and re-checks the client's current state before acting.
 * The phone never chooses an LCU path or an action id.
 *
 * Adding a feature later (summoner spells, runes, skins, lobby) = add an entry here.
 */

import { lcuErrorMessage, type HttpMethod, type LcuHttp } from "./lcu/http";
import { findHoverTarget, findMyActiveAction, type LcuAction, type LcuSession } from "./state/champ-select";
import { log } from "./log";
import { URI } from "./state/store";

export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ActionContext {
  http: LcuHttp | null;
}

type Input = Record<string, unknown>;

interface ActionDef {
  /** Allowed body keys; anything else is rejected. */
  keys: readonly string[];
  /** Pure input checks, run before we even look at the client. */
  validate?(input: Input): void;
  run(input: Input, http: LcuHttp): Promise<void>;
}

// ---------- validation helpers ----------

function championIdFrom(input: Input): number {
  const v = input.championId;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > 1_000_000) {
    throw new ActionError(400, "championId must be a positive integer");
  }
  return v;
}

export function parseInput(body: unknown, keys: readonly string[]): Input {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new ActionError(400, "body must be a JSON object");
  for (const k of Object.keys(body)) {
    if (!keys.includes(k)) throw new ActionError(400, `unexpected field "${k}"`);
  }
  return body as Input;
}

// ---------- LCU helpers ----------

async function call(http: LcuHttp, method: HttpMethod, path: string, body?: unknown): Promise<number> {
  const res = await http.request(method, path, body);
  if (res.status >= 200 && res.status < 300) return res.status;
  if (res.status === 404 && method !== "GET") return 404;
  throw new ActionError(502, lcuErrorMessage(res.body) ?? `League client refused (${res.status})`);
}

async function getPhase(http: LcuHttp): Promise<string | null> {
  return http.getOrNull<string>(URI.phase);
}

async function getSession(http: LcuHttp): Promise<LcuSession> {
  const s = await http.getOrNull<LcuSession>(URI.session);
  if (!s || !Array.isArray(s.actions)) throw new ActionError(409, "Not in champion select");
  return s;
}

async function allowedChampions(http: LcuHttp, type: string): Promise<Set<number>> {
  const ids = await http.getOrNull<number[]>(type === "ban" ? URI.bannable : URI.pickable);
  return new Set(Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) : []);
}

async function assertAllowed(http: LcuHttp, action: LcuAction, championId: number): Promise<void> {
  const allowed = await allowedChampions(http, action.type);
  if (!allowed.has(championId)) {
    throw new ActionError(400, action.type === "ban" ? "That champion can't be banned" : "That champion isn't pickable");
  }
}

/** Polls the session briefly until the action is completed (or gone, e.g. phase moved on). */
export async function waitCompleted(http: LcuHttp, actionId: number, tries = 5, delayMs = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const s = await http.getOrNull<LcuSession>(URI.session);
    const a = s?.actions?.flat().find((x) => x.id === actionId);
    if (!s || !a || a.completed) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

const actionPath = (id: number) => {
  if (!Number.isInteger(id) || id < 0) throw new ActionError(500, "invalid action id from client");
  return `/lol-champ-select/v1/session/actions/${id}`;
};

// ---------- the whitelist ----------

const ACTIONS = {
  "ready-check/accept": {
    keys: [],
    async run(_input, http) {
      const rc = await http.getOrNull<{ state?: string }>(URI.readyCheck);
      if (rc?.state !== "InProgress") throw new ActionError(409, "No ready check in progress");
      await call(http, "POST", "/lol-matchmaking/v1/ready-check/accept");
    },
  },
  "ready-check/decline": {
    keys: [],
    async run(_input, http) {
      const rc = await http.getOrNull<{ state?: string }>(URI.readyCheck);
      if (rc?.state !== "InProgress") throw new ActionError(409, "No ready check in progress");
      await call(http, "POST", "/lol-matchmaking/v1/ready-check/decline");
    },
  },
  "queue/start": {
    keys: [],
    async run(_input, http) {
      if ((await getPhase(http)) !== "Lobby") throw new ActionError(409, "Not in a lobby");
      const status = await call(http, "POST", "/lol-lobby/v2/lobby/matchmaking/search");
      if (status === 404) throw new ActionError(502, "League client has no matchmaking endpoint (404)");
    },
  },
  "queue/cancel": {
    keys: [],
    async run(_input, http) {
      if ((await getPhase(http)) !== "Matchmaking") throw new ActionError(409, "Not in queue");
      const status = await call(http, "DELETE", "/lol-lobby/v2/lobby/matchmaking/search");
      if (status === 404) throw new ActionError(502, "League client has no matchmaking endpoint (404)");
    },
  },
  "champ-select/hover": {
    keys: ["championId"],
    validate: (input) => void championIdFrom(input),
    async run(input, http) {
      const championId = championIdFrom(input);
      const session = await getSession(http);
      const target = findHoverTarget(session);
      if (!target) throw new ActionError(409, "Nothing to pick or ban right now");
      await assertAllowed(http, target, championId);
      const status = await call(http, "PATCH", actionPath(target.id), { championId });
      if (status === 404) throw new ActionError(409, "That action no longer exists");
    },
  },
  "champ-select/lock": {
    keys: [],
    async run(_input, http) {
      const session = await getSession(http);
      const action = findMyActiveAction(session);
      if (!action) throw new ActionError(409, "It's not your turn");
      if (!(action.championId > 0)) throw new ActionError(409, "Select a champion first");
      const championId = action.championId;
      await assertAllowed(http, action, championId);
      const path = actionPath(action.id);

      // Verified on a live client (2026-11-12): POST .../complete can answer 2xx without
      // locking, e.g. when the champion was only declared as intent during planning.
      // So: re-hover on the active action, complete, then check the session really changed.
      await call(http, "PATCH", path, { championId });
      const status = await call(http, "POST", `${path}/complete`);
      if (status !== 404 && (await waitCompleted(http, action.id))) return;
      log.warn(`Lock-in: POST /complete answered ${status} but the action is still open; trying PATCH {completed:true}`);

      // Older clients (and Mimic): PATCH { championId, completed: true }.
      const fallback = await call(http, "PATCH", path, { championId, completed: true });
      if (fallback === 404) throw new ActionError(409, "That action no longer exists");
      if (await waitCompleted(http, action.id)) return;
      throw new ActionError(502, "League didn't accept the lock-in. Lock in on your PC.");
    },
  },
} satisfies Record<string, ActionDef>;

export type ActionName = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as ActionName[];

export function isActionName(name: string): name is ActionName {
  return Object.prototype.hasOwnProperty.call(ACTIONS, name);
}

export async function runAction(name: ActionName, body: unknown, ctx: ActionContext): Promise<void> {
  const def: ActionDef = ACTIONS[name];
  const input = parseInput(body, def.keys);
  def.validate?.(input);
  if (!ctx.http) throw new ActionError(503, "League client not connected");
  try {
    await def.run(input, ctx.http);
  } catch (e) {
    if (e instanceof ActionError) throw e;
    throw new ActionError(502, "Couldn't reach the League client");
  }
}
