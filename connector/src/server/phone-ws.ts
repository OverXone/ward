/**
 * Phone websocket: pushes PhoneState. Read-only (actions go over HTTP POST).
 *
 * Handshake checks: private source IP, exact Host, exact Origin, path /ws.
 * Then the first frame must be {"type":"auth","token":"..."} within 3 s.
 * Close code 4003 = bad token (UI should re-pair), 4001 = auth timeout.
 */

import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { PhoneState, ServerMessage } from "../shared/phone-api";
import type { Store } from "../state/store";
import { safeEqual, type FailureLimiter } from "./auth";
import { isPrivateIPv4, normalizeRemote } from "./net";

const AUTH_TIMEOUT_MS = 3000;
const MAX_CLIENTS = 8;
const HEARTBEAT_MS = 20_000;

export interface PhoneSocketDeps {
  host: string; // "ip:port"
  token: string;
  limiter: FailureLimiter;
  store: Store;
}

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachPhoneSocket(server: http.Server, deps: PhoneSocketDeps): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const clients = new Set<WebSocket>();
  const alive = new WeakMap<WebSocket, boolean>();

  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const ip = normalizeRemote(req.socket.remoteAddress);
    if (!isPrivateIPv4(ip)) return reject(socket, "403 Forbidden");
    if (req.headers.host !== deps.host || req.headers.origin !== `http://${deps.host}`) return reject(socket, "403 Forbidden");
    if (req.url !== "/ws") return reject(socket, "404 Not Found");
    if (deps.limiter.isLocked(ip)) return reject(socket, "429 Too Many Requests");
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  });

  function send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function onConnection(ws: WebSocket, ip: string): void {
    let authed = false;
    const timer = setTimeout(() => ws.close(4001, "auth timeout"), AUTH_TIMEOUT_MS);
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    ws.on("message", (raw) => {
      if (authed) return; // nothing else is accepted from the phone over the socket
      let msg: { type?: unknown; token?: unknown } | null = null;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        // fall through
      }
      if (msg?.type === "auth" && typeof msg.token === "string" && safeEqual(msg.token, deps.token)) {
        clearTimeout(timer);
        if (clients.size >= MAX_CLIENTS) return ws.close(4029, "too many clients");
        authed = true;
        deps.limiter.succeed(ip);
        clients.add(ws);
        send(ws, { type: "state", state: deps.store.state });
      } else {
        clearTimeout(timer);
        deps.limiter.fail(ip);
        ws.close(4003, "unauthorized");
      }
    });

    ws.on("close", () => {
      clearTimeout(timer);
      clients.delete(ws);
    });
    ws.on("error", () => ws.terminate());
  }

  // Coalesce bursts of LCU events (champ select fires many) into one push per tick.
  let pending: PhoneState | null = null;
  const onChange = (state: PhoneState) => {
    const first = pending === null;
    pending = state;
    if (!first) return;
    setTimeout(() => {
      const latest = pending ?? deps.store.state;
      pending = null;
      const msg = JSON.stringify({ type: "state", state: latest } satisfies ServerMessage);
      for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }, 30);
  };
  deps.store.on("change", onChange);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  return {
    close() {
      clearInterval(heartbeat);
      deps.store.off("change", onChange);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
