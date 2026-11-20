/**
 * The complete list of things the phone is allowed to make the League client do.
 *
 * This is deliberately NOT a proxy: each action has a fixed LCU method + path,
 * validates its input, and re-checks the client's current state before acting.
 * The phone never chooses an LCU path or an action id.
 *
 * Adding a feature = add an entry here.
 */

import { cleanText, conversationPath, currentConversation, MAX_CHAT_TEXT } from "./chat";
import { friendKey, readFriends } from "./friends";
import { HANDLE_RE, type HandleKind, type Handles } from "./handles";
import { lcuErrorMessage, type HttpMethod, type LcuHttp } from "./lcu/http";
import { listQueues } from "./queues";
import { PICKABLE_ROLES, SWAP_KINDS, type Role, type SwapKind } from "./shared/phone-api";
import {
  bannedChampions,
  benchChampions,
  findHoverTarget,
  findMyActiveAction,
  findSwap,
  lockedChampions,
  pickOrderSwapPossible,
  rerollsLeft,
  type LcuAction,
  type LcuSession,
} from "./state/champ-select";
import { log } from "./log";
import { benchAllowed } from "./ownership";
import { canChangeMode, championIds, URI, type RawLobby } from "./state/store";

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
  knownChampions?: () => Promise<readonly { id: number; name?: string }[] | null>;
  /** Spells and skins the client says I can use right now (see loadout.ts). */
  loadout?: {
    availableSpells(): Promise<readonly { id: number }[] | null>;
    selectableSkinIds(): Promise<Set<number> | null>;
  };
  /** Champions I can play (owned, rented, free), or null when not known. See ownership.ts. */
  playable?: () => ReadonlySet<number> | null;
  /** Maps the phone's opaque handles back to invitations and friends. */
  handles?: Handles;
}

const MY_SELECTION = "/lol-champ-select/v1/session/my-selection";

function positiveInt(input: Input, key: string): number {
  const v = input[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > 100_000_000) {
    throw new ActionError(400, `${key} must be a positive integer`);
  }
  return v;
}

function spellsFrom(input: Input): [number, number] {
  const spells: [number, number] = [positiveInt(input, "spell1Id"), positiveInt(input, "spell2Id")];
  if (spells[0] === spells[1]) throw new ActionError(400, "Pick two different spells");
  return spells;
}

async function assertInChampSelect(http: LcuHttp): Promise<void> {
  const s = await getSession(http);
  if (s.isSpectating) throw new ActionError(409, "You're spectating this champion select");
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

async function allowedChampions(http: LcuHttp, ctx: ActionContext, type: string, session?: LcuSession): Promise<Set<number>> {
  const ids = championIds(await http.getOrNull(type === "ban" ? URI.bannable : URI.pickable)) ?? [];
  const pushed = ctx.lists?.()[type === "ban" ? "bannable" : "pickable"] ?? [];
  // Choose-from-a-few modes: the champions League offers me are pickable even if the list lags.
  const offered = type === "pick" && session?.allowSubsetChampionPicks ? (championIds(await http.getOrNull(URI.subset)) ?? []) : [];
  const allowed = new Set([...ids, ...pushed, ...offered].filter((n) => Number.isInteger(n) && n > 0));
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

async function assertAllowed(http: LcuHttp, ctx: ActionContext, action: LcuAction, championId: number, session?: LcuSession): Promise<void> {
  // League's pickable list doesn't drop banned champions (live draft, 2026-11-14), so say why here.
  if (action.type === "pick" && session) {
    if (bannedChampions(session).includes(championId)) throw new ActionError(400, "That champion is banned");
    if (lockedChampions(session).includes(championId)) throw new ActionError(400, "Someone already picked that champion");
  }
  const allowed = await allowedChampions(http, ctx, action.type, session);
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

// ---------- invitations ----------

const INVITATIONS = "/lol-lobby/v2/received-invitations";
const INVITATION_ID = /^[A-Za-z0-9_.-]{1,80}$/;

function invitationAction(verb: "accept" | "decline"): ActionDef {
  return {
    keys: ["invitation"],
    validate: (input) => void handleFrom(input, "invitation"),
    async run(input, http, ctx) {
      const id = resolveHandle(ctx, "invite", handleFrom(input, "invitation"));
      if (typeof id !== "string" || !INVITATION_ID.test(id)) throw new ActionError(500, "invalid invitation id from client");
      const list = await http.getOrNull<{ invitationId?: unknown; state?: unknown; canAcceptInvitation?: unknown }[]>(INVITATIONS);
      const inv = Array.isArray(list) ? list.find((i) => i?.invitationId === id) : undefined;
      if (!inv || inv.state !== "Pending") throw new ActionError(409, HANDLE_GONE.invite);
      if (verb === "accept") {
        const phase = (await getPhase(http)) ?? "";
        if (phase === "ChampSelect" || IN_GAME.has(phase)) throw new ActionError(409, "Finish your champion select or game first");
        if (inv.canAcceptInvitation === false) throw new ActionError(409, "League won't let you join that lobby right now");
      }
      if ((await call(http, "POST", `${INVITATIONS}/${id}/${verb}`)) === 404) throw new ActionError(409, HANDLE_GONE.invite);
    },
  };
}

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
      if (verb === "request" && kind === "pickOrder" && !pickOrderSwapPossible(session, cellId)) {
        throw new ActionError(409, "One of you has already picked, so there's no pick order to swap");
      }
      if (!Number.isInteger(swap.id) || swap.id < 0) throw new ActionError(500, "invalid swap id from client");
      for (const base of SWAP_PATHS[kind]) {
        if ((await call(http, "POST", `${base}/${swap.id}/${verb}`)) !== 404) return;
      }
      throw new ActionError(502, "This League client doesn't support that swap from here. Use your PC.");
    },
  };
}

// ---------- chat ----------

/** The message the phone wants to send, as one line of plain text. */
function chatText(input: Input): string {
  const v = input.text;
  if (typeof v !== "string") throw new ActionError(400, "text must be a string");
  const text = cleanText(v, MAX_CHAT_TEXT + 1);
  if (!text) throw new ActionError(400, "Write something first");
  if ([...text].length > MAX_CHAT_TEXT) throw new ActionError(400, `Messages can be up to ${MAX_CHAT_TEXT} characters`);
  return text;
}

// ---------- handles (invitations, friends) ----------

const HANDLE_GONE: Record<HandleKind, string> = {
  invite: "That invitation isn't open anymore",
  friend: "That friend isn't on your list anymore",
};

function handleFrom(input: Input, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || !HANDLE_RE.test(v)) throw new ActionError(400, `${key} must be a handle from the connector`);
  return v;
}

/** The League object behind a handle the phone sent. Every caller re-checks it against a fresh list. */
function resolveHandle(ctx: ActionContext, kind: HandleKind, handle: string): string | number {
  if (!ctx.handles) throw new ActionError(500, "connector misconfigured (no handles)");
  const key = ctx.handles.resolve(kind, handle);
  if (key === null) throw new ActionError(409, HANDLE_GONE[kind]);
  return key;
}

/** League's in-game phases: no joining another lobby then. */
const IN_GAME = new Set(["GameStart", "InProgress", "Reconnect"]);

// ---------- lobby mode and roles ----------

const ROLE_PATH = "/lol-lobby/v2/lobby/members/localMember/position-preferences";

/** First and second role from the phone. FILL as first role means no second one. */
function rolesFrom(input: Input): [Role, Role] {
  const { first, second } = input;
  const ok = (v: unknown): v is Role => typeof v === "string" && (PICKABLE_ROLES as readonly string[]).includes(v);
  if (!ok(first)) throw new ActionError(400, `first must be one of ${PICKABLE_ROLES.join(", ")}`);
  if (first === "FILL") {
    if (second !== undefined && second !== "UNSELECTED") throw new ActionError(400, "Fill takes no second role");
    return ["FILL", "UNSELECTED"];
  }
  if (second !== "UNSELECTED" && !ok(second)) throw new ActionError(400, `second must be one of ${PICKABLE_ROLES.join(", ")} or UNSELECTED`);
  if (second === first) throw new ActionError(400, "Pick two different roles");
  return [first, second];
}

const memberCount = (lobby: RawLobby | null) => (Array.isArray(lobby?.members) ? lobby.members.length : 0);

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
      await assertAllowed(http, ctx, target, championId, session);
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
      await assertAllowed(http, ctx, action, championId, session);
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
  "champ-select/spells": {
    keys: ["spell1Id", "spell2Id"],
    validate: (input) => void spellsFrom(input),
    async run(input, http, ctx) {
      const [spell1Id, spell2Id] = spellsFrom(input);
      await assertInChampSelect(http);
      const available = await ctx.loadout?.availableSpells();
      if (!available?.length) throw new ActionError(503, "Couldn't read your summoner spells from League");
      const ids = new Set(available.map((s) => s.id));
      if (!ids.has(spell1Id) || !ids.has(spell2Id)) throw new ActionError(400, "That spell isn't available in this game");
      if ((await call(http, "PATCH", MY_SELECTION, { spell1Id, spell2Id })) === 404) throw new ActionError(409, "Not in champion select");
    },
  },
  "champ-select/skin": {
    keys: ["skinId"],
    validate: (input) => void positiveInt(input, "skinId"),
    async run(input, http, ctx) {
      const skinId = positiveInt(input, "skinId");
      await assertInChampSelect(http);
      const ids = await ctx.loadout?.selectableSkinIds();
      if (!ids?.has(skinId)) throw new ActionError(400, "You can't use that skin right now");
      if ((await call(http, "PATCH", MY_SELECTION, { selectedSkinId: skinId })) === 404) throw new ActionError(409, "Not in champion select");
    },
  },
  "champ-select/bench": {
    keys: ["championId"],
    validate: (input) => void championIdFrom(input),
    async run(input, http, ctx) {
      const championId = championIdFrom(input);
      const session = await getSession(http);
      if (session.isSpectating) throw new ActionError(409, "You're spectating this champion select");
      const bench = benchChampions(session);
      if (!bench) throw new ActionError(409, "This mode has no bench");
      if (!bench.includes(championId)) throw new ActionError(409, "That champion isn't on the bench anymore");
      // A swap for a champion I can't take did nothing and showed no error (ARAM, 2026-11-17); the PC locks those.
      const allowed = benchAllowed(ctx.lists?.().pickable, ctx.playable?.());
      if (allowed && !allowed.has(championId)) throw new ActionError(409, "You don't own that champion, so you can't swap for it");
      const status = await call(http, "POST", `/lol-champ-select/v1/session/bench/swap/${championId}`);
      if (status === 404) throw new ActionError(502, "This League client can't swap from the bench from here. Use your PC.");
    },
  },
  "champ-select/reroll": {
    keys: [],
    async run(_input, http) {
      const session = await getSession(http);
      const left = rerollsLeft(session);
      if (left === null) throw new ActionError(409, "This mode doesn't allow rerolls");
      if (left < 1) throw new ActionError(409, "You have no rerolls left");
      const status = await call(http, "POST", "/lol-champ-select/v1/session/my-selection/reroll");
      if (status === 404) throw new ActionError(502, "This League client can't reroll from here. Use your PC.");
    },
  },
  "invitations/accept": invitationAction("accept"),
  "invitations/decline": invitationAction("decline"),
  "lobby/invite": {
    keys: ["friend"],
    validate: (input) => void handleFrom(input, "friend"),
    async run(input, http, ctx) {
      const handle = handleFrom(input, "friend");
      const key = resolveHandle(ctx, "friend", handle);
      if ((await getPhase(http)) !== "Lobby") throw new ActionError(409, "Open a lobby first");
      const lobby = await http.getOrNull<{ localMember?: { isLeader?: unknown; allowedInviteOthers?: unknown } }>(URI.lobby);
      const allowed = lobby?.localMember?.allowedInviteOthers ?? lobby?.localMember?.isLeader;
      if (allowed !== true) throw new ActionError(409, "Only the party leader can invite to this lobby");
      // Re-check against the live friends list: still a friend, still online in League, not already here.
      const friends = await readFriends(http, ctx.handles!);
      const friend = friends?.options.find((f) => f.handle === handle);
      const raw = friends?.raw.find((f) => friendKey(f) === key);
      if (!friend || !raw) throw new ActionError(409, `${HANDLE_GONE.friend}, or they went offline`);
      if (!friend.canInvite) throw new ActionError(409, `${friend.name}: ${friend.status.toLowerCase()}`);
      // LolLobbyLobbyInvitationDto takes toSummonerId and toPuuid; send whichever the friend has.
      const invite: Record<string, unknown> = {};
      if (Number.isInteger(raw.summonerId) && (raw.summonerId as number) > 0) invite.toSummonerId = raw.summonerId;
      if (typeof raw.puuid === "string" && raw.puuid) invite.toPuuid = raw.puuid;
      const status = await call(http, "POST", "/lol-lobby/v2/lobby/invitations", [invite]);
      if (status === 404) throw new ActionError(502, "This League client can't send invitations from here. Use your PC.");
    },
  },
  "lobby/mode": {
    keys: ["queueId"],
    validate: (input) => void positiveInt(input, "queueId"),
    async run(input, http) {
      const queueId = positiveInt(input, "queueId");
      const phase = await getPhase(http);
      if (phase === "Matchmaking") throw new ActionError(409, "Leave the queue first");
      if (phase !== "Lobby" && phase !== "None") throw new ActionError(409, "You can change the mode from the lobby");
      const lobby = phase === "Lobby" ? await http.getOrNull<RawLobby>(URI.lobby) : null;
      if (lobby && !canChangeMode(lobby)) throw new ActionError(409, "Only the party leader can change the mode");
      if (lobby?.gameConfig?.queueId === queueId) return;
      // Only modes the play menu offers (no custom games, tutorials or switched-off queues).
      const queues = await listQueues(http);
      const queue = queues?.find((q) => q.id === queueId);
      if (!queue) throw new ActionError(409, "That mode isn't available right now");
      if (!queue.canPick) throw new ActionError(409, `${queue.name}: ${queue.reason?.toLowerCase() ?? "not available right now"}`);

      const before = memberCount(lobby);
      const res = await http.request("POST", URI.lobby, { queueId });
      if (res.status < 200 || res.status >= 300) {
        if (res.status === 404) throw new ActionError(502, "This League client can't change the mode from here. Use your PC.");
        throw new ActionError(502, friendlyLcuError(lcuErrorMessage(res.body)) ?? `League client refused (${res.status})`);
      }
      // Not yet checked on a live client: does the party stay together? Log it so the activity log tells.
      if (before > 1) {
        const after = memberCount(await http.getOrNull<RawLobby>(URI.lobby));
        if (after < before) log.warn(`Switching to ${queue.name} left the party behind (${before} players before, ${after} after)`);
        else log.info(`Switched the party (${before} players) to ${queue.name}`);
      }
    },
  },
  "lobby/roles": {
    keys: ["first", "second"],
    validate: (input) => void rolesFrom(input),
    async run(input, http) {
      const [firstPreference, secondPreference] = rolesFrom(input);
      if ((await getPhase(http)) !== "Lobby") throw new ActionError(409, "Open a lobby first");
      const lobby = await http.getOrNull<RawLobby>(URI.lobby);
      if (!lobby?.gameConfig?.showPositionSelector) throw new ActionError(409, "This mode doesn't use roles");
      const status = await call(http, "PUT", ROLE_PATH, { firstPreference, secondPreference });
      if (status === 404) throw new ActionError(502, "This League client can't set roles from here. Use your PC.");
    },
  },
  "chat/send": {
    keys: ["text"],
    validate: (input) => void chatText(input),
    async run(input, http) {
      const text = chatText(input);
      // The room is looked up again here: the phone never names a conversation.
      const conversation = await currentConversation(http);
      if (!conversation) throw new ActionError(409, "There's no chat to send to right now");
      const status = await call(http, "POST", conversationPath(conversation.id, "messages"), { body: text, type: "groupchat" });
      if (status === 404) throw new ActionError(409, "That chat isn't open anymore");
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
