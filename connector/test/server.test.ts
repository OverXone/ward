/**
 * Integration test of the LAN server's security checks. Binds to this machine's
 * real LAN address (127.0.0.1 is rejected by design), so it's skipped on
 * machines without one.
 */

import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Champions } from "../src/champions";
import { FailureLimiter, generateToken, Pairing } from "../src/server/auth";
import { createHttpServer, expectedHost } from "../src/server/http";
import { lanCandidates } from "../src/server/net";
import { attachPhoneSocket } from "../src/server/phone-ws";
import { Store } from "../src/state/store";

const lanIp = lanCandidates()[0]?.address;

describe.skipIf(!lanIp)("LAN server", () => {
  const token = generateToken();
  const pairing = new Pairing();
  const store = new Store();
  let server: http.Server;
  let socket: { close(): void };
  let port = 0;
  let host = "";
  let code = "";

  beforeAll(async () => {
    server = createHttpServer({
      host: lanIp!,
      port: 0, // replaced below once bound
      token,
      pairing,
      limiter: new FailureLimiter(10, 60_000),
      champions: new Champions(),
      store,
      getLcu: () => null,
      staticFiles: new Map([["/index.html", { contentType: "text/html", body: Buffer.from("<h1>ui</h1>"), immutable: false }]]),
    });
    await new Promise<void>((r) => server.listen(0, lanIp, () => r()));
    port = (server.address() as AddressInfo).port;
    host = expectedHost({ host: lanIp!, port });
    // Rebuild handler deps with the real port (the Host check needs it).
    server.removeAllListeners("request");
    const real = createHttpServer({
      host: lanIp!,
      port,
      token,
      pairing,
      limiter: new FailureLimiter(10, 60_000),
      champions: new Champions(),
      store,
      getLcu: () => null,
      staticFiles: new Map([["/index.html", { contentType: "text/html", body: Buffer.from("<h1>ui</h1>"), immutable: false }]]),
    });
    for (const l of real.listeners("request")) server.on("request", l as never);
    socket = attachPhoneSocket(server, { host, token, limiter: new FailureLimiter(), store });
    code = pairing.issue();
  });

  afterAll(() => {
    socket.close();
    server.close();
  });

  function req(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const r = http.request(
        { host: lanIp, port, path, method: opts.method ?? "GET", headers: { Host: opts.host ?? host, ...opts.headers } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        },
      );
      r.on("error", reject);
      if (opts.body) r.write(opts.body);
      r.end();
    });
  }

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it("serves the UI shell without auth, with security headers", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    expect((await req("/api/state", { host: "evil.example:1234", headers: auth() })).status).toBe(421);
  });

  it("requires the token on API routes", async () => {
    expect((await req("/api/state")).status).toBe(401);
    expect((await req("/api/state", { headers: { Authorization: "Bearer " + "x".repeat(43) } })).status).toBe(401);
    const ok = await req("/api/state", { headers: auth() });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ lcu: "searching", phase: null });
    expect(ok.headers["cache-control"]).toBe("no-store");
  });

  it("is not a proxy: unknown routes 404 even with a valid token", async () => {
    for (const p of ["/api/lol-gameflow/v1/gameflow-phase", "/api/../lol-summoner/v1/current-summoner", "/lol-champ-select/v1/session"]) {
      const res = await req(p, { method: "POST", headers: auth() });
      expect([404, 405]).toContain(res.status);
    }
  });

  it("validates action bodies", async () => {
    const headers = { ...auth(), "Content-Type": "application/json" };
    expect((await req("/api/champ-select/hover", { method: "POST", headers, body: '{"championId":"1"}' })).status).toBe(400);
    expect((await req("/api/champ-select/hover", { method: "POST", headers, body: "{nope" })).status).toBe(400);
    expect((await req("/api/champ-select/hover", { method: "POST", headers: auth(), body: '{"championId":1}' })).status).toBe(415);
    expect((await req("/api/champ-select/hover", { method: "POST", headers, body: JSON.stringify({ championId: 1, pad: "x".repeat(2000) }) })).status).toBe(413);
    // valid body, but no client connected
    expect((await req("/api/champ-select/hover", { method: "POST", headers, body: '{"championId":1}' })).status).toBe(503);
  });

  it("exchanges a pairing code for the token, once", async () => {
    const headers = { "Content-Type": "application/json" };
    const res = await req("/api/pair", { method: "POST", headers, body: JSON.stringify({ code }) });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ token });
    expect((await req("/api/pair", { method: "POST", headers, body: JSON.stringify({ code }) })).status).toBe(401);
  });

  it("websocket: rejects a foreign Origin", async () => {
    const ws = new WebSocket(`ws://${host}/ws`, { origin: "http://evil.example" });
    const err = await new Promise<Error>((r) => ws.on("error", r));
    expect(err.message).toMatch(/403/);
  });

  it("websocket: closes with 4003 on a bad token", async () => {
    const ws = new WebSocket(`ws://${host}/ws`, { origin: `http://${host}` });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token: "wrong" }));
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(4003);
  });

  it("websocket: sends state after a valid auth frame", async () => {
    const ws = new WebSocket(`ws://${host}/ws`, { origin: `http://${host}` });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token }));
    const msg = await new Promise<string>((r) => ws.once("message", (d) => r(d.toString())));
    expect(JSON.parse(msg)).toMatchObject({ type: "state", state: { lcu: "searching" } });
    ws.close();
  });

  it("locks out an IP after repeated bad tokens", async () => {
    for (let i = 0; i < 10; i++) await req("/api/state", { headers: { Authorization: "Bearer " + "y".repeat(43) } });
    expect((await req("/api/state", { headers: auth() })).status).toBe(429);
  });
});
