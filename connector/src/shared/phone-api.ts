/**
 * Types shared between the connector and the phone UI.
 *
 * PhoneState is a *sanitised* view of the League client: it never contains
 * puuids, summoner/account ids, chat credentials or anything else the phone
 * doesn't need to render the screens.
 */

export type LcuStatus = "searching" | "connecting" | "connected";

/** Gameflow phases reported by /lol-gameflow/v1/gameflow-phase. Unknown values pass through as strings. */
export type GameflowPhase =
  | "None"
  | "Lobby"
  | "Matchmaking"
  | "CheckedIntoTournament"
  | "ReadyCheck"
  | "ChampSelect"
  | "GameStart"
  | "FailedToLaunch"
  | "InProgress"
  | "Reconnect"
  | "WaitingForStats"
  | "PreEndOfGame"
  | "EndOfGame"
  | "TerminatedInError"
  | (string & {});

export interface LobbyView {
  queueId: number | null;
  queueName: string | null;
  isLeader: boolean;
  canStartActivity: boolean;
  memberCount: number;
  /** League lets me invite friends to this lobby. */
  canInvite: boolean;
}

export interface QueueView {
  searchState: string;
  /** Seconds in queue at the moment the snapshot was taken. */
  timeInQueue: number;
  estimatedQueueTime: number;
  /** Largest penalty (queue dodge / low priority) in seconds, 0 if none. */
  penaltySeconds: number;
  errors: string[];
}

export interface ReadyCheckView {
  state: string; // "InProgress" | "Invalid" | ...
  playerResponse: string; // "None" | "Accepted" | "Declined"
  /** Seconds elapsed in the ready check (LCU counts up to ~12). */
  timer: number;
}

export type ActionType = "pick" | "ban";

/** The three kinds of swap League offers between teammates in champ select. */
export type SwapKind = "position" | "pickOrder" | "champion";
/** available = I can offer it; sent = I asked, waiting; received = they asked me. */
export type SwapState = "available" | "sent" | "received";
export const SWAP_KINDS: readonly SwapKind[] = ["position", "pickOrder", "champion"];

export interface ChampSelectPlayer {
  cellId: number;
  /** Display label; teammates' Riot ID game name when the client exposes it, otherwise "Player N". */
  name: string;
  position: string; // "top" | "jungle" | "middle" | "bottom" | "utility" | ""
  championId: number; // locked/hovered champion (0 = none)
  pickIntentId: number; // planning-phase intent (0 = none)
  isMe: boolean;
  /** This player currently has an in-progress action. */
  activeAction: ActionType | null;
  isBot: boolean;
  /** 1-based order of this player's pick within their team (0 = unknown). */
  pickTurn: number;
  /** Swaps between me and this teammate (empty for me and for enemies). */
  swaps: Partial<Record<SwapKind, SwapState>>;
}

export interface MyTurn {
  /** What I'm doing right now. */
  type: ActionType;
  /** Champion currently hovered on that action (0 = none). */
  championId: number;
}

export interface ChampSelectView {
  /** Timer phase: "PLANNING" | "BAN_PICK" | "FINALIZATION" | "GAME_STARTING". */
  phase: string;
  timeLeftMs: number;
  isInfinite: boolean;
  myTeam: ChampSelectPlayer[];
  theirTeam: ChampSelectPlayer[];
  bans: { myTeam: number[]; theirTeam: number[] };
  /** Set when it's my turn (I have an in-progress, uncompleted action). */
  myTurn: MyTurn | null;
  /** True when I can declare/change a pick intent (hover without locking). */
  canHoverIntent: boolean;
  /** True once all my pick actions are completed. */
  hasLockedPick: boolean;
  pickableChampionIds: number[];
  bannableChampionIds: number[];
  /** My summoner spells [D, F] (0 = none) and selected skin (0 = default / none yet). */
  mySpells: [number, number];
  mySkinId: number;
  /** Champions someone has locked in, either team (they can't be picked again). */
  lockedChampionIds: number[];
  /** ARAM-style bench: champions I can swap mine for (null = this mode has no bench). */
  bench: number[] | null;
  /** Rerolls I have left (null = this mode doesn't allow rerolling). */
  rerollsLeft: number | null;
  /** Modes that offer each player a few champions: the ones League offers me (empty otherwise). */
  choices: number[];
}

/** A summoner spell I can take into this game (GET /api/spells). */
export interface SpellOption {
  id: number;
  name: string;
}

/** A skin I can use on my current champion, with its usable chromas (GET /api/skins). */
export interface SkinOption {
  id: number;
  name: string;
  isBase: boolean;
  chromas: { id: number; name: string; color: string | null }[];
}

/** A lobby invitation someone sent me. */
export interface InvitationView {
  handle: string;
  /** The inviter's Riot ID game name, or "A friend" when the client doesn't say. */
  from: string;
  queueName: string | null;
  canAccept: boolean;
}

/** A friend I could invite to my lobby (GET /api/friends). */
export interface FriendOption {
  handle: string;
  name: string;
  /** "Online", "Away", "In queue", "In champ select", "In game", "In your lobby", "Invited" */
  status: string;
  canInvite: boolean;
}

/** Which group chat: my lobby's (also while queued) or my team's in champ select. */
export type ChatRoomKind = "lobby" | "champSelect";

export interface ChatMessage {
  /** Grows with every new message the connector sees, so a higher id is newer. */
  id: number;
  /** joined / left: someone came into or left the lobby (lobby chat only). */
  kind: "message" | "joined" | "left";
  /** "You", the sender's Riot ID game name, their champ-select label ("Ally 2"), or "Someone". */
  from: string;
  isMe: boolean;
  /** The sender's champion in champ select (0 = none, and always 0 in the lobby). */
  championId: number;
  text: string;
  /** Epoch ms (0 = League didn't say). */
  time: number;
}

export interface ChatView {
  /** Opaque name for this room; a new lobby or champ select gets a new one. */
  room: string;
  kind: ChatRoomKind;
  /** League has joined the room's chat, so messages can be sent. */
  ready: boolean;
  /** Oldest first, at most the last 60. */
  messages: ChatMessage[];
}

export interface PhoneState {
  lcu: LcuStatus;
  phase: GameflowPhase | null;
  lobby: LobbyView | null;
  queue: QueueView | null;
  readyCheck: ReadyCheckView | null;
  champSelect: ChampSelectView | null;
  invitations: InvitationView[];
  /** The chat of the lobby or champ select I'm in (null when there's none). */
  chat: ChatView | null;
}

export interface ChampionSummary {
  id: number;
  name: string;
  alias: string;
}

/** Messages sent over the phone websocket. */
export type ServerMessage =
  | { type: "state"; state: PhoneState }
  | { type: "error"; message: string };

export type ClientMessage = { type: "auth"; token: string };

export interface ApiError {
  error: string;
}
