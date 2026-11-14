/**
 * The lobby's and champ select's group chat.
 *
 * Endpoints (client API list, 2026-11-14):
 * - /lol-chat/v1/conversations                     every conversation I'm in (id, type)
 * - /lol-chat/v1/conversations/{id}/messages       GET the history, POST { body, type: "groupchat" } to write
 * - /lol-chat/v1/conversations/{id}/participants   who's in it (names for lobby messages)
 * - /lol-chat/v1/me                                my own ids, to recognise my messages
 *
 * The room comes from multiUserChatId on /lol-lobby/v2/lobby or the champ-select session's
 * chatDetails. New messages arrive as websocket events under /lol-chat/v1/conversations/...; any
 * event for the room re-reads its messages, and a slow poll covers missed events.
 *
 * The phone gets the sender's display name, the text and the time. Ids stay in the connector, and
 * in champ select names come only from the session, so names League hides there stay hidden.
 */

import { randomBytes } from "node:crypto";
import type { LcuHttp } from "./lcu/http";
import type { LcuEvent } from "./lcu/socket";
import { log } from "./log";
import type { ChatMessage, ChatRoomKind, ChatView } from "./shared/phone-api";

export const CHAT_CONVERSATIONS = "/lol-chat/v1/conversations";
export const MAX_CHAT_TEXT = 200;
const MAX_MESSAGES = 60;
const MAX_INCOMING_TEXT = 500;
const POLL_MS = 4000;

/** Phases where the lobby (and its chat) is still there. */
const LOBBY_PHASES = new Set(["Lobby", "Matchmaking", "ReadyCheck"]);

const CONVERSATION_ID = /^[A-Za-z0-9@._~-]{1,200}$/;
/**
 * Seen on a live client (2026-11-14): conversation ids contain "@", ".", "-", and GET .../messages
 * answered the same whether the id was percent-encoded or not.
 */
export const conversationPath = (id: string, what: "messages" | "participants") => `${CHAT_CONVERSATIONS}/${encodeURIComponent(id)}/${what}`;

/** Someone who can write in the room, with every id League may put on their messages. */
export interface ChatMember {
  ids: readonly unknown[];
  /** Display name, "" when the source doesn't have one. */
  name: string;
  championId: number;
  isMe: boolean;
}

export interface ChatRoom {
  kind: ChatRoomKind;
  /** multiUserChatId from the lobby or the champ-select session. */
  mucId: string | null;
  members: readonly ChatMember[];
}

/** The subset of a LolChatConversationMessageResource we read. */
export interface RawChatMessage {
  id?: unknown;
  type?: unknown;
  body?: unknown;
  timestamp?: unknown;
  fromId?: unknown;
  fromPid?: unknown;
  fromPuuid?: unknown;
  fromSummonerId?: unknown;
  fromObfuscatedPuuid?: unknown;
  fromObfuscatedSummonerId?: unknown;
}

/** An id worth comparing: a non-empty string or a positive number, as a string. */
function idKey(v: unknown): string | null {
  if (typeof v === "string") return v.trim() && v !== "0" ? v.trim().toLowerCase() : null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return String(v);
  return null;
}
const idKeys = (values: readonly unknown[]) => values.map(idKey).filter((k): k is string => k !== null);

const senderIds = (m: RawChatMessage) =>
  idKeys([m.fromPuuid, m.fromSummonerId, m.fromObfuscatedPuuid, m.fromObfuscatedSummonerId, m.fromPid, m.fromId]);

function mucIdOf(details: unknown): string | null {
  const id = (details as { multiUserChatId?: unknown } | null)?.multiUserChatId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/** Which chat room goes with this phase: champ select's, the lobby's, or none. Members are filled in by the caller. */
export function chatRoomFor(phase: string | null, lobby: unknown, session: unknown): Omit<ChatRoom, "members"> | null {
  if (phase === "ChampSelect") return session ? { kind: "champSelect", mucId: mucIdOf((session as { chatDetails?: unknown }).chatDetails) } : null;
  if (phase && LOBBY_PHASES.has(phase)) return lobby ? { kind: "lobby", mucId: mucIdOf(lobby) } : null;
  return null;
}

/** League's conversation types per room. Only used when the room's id doesn't match any conversation. */
const ROOM_TYPES: Record<ChatRoomKind, readonly string[]> = {
  lobby: ["customGame", "premade", "lobby"],
  champSelect: ["championSelect"],
};

const localPart = (id: string) => id.split("@")[0]!.toLowerCase();

/** The conversation for this room: the one whose id matches the room's, else the only one of the room's type. */
export function findConversation(conversations: unknown, room: Omit<ChatRoom, "members">): { id: string; by: "id" | "type" } | null {
  if (!Array.isArray(conversations)) return null;
  const valid = conversations.filter(
    (c): c is { id: string; type?: unknown } => !!c && typeof c.id === "string" && CONVERSATION_ID.test(c.id),
  );
  if (room.mucId) {
    const want = localPart(room.mucId);
    const hit = valid.find((c) => localPart(c.id) === want);
    if (hit) return { id: hit.id, by: "id" };
  }
  const typed = valid.filter((c) => typeof c.type === "string" && ROOM_TYPES[room.kind].includes(c.type));
  return typed.length === 1 ? { id: typed[0]!.id, by: "type" } : null;
}

/** Control characters, plus the Unicode line and paragraph separators (U+2028, U+2029). */
const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f${String.fromCharCode(0x2028, 0x2029)}]+`, "g");

/** Message text as plain one-line text (control characters become spaces), or "" if there's none. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return [...v.replace(CONTROL, " ").trim()].slice(0, max).join("");
}

const SYSTEM_KINDS: Record<string, ChatMessage["kind"]> = { joined_room: "joined", left_room: "left" };

/**
 * The phone's view of a room's messages. Pure, so it can be tested with recorded answers.
 * `seq` gives each League message id a stable, increasing number.
 */
export function deriveMessages(
  raw: readonly RawChatMessage[],
  room: ChatRoom,
  me: ReadonlySet<string>,
  extraNames: ReadonlyMap<string, string>,
  seq: (key: string) => number,
): ChatMessage[] {
  const byId = new Map<string, ChatMember>();
  for (const m of room.members) for (const k of idKeys(m.ids)) byId.set(k, m);
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const type = typeof m.type === "string" ? m.type : "";
    let kind: ChatMessage["kind"];
    let text = "";
    if (type === "groupchat" || type === "chat") {
      kind = "message";
      text = cleanText(m.body, MAX_INCOMING_TEXT);
      if (!text) continue;
    } else if (type === "system" && room.kind === "lobby" && typeof m.body === "string" && SYSTEM_KINDS[m.body]) {
      kind = SYSTEM_KINDS[m.body]!;
    } else continue;

    const ids = senderIds(m);
    const member = ids.map((k) => byId.get(k)).find(Boolean);
    const isMe = !!member?.isMe || ids.some((k) => me.has(k));
    // In champ select only the session's names are used: League hides some names there on purpose.
    const extra = room.kind === "lobby" ? ids.map((k) => extraNames.get(k)).find(Boolean) : undefined;
    const fallback = room.kind === "champSelect" ? "Teammate" : "Someone";
    const name = isMe ? "You" : (member?.name || extra || fallback).slice(0, 32);
    const time = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : NaN;
    const key = typeof m.id === "string" || typeof m.id === "number" ? String(m.id) : `${String(m.timestamp)}|${ids[0] ?? ""}|${text}`;
    out.push({
      id: seq(key),
      kind,
      from: name,
      isMe,
      championId: room.kind === "champSelect" && member && member.championId > 0 ? member.championId : 0,
      text,
      time: Number.isFinite(time) ? time : 0,
    });
  }
  return out.slice(-MAX_MESSAGES);
}

/** The chat the phone may write to right now, read fresh from the client (for the send action). */
export async function currentConversation(http: LcuHttp): Promise<{ id: string; kind: ChatRoomKind } | null> {
  const phase = await http.getOrNull<string>("/lol-gameflow/v1/gameflow-phase");
  const lobby = phase && LOBBY_PHASES.has(phase) ? await http.getOrNull("/lol-lobby/v2/lobby") : null;
  const session = phase === "ChampSelect" ? await http.getOrNull<{ isSpectating?: unknown }>("/lol-champ-select/v1/session") : null;
  if (session?.isSpectating === true) return null;
  const room = chatRoomFor(phase, lobby, session);
  if (!room) return null;
  const found = findConversation(await http.getOrNull(CHAT_CONVERSATIONS), room);
  return found ? { id: found.id, kind: room.kind } : null;
}

/** Keeps the current room's messages up to date and builds the phone's ChatView. */
export class Chat {
  private http: LcuHttp | null = null;
  private room: ChatRoom | null = null;
  private roomKey = "";
  private roomHandle = "";
  private conversationId: string | null = null;
  private raw: RawChatMessage[] = [];
  private me = new Set<string>();
  private names = new Map<string, string>();
  private namesFetchedAt = 0;
  private seqs = new Map<string, number>();
  private nextSeq = 1;
  private misses = 0;
  private poll: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private fetching = false;
  private again = false;

  /** `onChange` is called when the view may have changed (never from inside setRoom). */
  constructor(private readonly onChange: () => void) {}

  attach(http: LcuHttp): void {
    this.setRoom(null);
    this.http = http;
    this.me.clear();
    void this.loadMe(http);
  }

  detach(): void {
    this.setRoom(null);
    this.http = null;
  }

  /** Called on every state change. Cheap when the room stays the same (members may change). */
  setRoom(room: ChatRoom | null): void {
    this.room = room;
    const key = room ? `${room.kind}|${room.mucId ?? ""}` : "";
    if (key === this.roomKey) return;
    this.roomKey = key;
    this.roomHandle = room ? randomBytes(6).toString("base64url") : "";
    this.conversationId = null;
    this.raw = [];
    this.names.clear();
    this.namesFetchedAt = 0;
    this.seqs.clear();
    this.misses = 0;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (!room || !this.http) return;
    this.poll = setInterval(() => void this.refresh(), POLL_MS);
    this.poll.unref?.();
    this.refreshSoon(0);
  }

  handleEvent(e: LcuEvent): void {
    if (!this.room || !e.uri.startsWith(CHAT_CONVERSATIONS)) return;
    if (this.conversationId) {
      let uri = e.uri;
      try {
        uri = decodeURIComponent(uri);
      } catch {
        // keep it as it came
      }
      if (!uri.includes(this.conversationId) && uri !== CHAT_CONVERSATIONS) return;
    }
    this.refreshSoon();
  }

  /** Re-reads the room shortly (bursts of events become one read). */
  refreshSoon(delayMs = 60): void {
    if (this.soon || !this.room) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.refresh();
    }, delayMs);
    this.soon.unref?.();
  }

  view(): ChatView | null {
    const room = this.room;
    if (!room) return null;
    return {
      room: this.roomHandle,
      kind: room.kind,
      ready: this.conversationId !== null,
      messages: deriveMessages(this.raw, room, this.me, this.names, (k) => this.seq(k)),
    };
  }

  private seq(key: string): number {
    let n = this.seqs.get(key);
    if (n === undefined) {
      n = this.nextSeq++;
      this.seqs.set(key, n);
    }
    return n;
  }

  private async loadMe(http: LcuHttp): Promise<void> {
    const me = await http.getOrNull<Record<string, unknown>>("/lol-chat/v1/me");
    if (!me || http !== this.http) return;
    for (const k of idKeys([me.puuid, me.summonerId, me.pid, me.id, me.obfuscatedSummonerId])) this.me.add(k);
    this.onChange();
  }

  async refresh(): Promise<void> {
    if (this.fetching) {
      this.again = true;
      return;
    }
    this.fetching = true;
    try {
      await this.read();
    } finally {
      this.fetching = false;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    }
  }

  private async read(): Promise<void> {
    const http = this.http;
    const room = this.room;
    const key = this.roomKey;
    if (!http || !room) return;
    const stale = () => http !== this.http || key !== this.roomKey;

    if (!this.conversationId) {
      const conversations = await http.getOrNull(CHAT_CONVERSATIONS);
      if (stale()) return;
      const found = findConversation(conversations, room);
      if (!found) {
        // League joins the room a moment after the lobby appears; say so only if it never does.
        if (++this.misses === 3) {
          const types = Array.isArray(conversations) ? [...new Set(conversations.map((c) => String(c?.type)))].join(", ") : "none";
          log.info(`Chat: no ${room.kind} conversation found yet (conversation types: ${types || "none"})`);
        }
        return;
      }
      this.conversationId = found.id;
      log.info(`Chat: following the ${room.kind === "lobby" ? "lobby" : "champ select"} chat (found by ${found.by})`);
      this.onChange();
    }

    const id = this.conversationId;
    const messages = await http.getOrNull<RawChatMessage[]>(conversationPath(id, "messages"));
    if (stale() || id !== this.conversationId) return;
    if (!Array.isArray(messages)) {
      // The conversation went away (left the room) or the client hiccupped: look it up again next time.
      this.conversationId = null;
      this.onChange();
      return;
    }
    this.raw = messages.slice(-MAX_MESSAGES * 2);
    this.onChange();
    if (room.kind === "lobby") void this.loadNamesIfNeeded(http, id);
  }

  /** Lobby members don't always carry a name, so ask the conversation who's in it when a sender is unknown. */
  private async loadNamesIfNeeded(http: LcuHttp, id: string): Promise<void> {
    const room = this.room;
    if (!room || Date.now() - this.namesFetchedAt < 5000) return;
    const known = new Set([...this.me, ...this.names.keys(), ...room.members.filter((m) => m.name).flatMap((m) => idKeys(m.ids))]);
    const unknown = this.raw.some((m) => {
      const ids = senderIds(m);
      return ids.length > 0 && !ids.some((k) => known.has(k));
    });
    if (!unknown) return;
    this.namesFetchedAt = Date.now();
    const people = await http.getOrNull<Record<string, unknown>[]>(conversationPath(id, "participants"));
    if (!Array.isArray(people) || http !== this.http || id !== this.conversationId) return;
    for (const p of people) {
      const name = [p?.gameName, p?.name].find((n): n is string => typeof n === "string" && n.trim() !== "");
      if (!name) continue;
      for (const k of idKeys([p.puuid, p.summonerId, p.pid, p.id, p.obfuscatedSummonerId])) this.names.set(k, name.trim().slice(0, 32));
    }
    this.onChange();
  }
}
