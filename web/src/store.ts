import type { ChampionSummary, PhoneState } from "@shared/phone-api";
import { reactive } from "vue";
import * as api from "./api";

export const app = reactive({
  paired: false,
  /** Signing in with the QR code right now. */
  pairing: false,
  socket: "connecting" as api.SocketStatus,
  state: null as PhoneState | null,
  champions: new Map<number, ChampionSummary>(),
  /** Local clock (performance.now) when the current champ-select timer value arrived. */
  csTimerBase: { value: -1, at: 0 },
  queueTimerBase: { value: -1, at: 0 },
  readyTimerBase: { value: -1, at: 0 },
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
  const rc = state.readyCheck;
  if (!rc) app.readyTimerBase = { value: -1, at: 0 };
  else if (rc.timer !== app.readyTimerBase.value) app.readyTimerBase = { value: rc.timer, at: now };

  // (Re)load the champion list whenever the League client (re)connects.
  if (state.lcu === "connected" && (lastLcuStatus !== "connected" || app.champions.size === 0)) void loadChampions();
  if (state.lcu !== "connected") app.champions = new Map();
  lastLcuStatus = state.lcu;
  app.state = state;
}

/** The phone's Unpair button: the PC forgets this phone. */
export async function unpairPhone(): Promise<void> {
  await api.unpair();
  unpair();
}

function unpair(): void {
  api.forgetToken();
  socket?.close();
  socket = null;
  app.paired = false;
  app.state = null;
}

/**
 * A phone tab can stay open for days and never re-download the app, so after the connector is
 * updated it would keep running old code. Compare our own script with the one index.html names now.
 */
async function checkForNewVersion(): Promise<void> {
  try {
    const own = new URL(import.meta.url).pathname;
    if (!own.startsWith("/assets/")) return; // dev server
    const html = await (await fetch("/", { cache: "no-store" })).text();
    if (html.includes(own)) return;
    const last = Number(sessionStorage.getItem("lolc.reloadedAt") ?? 0);
    if (Date.now() - last < 30_000) return; // never loop
    sessionStorage.setItem("lolc.reloadedAt", String(Date.now()));
    location.reload();
  } catch {
    // offline or storage blocked: keep running the current version
  }
}

export function start(): void {
  const { token, ticket } = api.initToken();
  app.paired = !!token;
  if (ticket) void pairWithTicket(ticket);
  else if (app.paired) openSocket();
  window.setInterval(() => (app.now = performance.now()), 250);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForNewVersion();
  });
}

/** Opened from the QR code: sign in with it. If it was already used, fall back to a saved key. */
async function pairWithTicket(ticket: string): Promise<void> {
  app.pairing = true;
  try {
    await api.pair({ ticket });
    app.paired = true;
  } catch (e) {
    showToast(app.paired ? "This QR code was already used, but this phone is still paired." : (e as Error).message, app.paired ? "info" : "error");
  } finally {
    app.pairing = false;
  }
  if (app.paired) openSocket();
}

function openSocket(): void {
  socket?.close();
  socket = api.connectSocket({
    onState,
    onStatus: (s) => {
      app.socket = s;
      if (s === "open") void checkForNewVersion();
    },
    onUnauthorized: () => {
      unpair();
      showToast("This phone isn't paired with this PC anymore. Scan the QR code in the Ward window or enter the code.", "info");
    },
  });
}

export async function pairWithCode(code: string): Promise<void> {
  await api.pair({ code });
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
      showToast("This phone isn't paired with this PC anymore. Scan the QR code in the Ward window or enter the code.", "info");
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
  // Round down like the League client does; rounding up showed one second more than the PC.
  return Math.max(0, Math.floor((base.value - (app.now - base.at)) / 1000));
}

/** Seconds elapsed in the ready check (League sends whole seconds), counted up locally between pushes. */
export function readyCheckElapsed(): number {
  const base = app.readyTimerBase;
  if (base.value < 0) return 0;
  return base.value + Math.min(1, (app.now - base.at) / 1000);
}

export function queueSeconds(): number {
  const base = app.queueTimerBase;
  if (base.value < 0) return 0;
  return Math.floor(base.value + (app.now - base.at) / 1000);
}

export function championName(id: number): string {
  return app.champions.get(id)?.name ?? (id > 0 ? `#${id}` : "");
}
