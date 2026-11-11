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
}

export interface PhoneState {
  lcu: LcuStatus;
  phase: GameflowPhase | null;
  lobby: LobbyView | null;
  queue: QueueView | null;
  readyCheck: ReadyCheckView | null;
  champSelect: ChampSelectView | null;
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
