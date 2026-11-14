import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectToInstance, ControlServer, instanceFile, readInstance, type Viewer } from "../src/instance";

let dir = "";
let control: ControlServer | null = null;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ward-instance-"));
});
afterEach(() => {
  control?.close();
  control = null;
  rmSync(dir, { recursive: true, force: true });
});

/** Collects the JSON lines a socket receives. */
function received(socket: net.Socket): Array<Record<string, unknown>> {
  const got: Array<Record<string, unknown>> = [];
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      got.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  return got;
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("ControlServer", () => {
  it("writes instance.json and removes it on close", async () => {
    control = await ControlServer.start(dir);
    const info = readInstance(dir);
    expect(info?.pid).toBe(process.pid);
    expect(info?.pipe).toMatch(/^\\\\\.\\pipe\\ward-[0-9a-f]{32}$/);
    control.close();
    control = null;
    expect(readInstance(dir)).toBeNull();
  });

  it("connects a window with the secret, both ways", async () => {
    control = await ControlServer.start(dir);
    const viewers: Viewer[] = [];
    control.on("viewer", (v) => viewers.push(v));
    const socket = await connectToInstance(dir);
    expect(socket).not.toBeNull();
    const got = received(socket!);
    await until(() => viewers.length === 1);
    expect(viewers[0]!.pid).toBe(process.pid);

    control.broadcast("hello window");
    viewers[0]!.hide();
    await until(() => got.length === 2);
    expect(got).toEqual([{ t: "out", text: "hello window" }, { t: "hide" }]);

    const lines: string[] = [];
    viewers[0]!.on("line", (l) => lines.push(l));
    socket!.write(JSON.stringify({ t: "line", line: "phones" }) + "\n");
    await until(() => lines.length === 1);
    expect(lines).toEqual(["phones"]);

    let closed = false;
    viewers[0]!.on("close", () => (closed = true));
    socket!.destroy();
    await until(() => closed);
    expect(control.viewers.size).toBe(0);
  });

  it("sends nothing to a client without the secret, and drops it", async () => {
    control = await ControlServer.start(dir);
    let viewers = 0;
    control.on("viewer", () => viewers++);
    const info = readInstance(dir)!;
    const socket = net.connect(info.pipe);
    const got = received(socket);
    let closed = false;
    socket.on("close", () => (closed = true));
    socket.on("error", () => {});
    socket.write(JSON.stringify({ t: "hello", token: "0".repeat(64) }) + "\n");
    await until(() => closed);
    control.broadcast("secret QR code");
    expect(got).toEqual([]);
    expect(viewers).toBe(0);
  });

  it("finds no running Ward when instance.json is missing, stale or tampered with", async () => {
    expect(await connectToInstance(dir)).toBeNull();
    writeFileSync(instanceFile(dir), JSON.stringify({ pid: 1, pipe: "\\\\.\\pipe\\ward-gone", token: "x" }));
    expect(await connectToInstance(dir, 500)).toBeNull();
    writeFileSync(instanceFile(dir), JSON.stringify({ pid: 1, pipe: "\\\\evil-host\\pipe\\x", token: "x" }));
    expect(readInstance(dir)).toBeNull();
  });
});
