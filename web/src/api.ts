/**
 * Talks to the connector: token storage, pairing, the state websocket,
 * whitelisted actions and champion icons.
 */

import type {
  ApiError,
  ChampionSummary,
  FriendOption,
  PhoneState,
  ServerMessage,
  SkinOption,
  SpellOption,
} from "@shared/phone-api";

const TOKEN_KEY = "lolc.token";

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode etc.: token then lives only in memory for this page
  }
}

let token: string | null = null;

/** Reads ?t= from the QR link (then strips it from the address bar), else localStorage. */
export function initToken(): string | null {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("t");
  if (fromUrl && /^[A-Za-z0-9_-]{16,128}$/.test(fromUrl)) {
    token = fromUrl;
    safeSet(TOKEN_KEY, fromUrl);
  } else {
    token = safeGet(TOKEN_KEY);
  }
  if (url.searchParams.has("t")) history.replaceState(null, "", url.pathname);
  return token;
}

export function hasToken(): boolean {
  return !!token;
}

export function forgetToken(): void {
  token = null;
  safeSet(TOKEN_KEY, null);
}

export class UnauthorizedError extends Error {}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiError;
    if (body?.error) return body.error;
  } catch {
    // ignore
  }
  return `Request failed (${res.status})`;
}

export async function pair(code: string): Promise<void> {
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("Pairing failed");
  token = body.token;
  safeSet(TOKEN_KEY, body.token);
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  if (!token) throw new UnauthorizedError();
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) throw new UnauthorizedError();
  return res;
}

export type ActionName =
  | "ready-check/accept"
  | "ready-check/decline"
  | "queue/start"
  | "queue/cancel"
  | "champ-select/hover"
  | "champ-select/lock"
  | "champ-select/spells"
  | "champ-select/skin"
  | "champ-select/swap/accept"
  | "champ-select/swap/decline"
  | "champ-select/swap/request"
  | "champ-select/swap/cancel"
  | "invitations/accept"
  | "invitations/decline"
  | "lobby/invite";

export async function action(name: ActionName, body?: Record<string, unknown>): Promise<void> {
  const res = await authed(`/api/${name}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}

export async function fetchChampions(): Promise<ChampionSummary[]> {
  const res = await authed("/api/champions");
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as ChampionSummary[];
}

export async function fetchSpells(): Promise<SpellOption[]> {
  const res = await authed("/api/spells");
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as SpellOption[];
}

export async function fetchSkins(): Promise<SkinOption[]> {
  return getJson<SkinOption[]>("/api/skins");
}

async function getJson<T>(path: string): Promise<T> {
  const res = await authed(path);
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

export const fetchFriends = () => getJson<FriendOption[]>("/api/friends");

// ---------- images: fetched with the auth header, kept as blob: URLs ----------

const iconUrls = new Map<string, Promise<string | null>>();
const queue: (() => void)[] = [];
let inFlight = 0;
const MAX_PARALLEL = 6;

function runQueued<T>(job: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = () => {
      inFlight++;
      job()
        .then(resolve, reject)
        .finally(() => {
          inFlight--;
          queue.shift()?.();
        });
    };
    if (inFlight < MAX_PARALLEL) start();
    else queue.push(start);
  });
}

export type ImageKind = "champion" | "spell" | "skin";
const IMAGE_PATHS: Record<ImageKind, (id: number) => string> = {
  champion: (id) => `/api/champions/${id}/icon`,
  spell: (id) => `/api/spells/${id}/image`,
  skin: (id) => `/api/skins/${id}/image`,
};

export function iconUrl(id: number, kind: ImageKind = "champion"): Promise<string | null> {
  if (!(id > 0)) return Promise.resolve(null);
  const key = `${kind}:${id}`;
  let p = iconUrls.get(key);
  if (!p) {
    p = runQueued(async () => {
      try {
        const res = await authed(IMAGE_PATHS[kind](id));
        if (!res.ok) return null;
        return URL.createObjectURL(await res.blob());
      } catch {
        return null;
      }
    });
    p.then((url) => {
      if (!url) iconUrls.delete(key); // retry later (e.g. client was reconnecting)
    });
    iconUrls.set(key, p);
  }
  return p;
}

// ---------- state websocket ----------

export type SocketStatus = "connecting" | "open" | "closed";

export interface SocketHandlers {
  onState(state: PhoneState): void;
  onStatus(status: SocketStatus): void;
  onUnauthorized(): void;
}

export function connectSocket(h: SocketHandlers): { reconnectNow(): void; close(): void } {
  let ws: WebSocket | null = null;
  let retry: number | undefined;
  let delay = 500;
  let stopped = false;

  const open = () => {
    if (stopped || !token) return;
    clearTimeout(retry);
    h.onStatus("connecting");
    const socket = new WebSocket(`ws://${location.host}/ws`);
    ws = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token }));
    socket.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "state") {
        delay = 500;
        h.onStatus("open");
        h.onState(msg.state);
      }
    };
    socket.onclose = (ev) => {
      if (ws !== socket) return;
      ws = null;
      h.onStatus("closed");
      if (ev.code === 4003) {
        h.onUnauthorized();
        return;
      }
      if (stopped) return;
      retry = window.setTimeout(open, delay);
      delay = Math.min(delay * 2, 5000);
    };
  };

  // Phones suspend background tabs; reconnect right away when we come back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (!ws || ws.readyState > WebSocket.OPEN)) {
      delay = 500;
      open();
    }
  });

  open();
  return {
    reconnectNow() {
      delay = 500;
      ws?.close();
      if (!ws) open();
    },
    close() {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    },
  };
}
