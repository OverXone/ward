/**
 * Holds the raw LCU resources we care about and derives the sanitised PhoneState.
 *
 * Fed by (a) a snapshot of every watched endpoint when we connect or the
 * gameflow phase changes, and (b) live websocket events in between.
 */

import { EventEmitter } from "node:events";
import type { LcuHttp } from "../lcu/http";
import { log } from "../log";
import type { LcuEvent } from "../lcu/socket";
import { Handles } from "../handles";
import type { InvitationView, LcuStatus, LobbyView, PhoneState, QueueView, ReadyCheckView, RunesView } from "../shared/phone-api";
import { deriveChampSelect, type LcuSession } from "./champ-select";

export const URI = {
  phase: "/lol-gameflow/v1/gameflow-phase",
  lobby: "/lol-lobby/v2/lobby",
  search: "/lol-matchmaking/v1/search",
  readyCheck: "/lol-matchmaking/v1/ready-check",
  session: "/lol-champ-select/v1/session",
  pickable: "/lol-champ-select/v1/pickable-champion-ids",
  bannable: "/lol-champ-select/v1/bannable-champion-ids",
  runePages: "/lol-perks/v1/pages",
  currentRunePage: "/lol-perks/v1/currentpage",
  invitations: "/lol-lobby/v2/received-invitations",
} as const;

type Key = keyof typeof URI;
export const WATCHED_URIS: ReadonlySet<string> = new Set(Object.values(URI));
const KEY_BY_URI = new Map<string, Key>(Object.entries(URI).map(([k, v]) => [v, k as Key]));

interface RawLobby {
  canStartActivity?: boolean;
  localMember?: { isLeader?: boolean; allowedInviteOthers?: boolean };
  gameConfig?: { queueId?: number };
  members?: unknown[];
}

interface RawSearch {
  searchState?: string;
  timeInQueue?: number;
  estimatedQueueTime?: number;
  isCurrentlyInQueue?: boolean;
  errors?: { errorType?: string; message?: string; penaltyTimeRemaining?: number }[];
  lowPriorityData?: { penaltyTimeRemaining?: number };
}

interface RawReadyCheck {
  state?: string;
  playerResponse?: string;
  timer?: number;
}

/** The subset of a /lol-perks/v1/pages entry we read. */
export interface RawRunePage {
  id?: unknown;
  name?: unknown;
  isEditable?: unknown;
  isValid?: unknown;
  current?: unknown;
  primaryStyleId?: unknown;
  subStyleId?: unknown;
  selectedPerkIds?: unknown;
  isTemporary?: unknown;
}

/** The subset of a /lol-lobby/v2/received-invitations entry we read. */
export interface RawInvitation {
  invitationId?: unknown;
  state?: unknown;
  canAcceptInvitation?: unknown;
  fromSummonerId?: unknown;
  fromSummonerName?: unknown;
  gameConfig?: { queueId?: unknown };
}

type Raw = {
  phase: string | null;
  lobby: RawLobby | null;
  search: RawSearch | null;
  readyCheck: RawReadyCheck | null;
  session: LcuSession | null;
  pickable: number[] | null;
  bannable: number[] | null;
  runePages: RawRunePage[] | null;
  currentRunePage: RawRunePage | null;
  invitations: RawInvitation[] | null;
};

const emptyRaw = (): Raw => ({
  phase: null,
  lobby: null,
  search: null,
  readyCheck: null,
  session: null,
  pickable: null,
  bannable: null,
  runePages: null,
  currentRunePage: null,
  invitations: null,
});

/** Champion ids from a list the client sent (integers, or integer strings), or null if it isn't a list. */
export function championIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  for (const v of value) {
    const n = typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : v;
    if (Number.isInteger(n) && (n as number) > 0) ids.push(n as number);
  }
  return ids;
}

/** Short description of an unexpected answer's shape for the log (no secrets in these endpoints). */
function describeAnswer(value: unknown): string {
  if (value === null || value === undefined) return "nothing (error or 404)";
  if (Array.isArray(value)) {
    const sample = JSON.stringify(value.slice(0, 3)).slice(0, 80);
    return `a list of ${value.length} (${sample})`;
  }
  if (typeof value === "object") return `an object with keys ${Object.keys(value).slice(0, 8).join(",") || "(none)"}`;
  return `a ${typeof value} (${String(value).slice(0, 40)})`;
}

export function deriveLobby(lobby: RawLobby | null, queueName: string | null): LobbyView | null {
  if (!lobby) return null;
  const queueId = lobby.gameConfig?.queueId;
  return {
    queueId: Number.isInteger(queueId) ? (queueId as number) : null,
    queueName,
    isLeader: !!lobby.localMember?.isLeader,
    canStartActivity: !!lobby.canStartActivity,
    memberCount: Array.isArray(lobby.members) ? lobby.members.length : 1,
    // Older clients don't send allowedInviteOthers; then only the leader is assumed to be allowed.
    canInvite: typeof lobby.localMember?.allowedInviteOthers === "boolean" ? lobby.localMember.allowedInviteOthers : !!lobby.localMember?.isLeader,
  };
}

const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const styleId = (v: unknown) => (isId(v) ? v : 0);

/** Pages the phone can choose from. Custom pages first, then League's presets, each in the client's order. */
export function deriveRunes(pages: RawRunePage[] | null, current: RawRunePage | null, handles: Handles): RunesView | null {
  if (!Array.isArray(pages)) return null;
  const currentId = isId(current?.id) ? current.id : null;
  const list = pages
    .filter((p) => p && isId(p.id) && typeof p.name === "string" && p.isTemporary !== true)
    .map((p) => ({
      handle: handles.handle("page", p.id as number),
      name: (p.name as string).trim().slice(0, 40) || "Rune page",
      primaryStyleId: styleId(p.primaryStyleId),
      subStyleId: styleId(p.subStyleId),
      isEditable: p.isEditable !== false,
      isValid: p.isValid !== false,
      isCurrent: currentId !== null ? p.id === currentId : p.current === true,
    }));
  return { pages: [...list.filter((p) => p.isEditable), ...list.filter((p) => !p.isEditable)] };
}

/** Pending invitations in League's order. Names and queues come from caches filled elsewhere. */
export function deriveInvitations(
  raw: RawInvitation[] | null,
  names: ReadonlyMap<number, string>,
  queueNames: ReadonlyMap<number, string>,
  handles: Handles,
): InvitationView[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((i) => i && typeof i.invitationId === "string" && i.invitationId.length > 0 && i.state === "Pending")
    .map((i) => {
      const sent = typeof i.fromSummonerName === "string" ? i.fromSummonerName.trim() : "";
      const looked = isId(i.fromSummonerId) ? names.get(i.fromSummonerId) : undefined;
      const queueId = i.gameConfig?.queueId;
      return {
        handle: handles.handle("invite", i.invitationId as string),
        from: (looked || sent || "A friend").slice(0, 32),
        queueName: isId(queueId) ? (queueNames.get(queueId) ?? null) : null,
        canAccept: i.canAcceptInvitation !== false,
      };
    });
}

export function deriveQueue(search: RawSearch | null): QueueView | null {
  if (!search) return null;
  const errors = Array.isArray(search.errors) ? search.errors : [];
  const penalties = [
    ...errors.map((e) => e.penaltyTimeRemaining ?? 0),
    search.lowPriorityData?.penaltyTimeRemaining ?? 0,
  ].filter((n) => typeof n === "number" && n > 0);
  return {
    searchState: String(search.searchState ?? "Invalid"),
    timeInQueue: Math.max(0, Number(search.timeInQueue) || 0),
    estimatedQueueTime: Math.max(0, Number(search.estimatedQueueTime) || 0),
    penaltySeconds: penalties.length ? Math.ceil(Math.max(...penalties)) : 0,
    errors: errors
      .map((e) => String(e.message || e.errorType || ""))
      .filter(Boolean)
      .map((s) => s.slice(0, 120)),
  };
}

export function deriveReadyCheck(rc: RawReadyCheck | null): ReadyCheckView | null {
  if (!rc) return null;
  return {
    state: String(rc.state ?? "Invalid"),
    playerResponse: String(rc.playerResponse ?? "None"),
    timer: Math.max(0, Number(rc.timer) || 0),
  };
}

export declare interface Store {
  on(event: "change", listener: (state: PhoneState) => void): this;
  on(event: "phase", listener: (phase: string | null) => void): this;
}

export class Store extends EventEmitter {
  private raw: Raw = emptyRaw();
  private http: LcuHttp | null = null;
  private lcuStatus: LcuStatus = "searching";
  private queueNames = new Map<number, string>();
  private lastJson = "";
  private snapshotRetry: NodeJS.Timeout | null = null;
  /** Bumped by every live event, so a slower HTTP snapshot never overwrites newer event data. */
  private versions = new Map<Key, number>();
  private listsFetchedAt = 0;
  private listsFetching = false;
  private lastCsPhase: string | null = null;
  private oddListsLogged = new Set<string>();
  /** Riot ID game names of people who invited me, by summoner id. */
  private inviterNames = new Map<number, string>();
  private inviterLookups = new Set<number>();
  /** Opaque names the phone uses for rune pages, invitations and friends (see handles.ts). */
  readonly handles = new Handles();
  state: PhoneState = this.derive();

  setLcuStatus(status: LcuStatus): void {
    this.lcuStatus = status;
    this.recompute();
  }

  attach(http: LcuHttp): void {
    this.http = http;
    this.raw = emptyRaw();
    this.lastCsPhase = null;
    this.queueNames.clear();
    this.inviterNames.clear();
    this.inviterLookups.clear();
    this.handles.clear();
    void this.refreshAll();
  }

  detach(): void {
    this.http = null;
    this.raw = emptyRaw();
    if (this.snapshotRetry) clearTimeout(this.snapshotRetry);
    this.snapshotRetry = null;
    this.recompute();
  }

  /** The champion lists as League pushed them (events win over HTTP answers, see applyFetched). */
  championLists(): { pickable: readonly number[]; bannable: readonly number[] } {
    // Only while champ select is on, so a list left over from an earlier one is never used.
    if (!this.raw.session) return { pickable: [], bannable: [] };
    return { pickable: this.raw.pickable ?? [], bannable: this.raw.bannable ?? [] };
  }

  /** Latest raw session (used by actions as a fallback; actions normally re-fetch). */
  get session(): LcuSession | null {
    return this.raw.session;
  }

  handleEvent(e: LcuEvent): void {
    const key = KEY_BY_URI.get(e.uri);
    if (!key) return;
    const value = e.eventType === "Delete" ? null : e.data;
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.setRaw(key, value);
    if (key === "session") this.checkChampionLists();
  }

  /**
   * The pickable/bannable lists only get events when they change, so if one is ever missed or a
   * snapshot came back empty, the phone would grey out every champion for the whole champ select.
   * Re-fetch them when the champ-select phase changes (planning -> bans -> picks) and whenever
   * one is missing, at most every 2 s.
   */
  private checkChampionLists(): void {
    const session = this.raw.session;
    if (!session) {
      this.lastCsPhase = null;
      this.oddListsLogged.clear();
      return;
    }
    const csPhase = session.timer?.phase ?? null;
    const phaseChanged = csPhase !== this.lastCsPhase;
    this.lastCsPhase = csPhase;
    const missing = !this.raw.pickable?.length || !this.raw.bannable?.length;
    if (!phaseChanged && !missing) return;
    if (this.listsFetching || (!phaseChanged && Date.now() - this.listsFetchedAt < 2000)) return;
    void this.refreshChampionLists(csPhase);
  }

  private async refreshChampionLists(csPhase: string | null): Promise<void> {
    const http = this.http;
    if (!http) return;
    this.listsFetching = true;
    this.listsFetchedAt = Date.now();
    try {
      const before = { pickable: this.versions.get("pickable") ?? 0, bannable: this.versions.get("bannable") ?? 0 };
      const [pickable, bannable] = await Promise.all([http.getOrNull(URI.pickable), http.getOrNull(URI.bannable)]);
      if (http !== this.http) return;
      if ((this.versions.get("pickable") ?? 0) === before.pickable) this.applyFetched("pickable", pickable);
      if ((this.versions.get("bannable") ?? 0) === before.bannable) this.applyFetched("bannable", bannable);
      this.recompute();
      const cs = this.state.champSelect;
      if (cs) log.info(`Champ select ${csPhase ?? "?"}: ${cs.pickableChampionIds.length} pickable, ${cs.bannableChampionIds.length} bannable`);
    } finally {
      this.listsFetching = false;
    }
  }

  /** Fetches every watched endpoint. Retries until the client's plugins are up. */
  async refreshAll(): Promise<void> {
    const http = this.http;
    if (!http) return;
    const before = new Map(this.versions);
    const entries = await Promise.all(
      (Object.keys(URI) as Key[]).map(async (k) => [k, await http.getOrNull(URI[k])] as const),
    );
    if (http !== this.http) return; // reconnected meanwhile
    // Skip anything a live event updated while these requests were in flight: the event is newer.
    for (const [k, v] of entries) if ((this.versions.get(k) ?? 0) === (before.get(k) ?? 0)) this.applyFetched(k, v);
    this.recompute();
    this.checkChampionLists();

    if (this.snapshotRetry) clearTimeout(this.snapshotRetry);
    this.snapshotRetry = null;
    if (this.raw.phase === null) {
      // gameflow plugin not loaded yet (client still booting)
      this.snapshotRetry = setTimeout(() => void this.refreshAll(), 3000);
    }
  }

  /** Applies an HTTP snapshot value (no recompute). */
  private applyFetched(key: Key, value: unknown): void {
    if (key === "pickable" || key === "bannable") {
      const ids = championIds(value);
      if (!ids?.length) this.noteOddListAnswer(key, value);
      // On a live client (2026-11-12) the websocket event carried every bannable id while the HTTP
      // answer for the same list didn't (and wiped it, so every ban was refused). The lists only
      // empty when champ select ends, and a Delete event (or a reconnect) clears them then, so an
      // HTTP answer never empties a list League pushed.
      if (this.raw[key]?.length && !ids?.length) return;
      this.raw[key] = ids;
      return;
    }
    this.setRaw(key, value, false);
  }

  /** Logs (once per champ select) what the client answered when a list GET wasn't a list of ids. */
  private noteOddListAnswer(key: "pickable" | "bannable", value: unknown): void {
    if (!this.raw.session || this.oddListsLogged.has(key)) return;
    this.oddListsLogged.add(key);
    log.info(`GET ${key}-champion-ids answered ${describeAnswer(value)}; using League's pushed list instead`);
  }

  private setRaw(key: Key, value: unknown, recompute = true): void {
    const prevPhase = this.raw.phase;
    switch (key) {
      case "phase":
        this.raw.phase = typeof value === "string" ? value : null;
        break;
      case "pickable":
      case "bannable":
        this.raw[key] = championIds(value);
        break;
      case "runePages":
      case "invitations":
        this.raw[key] = Array.isArray(value) ? (value as never) : null;
        break;
      case "session": {
        const s = value as LcuSession | null;
        this.raw.session = s && typeof s === "object" && Array.isArray(s.myTeam) ? s : null;
        break;
      }
      default:
        this.raw[key] = value && typeof value === "object" ? (value as never) : null;
    }

    if (key === "lobby") void this.ensureQueueName(this.raw.lobby?.gameConfig?.queueId);
    if (key === "invitations") this.lookUpInvitations();

    if (recompute) {
      this.recompute();
      if (key === "phase" && prevPhase !== this.raw.phase) {
        this.emit("phase", this.raw.phase);
        // Resync everything on phase transitions so a missed event can't leave stale state.
        void this.refreshAll();
      }
    }
  }

  /** Fetches the inviter's name and the queue name for each new pending invitation. */
  private lookUpInvitations(): void {
    for (const inv of this.raw.invitations ?? []) {
      if (inv?.state !== "Pending") continue;
      void this.ensureQueueName(inv.gameConfig?.queueId);
      const id = inv.fromSummonerId;
      if (isId(id) && !this.inviterLookups.has(id) && this.inviterLookups.size < 200) {
        this.inviterLookups.add(id);
        void this.lookUpInviter(id);
      }
    }
  }

  private async lookUpInviter(summonerId: number): Promise<void> {
    const http = this.http;
    if (!http) return;
    const s = await http.getOrNull<{ gameName?: unknown; displayName?: unknown }>(`/lol-summoner/v1/summoners/${summonerId}`);
    const name = [s?.gameName, s?.displayName].find((n): n is string => typeof n === "string" && n.trim() !== "");
    if (name && http === this.http) {
      this.inviterNames.set(summonerId, name.trim().slice(0, 32));
      this.recompute();
    }
  }

  private async ensureQueueName(id: unknown): Promise<void> {
    const http = this.http;
    if (!http || !Number.isInteger(id) || (id as number) < 0 || this.queueNames.has(id as number)) return;
    const q = await http.getOrNull<{ description?: string; name?: string; shortName?: string }>(
      `/lol-game-queues/v1/queues/${id as number}`,
    );
    const name = q?.description || q?.name || q?.shortName;
    if (name && http === this.http) {
      this.queueNames.set(id as number, String(name).slice(0, 60));
      this.recompute();
    }
  }

  private derive(): PhoneState {
    const r = this.raw ?? emptyRaw();
    const connected = this.lcuStatus === "connected";
    const queueId = r.lobby?.gameConfig?.queueId;
    // The real client keeps the search object around during champ select, so only report it while queued.
    const search = r.phase === "Matchmaking" && r.search && (r.search.isCurrentlyInQueue ?? true) ? r.search : null;
    return {
      lcu: this.lcuStatus ?? "searching",
      phase: connected ? r.phase : null,
      lobby: connected ? deriveLobby(r.lobby, Number.isInteger(queueId) ? (this.queueNames?.get(queueId as number) ?? null) : null) : null,
      queue: connected ? deriveQueue(search) : null,
      readyCheck: connected ? deriveReadyCheck(r.readyCheck) : null,
      champSelect: connected && r.session ? deriveChampSelect(r.session, r.pickable, r.bannable) : null,
      runes: connected ? deriveRunes(r.runePages, r.currentRunePage, this.handles) : null,
      invitations: connected ? deriveInvitations(r.invitations, this.inviterNames, this.queueNames, this.handles) : [],
    };
  }

  private recompute(): void {
    const next = this.derive();
    const json = JSON.stringify(next);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.state = next;
    this.emit("change", next);
  }
}
