/**
 * Holds the raw LCU resources we care about and derives the sanitised PhoneState.
 *
 * Fed by (a) a snapshot of every watched endpoint when we connect or the
 * gameflow phase changes, and (b) live websocket events in between.
 */

import { EventEmitter } from "node:events";
import type { LcuHttp } from "../lcu/http";
import type { LcuEvent } from "../lcu/socket";
import type { LcuStatus, LobbyView, PhoneState, QueueView, ReadyCheckView } from "../shared/phone-api";
import { deriveChampSelect, type LcuSession } from "./champ-select";

export const URI = {
  phase: "/lol-gameflow/v1/gameflow-phase",
  lobby: "/lol-lobby/v2/lobby",
  search: "/lol-matchmaking/v1/search",
  readyCheck: "/lol-matchmaking/v1/ready-check",
  session: "/lol-champ-select/v1/session",
  pickable: "/lol-champ-select/v1/pickable-champion-ids",
  bannable: "/lol-champ-select/v1/bannable-champion-ids",
} as const;

type Key = keyof typeof URI;
export const WATCHED_URIS: ReadonlySet<string> = new Set(Object.values(URI));
const KEY_BY_URI = new Map<string, Key>(Object.entries(URI).map(([k, v]) => [v, k as Key]));

interface RawLobby {
  canStartActivity?: boolean;
  localMember?: { isLeader?: boolean };
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

type Raw = {
  phase: string | null;
  lobby: RawLobby | null;
  search: RawSearch | null;
  readyCheck: RawReadyCheck | null;
  session: LcuSession | null;
  pickable: number[] | null;
  bannable: number[] | null;
};

const emptyRaw = (): Raw => ({
  phase: null,
  lobby: null,
  search: null,
  readyCheck: null,
  session: null,
  pickable: null,
  bannable: null,
});

export function deriveLobby(lobby: RawLobby | null, queueName: string | null): LobbyView | null {
  if (!lobby) return null;
  const queueId = lobby.gameConfig?.queueId;
  return {
    queueId: Number.isInteger(queueId) ? (queueId as number) : null,
    queueName,
    isLeader: !!lobby.localMember?.isLeader,
    canStartActivity: !!lobby.canStartActivity,
    memberCount: Array.isArray(lobby.members) ? lobby.members.length : 1,
  };
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
  state: PhoneState = this.derive();

  setLcuStatus(status: LcuStatus): void {
    this.lcuStatus = status;
    this.recompute();
  }

  attach(http: LcuHttp): void {
    this.http = http;
    this.raw = emptyRaw();
    this.queueNames.clear();
    void this.refreshAll();
  }

  detach(): void {
    this.http = null;
    this.raw = emptyRaw();
    if (this.snapshotRetry) clearTimeout(this.snapshotRetry);
    this.snapshotRetry = null;
    this.recompute();
  }

  /** Latest raw session (used by actions as a fallback; actions normally re-fetch). */
  get session(): LcuSession | null {
    return this.raw.session;
  }

  handleEvent(e: LcuEvent): void {
    const key = KEY_BY_URI.get(e.uri);
    if (!key) return;
    const value = e.eventType === "Delete" ? null : e.data;
    this.setRaw(key, value);
  }

  /** Fetches every watched endpoint. Retries until the client's plugins are up. */
  async refreshAll(): Promise<void> {
    const http = this.http;
    if (!http) return;
    const entries = await Promise.all(
      (Object.keys(URI) as Key[]).map(async (k) => [k, await http.getOrNull(URI[k])] as const),
    );
    if (http !== this.http) return; // reconnected meanwhile
    for (const [k, v] of entries) this.setRaw(k, v, false);
    this.recompute();

    if (this.snapshotRetry) clearTimeout(this.snapshotRetry);
    this.snapshotRetry = null;
    if (this.raw.phase === null) {
      // gameflow plugin not loaded yet (client still booting)
      this.snapshotRetry = setTimeout(() => void this.refreshAll(), 3000);
    }
  }

  private setRaw(key: Key, value: unknown, recompute = true): void {
    const prevPhase = this.raw.phase;
    switch (key) {
      case "phase":
        this.raw.phase = typeof value === "string" ? value : null;
        break;
      case "pickable":
      case "bannable":
        this.raw[key] = Array.isArray(value) ? value.filter((n): n is number => Number.isInteger(n)) : null;
        break;
      case "session": {
        const s = value as LcuSession | null;
        this.raw.session = s && typeof s === "object" && Array.isArray(s.myTeam) ? s : null;
        break;
      }
      default:
        this.raw[key] = value && typeof value === "object" ? (value as never) : null;
    }

    if (key === "lobby") void this.ensureQueueName();

    if (recompute) {
      this.recompute();
      if (key === "phase" && prevPhase !== this.raw.phase) {
        this.emit("phase", this.raw.phase);
        // Resync everything on phase transitions so a missed event can't leave stale state.
        void this.refreshAll();
      }
    }
  }

  private async ensureQueueName(): Promise<void> {
    const id = this.raw.lobby?.gameConfig?.queueId;
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
