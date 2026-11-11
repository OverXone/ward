/**
 * LAN HTTP server: the phone UI shell (public, contains no secrets) plus the
 * token-protected /api routes. No CORS headers, no cookies, no generic proxying.
 */

import http from "node:http";
import { ActionError, isActionName, runAction } from "../actions";
import type { Champions } from "../champions";
import type { LcuHttp } from "../lcu/http";
import { log } from "../log";
import type { Store } from "../state/store";
import type { StaticFiles } from "./assets";
import { bearerToken, safeEqual, type FailureLimiter, type Pairing } from "./auth";
import { isPrivateIPv4, normalizeRemote } from "./net";

export interface ServerDeps {
  host: string;
  port: number;
  token: string;
  pairing: Pairing;
  limiter: FailureLimiter;
  champions: Champions;
  store: Store;
  getLcu: () => LcuHttp | null;
  staticFiles: StaticFiles;
}

const MAX_BODY = 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function expectedHost(deps: Pick<ServerDeps, "host" | "port">): string {
  return `${deps.host}:${deps.port}`;
}

function securityHeaders(res: http.ServerResponse, host: string): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "media-src 'self' blob: data:",
      `connect-src 'self' ws://${host}`,
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = String(req.headers["content-type"] ?? "");
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return; // drain and discard; the response closes the connection
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, "body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return;
      if (size === 0) return resolve(undefined);
      if (!type.toLowerCase().startsWith("application/json")) return reject(new HttpError(415, "expected application/json"));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createRequestHandler(deps: ServerDeps) {
  const host = expectedHost(deps);

  async function api(req: http.IncomingMessage, res: http.ServerResponse, path: string, ip: string): Promise<void> {
    if (deps.limiter.isLocked(ip)) return sendError(res, 429, "Too many failed attempts, wait a minute");

    // Pairing: the only unauthenticated API route.
    if (path === "/api/pair") {
      if (req.method !== "POST") return sendError(res, 405, "method not allowed");
      const body = (await readJsonBody(req)) as { code?: unknown } | undefined;
      if (body && typeof body === "object" && deps.pairing.redeem(body.code)) {
        deps.limiter.succeed(ip);
        log.info(`Phone paired with code from ${ip}`);
        return sendJson(res, 200, { token: deps.token });
      }
      deps.limiter.fail(ip);
      return sendError(res, 401, "Wrong or expired code. Press Enter in the connector window for a new one.");
    }

    const token = bearerToken(req.headers.authorization);
    if (!token || !safeEqual(token, deps.token)) {
      deps.limiter.fail(ip);
      return sendError(res, 401, "unauthorized");
    }
    deps.limiter.succeed(ip);

    if (req.method === "GET") {
      if (path === "/api/state") return sendJson(res, 200, deps.store.state);
      if (path === "/api/champions") {
        const list = await deps.champions.list();
        return list ? sendJson(res, 200, list) : sendError(res, 503, "League client not connected");
      }
      const icon = /^\/api\/champions\/(\d{1,7})\/icon$/.exec(path);
      if (icon) {
        const png = await deps.champions.icon(Number(icon[1]));
        if (!png) return sendError(res, 404, "no icon");
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "private, max-age=3600" });
        res.end(png);
        return;
      }
      return sendError(res, 404, "not found");
    }

    if (req.method === "POST") {
      const name = path.slice("/api/".length);
      if (!isActionName(name)) return sendError(res, 404, "not found");
      const body = await readJsonBody(req);
      try {
        await runAction(name, body, { http: deps.getLcu() });
      } catch (e) {
        if (e instanceof ActionError) {
          log.info(`Action ${name} rejected: ${e.message}`);
          return sendError(res, e.status, e.message);
        }
        throw e;
      }
      log.info(`Action ${name} ok`);
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }

    return sendError(res, 405, "method not allowed");
  }

  return async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ip = normalizeRemote(req.socket.remoteAddress);
    if (!isPrivateIPv4(ip)) {
      res.writeHead(403).end();
      return;
    }
    // DNS-rebinding guard: only answer requests addressed to our exact LAN ip:port.
    if (req.headers.host !== host) {
      res.writeHead(421, { "Content-Type": "text/plain" }).end("Misdirected request");
      return;
    }
    securityHeaders(res, host);

    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", `http://${host}`).pathname;
    } catch {
      return sendError(res, 400, "bad url");
    }

    try {
      if (pathname.startsWith("/api/")) return await api(req, res, pathname, ip);

      if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "method not allowed");
      const file = deps.staticFiles.get(pathname === "/" ? "/index.html" : pathname);
      if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Length": file.body.length,
        "Cache-Control": file.immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : file.body);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 413) res.setHeader("Connection", "close");
        return sendError(res, e.status, e.message);
      }
      log.error(`request failed: ${(e as Error).message}`);
      if (!res.headersSent) sendError(res, 500, "internal error");
    }
  };
}

export function createHttpServer(deps: ServerDeps): http.Server {
  const handler = createRequestHandler(deps);
  const server = http.createServer((req, res) => void handler(req, res));
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 40;
  return server;
}
