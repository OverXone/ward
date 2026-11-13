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
import { Loadout } from "../src/loadout";
import { FailureLimiter, Pairing } from "../src/server/auth";
import { Devices } from "../src/server/devices";
import { createHttpServer, expectedHost } from "../src/server/http";
import { lanCandidates } from "../src/server/net";
import { attachPhoneSocket } from "../src/server/phone-ws";
import { Store } from "../src/state/store";

const lanIp = lanCandidates()[0]?.address;

describe.skipIf(!lanIp)("LAN server", () => {
  const devices = new Devices({ file: null });
  const { key: token } = devices.add("test phone");
  const pairing = new Pairing();
  const store = new Store();
  let server: http.Server;
  let socket: { close(): void };
  let port = 0;
  let host = "";
  let code = "";
  let ticket = "";

  beforeAll(async () => {
    // The Host check needs the port up front, so grab a free one first.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, lanIp, () => r()));
    port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    host = expectedHost({ host: lanIp!, port });

    server = createHttpServer({
      host: lanIp!,
      port,
      devices,
      pairing,
      limiter: new FailureLimiter(10, 60_000),
      champions: new Champions(),
      loadout: new Loadout(),
      store,
      getLcu: () => null,
      staticFiles: new Map([["/index.html", { contentType: "text/html", body: Buffer.from("<h1>ui</h1>"), immutable: false }]]),
    });
    await new Promise<void>((r) => server.listen(port, lanIp, () => r()));
    socket = attachPhoneSocket(server, { host, devices, limiter: new FailureLimiter(), store });
    code = pairing.issue();
    ticket = pairing.issueTicket();
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
    expect((await req("/api/state", { host: "evil.example:1234", headers: auth() })).status).toBe(403);
  });

  it("requires a phone key on API routes", async () => {
    expect((await req("/api/state")).status).toBe(401);
    expect((await req("/api/state", { headers: { Authorization: "Bearer " + "x".repeat(43) } })).status).toBe(401);
    const ok = await req("/api/state", { headers: auth() });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ lcu: "searching", phase: null });
    expect(ok.headers["cache-control"]).toBe("no-store");
  });

  it("is not a proxy: unknown routes 404 even with a valid key", async () => {
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

  const json = { "Content-Type": "application/json" };
  const keyWorks = async (key: string) => (await req("/api/state", { headers: { Authorization: `Bearer ${key}` } })).status === 200;

  it("exchanges a pairing code for a new phone key, once", async () => {
    const res = await req("/api/pair", { method: "POST", headers: json, body: JSON.stringify({ code }) });
    expect(res.status).toBe(200);
    const { token: key } = JSON.parse(res.body) as { token: string };
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).not.toBe(token);
    expect(await keyWorks(key)).toBe(true);
    expect((await req("/api/pair", { method: "POST", headers: json, body: JSON.stringify({ code }) })).status).toBe(401);
  });

  it("exchanges the QR ticket for a phone key, once, replacing the phone's old key", async () => {
    const before = devices.list().length;
    const old = devices.add("same phone").key;
    const body = JSON.stringify({ ticket, previous: old });
    const res = await req("/api/pair", { method: "POST", headers: { ...json, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1" }, body });
    expect(res.status).toBe(200);
    const { token: key } = JSON.parse(res.body) as { token: string };
    expect(await keyWorks(key)).toBe(true);
    expect(await keyWorks(old)).toBe(false);
    expect(devices.list().length).toBe(before + 1);
    expect(devices.list()[0]?.name).toBe("iPhone · Safari");
    const again = await req("/api/pair", { method: "POST", headers: json, body });
    expect(again.status).toBe(401);
    expect(JSON.parse(again.body).error).toMatch(/already used/);
  });

  it("lets a phone unpair itself, and closes its socket when it's removed", async () => {
    const { key, id } = devices.add("temp phone");
    const ws = new WebSocket(`ws://${host}/ws`, { origin: `http://${host}` });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token: key }));
    await new Promise((r) => ws.once("message", r));
    const closed = new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect((await req("/api/forget", { method: "POST", headers: { Authorization: `Bearer ${key}` } })).status).toBe(204);
    expect(await closed).toBe(4003);
    expect(await keyWorks(key)).toBe(false);
    expect(devices.list().some((p) => p.id === id)).toBe(false);
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
