import type { ChampionSummary, PhoneState } from "@shared/phone-api";
import { reactive } from "vue";
import * as api from "./api";

export const app = reactive({
  paired: false,
  socket: "connecting" as api.SocketStatus,
  state: null as PhoneState | null,
  champions: new Map<number, ChampionSummary>(),
  /** Local clock (performance.now) when the current champ-select timer value arrived. */
  csTimerBase: { value: -1, at: 0 },
  queueTimerBase: { value: -1, at: 0 },
  toast: null as { text: string; kind: "error" | "info" } | null,
  busy: false,
  /** Monotonic tick so countdowns re-render. */
  now: performance.now(),
});

let socket: ReturnType<typeof api.connectSocket> | null = null;
let toastTimer: number | undefined;
let lastLcuStatus: string | null = null;

export function showToast(text: string, kind: "error" | "info" = "error"): void {
  app.toast = { text, kind };
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (app.toast = null), 3500);
}

async function loadChampions(): Promise<void> {
  try {
    const list = await api.fetchChampions();
    app.champions = new Map(list.map((c) => [c.id, c]));
  } catch {
    // retried on the next state push
  }
}

function onState(state: PhoneState): void {
  const now = performance.now();
  // Every push carries the time left *as of sending*, so restart the local countdown each time.
  const cs = state.champSelect;
  if (cs) app.csTimerBase = { value: cs.timeLeftMs, at: now };
  const q = state.queue;
  if (q && q.timeInQueue !== app.queueTimerBase.value) app.queueTimerBase = { value: q.timeInQueue, at: now };

  // (Re)load the champion list whenever the League client (re)connects.
  if (state.lcu === "connected" && (lastLcuStatus !== "connected" || app.champions.size === 0)) void loadChampions();
  if (state.lcu !== "connected") app.champions = new Map();
  lastLcuStatus = state.lcu;
  app.state = state;
}

function unpair(): void {
  api.forgetToken();
  socket?.close();
  socket = null;
  app.paired = false;
  app.state = null;
}

export function start(): void {
  app.paired = !!api.initToken();
  if (app.paired) openSocket();
  window.setInterval(() => (app.now = performance.now()), 250);
}

function openSocket(): void {
  socket?.close();
  socket = api.connectSocket({
    onState,
    onStatus: (s) => (app.socket = s),
    onUnauthorized: () => {
      unpair();
      showToast("This phone isn't paired with the current connector session. Scan the QR or enter the code.", "info");
    },
  });
}

export async function pairWithCode(code: string): Promise<void> {
  await api.pair(code);
  app.paired = true;
  openSocket();
}

/** Runs a whitelisted action; shows the connector's message on failure. */
export async function run(name: api.ActionName, body?: Record<string, unknown>): Promise<boolean> {
  try {
    await api.action(name, body);
    return true;
  } catch (e) {
    if (e instanceof api.UnauthorizedError) {
      unpair();
      showToast("Pairing expired. Scan the QR or enter the code again.", "info");
    } else {
      showToast((e as Error).message);
    }
    return false;
  }
}

/** Seconds left on the champ-select timer, counted down locally between pushes. */
export function champSelectSecondsLeft(): number {
  const base = app.csTimerBase;
  if (base.value < 0) return 0;
  return Math.max(0, Math.ceil((base.value - (app.now - base.at)) / 1000));
}

export function queueSeconds(): number {
  const base = app.queueTimerBase;
  if (base.value < 0) return 0;
  return Math.floor(base.value + (app.now - base.at) / 1000);
}

export function championName(id: number): string {
  return app.champions.get(id)?.name ?? (id > 0 ? `#${id}` : "");
}
