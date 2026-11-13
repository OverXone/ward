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
import { SWAP_KINDS, type SwapKind } from "./shared/phone-api";
import { findHoverTarget, findMyActiveAction, findSwap, type LcuAction, type LcuSession } from "./state/champ-select";
import { log } from "./log";
import { championIds, URI } from "./state/store";

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
  /**
   * The pickable/bannable lists League pushed over its websocket. On a live client (2026-11-12)
   * GET /bannable-champion-ids answered an empty list for the whole champ select while the
   * event carried all 174 ids, so validation accepts an id if either source lists it.
   */
  lists?: () => { pickable: readonly number[]; bannable: readonly number[] };
  /**
   * Every real champion id, from the client's champion summary. Only used when League has given
   * no usable list at all: League pushes the lists once, at the start of champ select, and answers
   * GET /bannable-champion-ids with [-1], so a connector that (re)connects mid champ select has none.
   */
  knownChampions?: () => Promise<readonly { id: number }[] | null>;
}

type Input = Record<string, unknown>;

interface ActionDef {
  /** Allowed body keys; anything else is rejected. */
  keys: readonly string[];
  /** Pure input checks, run before we even look at the client. */
  validate?(input: Input): void;
  run(input: Input, http: LcuHttp, ctx: ActionContext): Promise<void>;
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
  throw new ActionError(502, friendlyLcuError(lcuErrorMessage(res.body)) ?? `League client refused (${res.status})`);
}

/** League error codes seen on a live client, in words a player understands. */
const LCU_ERRORS: Record<string, string> = {
  // 2026-11-12: banning the champion a teammate had as their planned pick.
  BAN_LOCK_FAILED_TEAMMATE_HOVERING_CHAMPION: "A teammate wants to play that champion, so League won't let you ban it. Choose another.",
};

/**
 * Turns "Error response for PATCH /lol-.../actions/8: SOME_CODE" into a short sentence for the
 * phone: known codes get a plain explanation, others become words, and the endpoint path is dropped.
 */
export function friendlyLcuError(message: string | null): string | null {
  if (!message) return null;
  const text = message.replace(/^Error response for [A-Z]+ \S+?:\s*/, "").trim();
  const known = LCU_ERRORS[text];
  if (known) return known;
  if (/^[A-Z][A-Z0-9_]{3,}$/.test(text)) {
    const words = text.toLowerCase().replace(/_/g, " ");
    return `League refused: ${words}.`;
  }
  return text || null;
}

async function getPhase(http: LcuHttp): Promise<string | null> {
  return http.getOrNull<string>(URI.phase);
}

async function getSession(http: LcuHttp): Promise<LcuSession> {
  const s = await http.getOrNull<LcuSession>(URI.session);
  if (!s || !Array.isArray(s.actions)) throw new ActionError(409, "Not in champion select");
  return s;
}

async function allowedChampions(http: LcuHttp, ctx: ActionContext, type: string): Promise<Set<number>> {
  const ids = championIds(await http.getOrNull(type === "ban" ? URI.bannable : URI.pickable)) ?? [];
  const pushed = ctx.lists?.()[type === "ban" ? "bannable" : "pickable"] ?? [];
  const allowed = new Set([...ids, ...pushed].filter((n) => Number.isInteger(n) && n > 0));
  if (allowed.size || !ctx.knownChampions) return allowed;

  // No list from League: accept any real champion and let League refuse what it won't allow
  // (its error is shown on the phone). Ids from 10000 up are special-mode copies (e.g. 60051).
  const known = (await ctx.knownChampions()) ?? [];
  const fallback = new Set(known.map((c) => c.id).filter((n) => Number.isInteger(n) && n > 0 && n < 10_000));
  if (fallback.size) noteFallback(type);
  return fallback;
}

let fallbackLoggedAt = 0;
function noteFallback(type: string): void {
  if (Date.now() - fallbackLoggedAt < 60_000) return;
  fallbackLoggedAt = Date.now();
  log.info(`League gave no ${type} list (connector joined mid champ select?); letting League check the champion`);
}

async function assertAllowed(http: LcuHttp, ctx: ActionContext, action: LcuAction, championId: number): Promise<void> {
  const allowed = await allowedChampions(http, ctx, action.type);
  if (!allowed.has(championId)) {
    throw new ActionError(400, action.type === "ban" ? "That champion can't be banned" : "That champion isn't pickable");
  }
}

/** Polls the session briefly until the action is completed (or gone, e.g. phase moved on). */
export async function waitCompleted(http: LcuHttp, actionId: number, tries = 8, delayMs = 100): Promise<boolean> {
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

// ---------- swaps ----------

function swapInput(input: Input): { kind: SwapKind; cellId: number } {
  const { kind, cellId } = input;
  if (typeof kind !== "string" || !SWAP_KINDS.includes(kind as SwapKind)) {
    throw new ActionError(400, `kind must be one of ${SWAP_KINDS.join(", ")}`);
  }
  if (typeof cellId !== "number" || !Number.isInteger(cellId) || cellId < 0 || cellId > 99) {
    throw new ActionError(400, "cellId must be a small non-negative integer");
  }
  return { kind: kind as SwapKind, cellId };
}

/**
 * Endpoint bases from the client's own API list (2026-11-12). Champion trades are "champion-swaps"
 * on current clients (the session still calls them trades); older clients used /session/trades.
 */
const SWAP_PATHS: Record<SwapKind, readonly string[]> = {
  position: ["/lol-champ-select/v1/session/position-swaps"],
  pickOrder: ["/lol-champ-select/v1/session/pick-order-swaps"],
  champion: ["/lol-champ-select/v1/session/champion-swaps", "/lol-champ-select/v1/session/trades"],
};

type SwapVerb = "accept" | "decline" | "request" | "cancel";
/** The state the swap must be in for each verb, and what to say when it isn't. */
const SWAP_NEEDS: Record<SwapVerb, { state: string; error: string }> = {
  accept: { state: "RECEIVED", error: "That swap request isn't open anymore" },
  decline: { state: "RECEIVED", error: "That swap request isn't open anymore" },
  request: { state: "AVAILABLE", error: "That swap isn't available right now" },
  cancel: { state: "SENT", error: "There's no swap request to cancel" },
};

function swapAction(verb: SwapVerb): ActionDef {
  return {
    keys: ["kind", "cellId"],
    validate: (input) => void swapInput(input),
    async run(input, http) {
      const { kind, cellId } = swapInput(input);
      const session = await getSession(http);
      // The phone names a teammate; the swap id always comes from the client's own session.
      const swap = findSwap(session, kind, cellId);
      const need = SWAP_NEEDS[verb];
      if (!swap || swap.state !== need.state) throw new ActionError(409, need.error);
      if (!Number.isInteger(swap.id) || swap.id < 0) throw new ActionError(500, "invalid swap id from client");
      for (const base of SWAP_PATHS[kind]) {
        if ((await call(http, "POST", `${base}/${swap.id}/${verb}`)) !== 404) return;
      }
      throw new ActionError(502, "This League client doesn't support that swap from here. Use your PC.");
    },
  };
}

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
    async run(input, http, ctx) {
      const championId = championIdFrom(input);
      const session = await getSession(http);
      const target = findHoverTarget(session);
      if (!target) throw new ActionError(409, "Nothing to pick or ban right now");
      await assertAllowed(http, ctx, target, championId);
      const status = await call(http, "PATCH", actionPath(target.id), { championId });
      if (status === 404) throw new ActionError(409, "That action no longer exists");
    },
  },
  "champ-select/lock": {
    keys: [],
    async run(_input, http, ctx) {
      const session = await getSession(http);
      const action = findMyActiveAction(session);
      if (!action) throw new ActionError(409, "It's not your turn");
      if (!(action.championId > 0)) throw new ActionError(409, "Select a champion first");
      const championId = action.championId;
      await assertAllowed(http, ctx, action, championId);
      const path = actionPath(action.id);

      // On a live client (2026-11-12) POST .../complete answered 204 without locking, every time,
      // while PATCH { championId, completed: true } (what Mimic does) worked. So PATCH first, then
      // check the session really changed; POST /complete is only the fallback.
      const status = await call(http, "PATCH", path, { championId, completed: true });
      if (status === 404) throw new ActionError(409, "That action no longer exists");
      if (await waitCompleted(http, action.id)) return;
      log.warn("Lock-in: PATCH {completed:true} didn't lock; trying POST /complete");

      const fallback = await call(http, "POST", `${path}/complete`);
      if (fallback !== 404 && (await waitCompleted(http, action.id))) return;
      throw new ActionError(502, "League didn't accept the lock-in. Lock in on your PC.");
    },
  },
  "champ-select/swap/accept": swapAction("accept"),
  "champ-select/swap/decline": swapAction("decline"),
  "champ-select/swap/request": swapAction("request"),
  "champ-select/swap/cancel": swapAction("cancel"),
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
    await def.run(input, ctx.http, ctx);
  } catch (e) {
    if (e instanceof ActionError) throw e;
    throw new ActionError(502, "Couldn't reach the League client");
  }
}
