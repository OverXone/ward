/**
 * Keeps a connection to the League client alive across client start/close/restart.
 *
 * searching  → poll discovery every POLL_MS
 * connecting → credentials found, opening the websocket
 * connected  → emits "connected" with an LcuHttp; on socket close emits "disconnected"
 *              and goes back to searching (port + password change on every client launch).
 */

import { EventEmitter } from "node:events";
import { addSecret, log, removeSecret } from "../log";
import type { LcuStatus } from "../shared/phone-api";
import { discover, type DiscoveryOptions, type DiscoveryResult, type LcuCredentials } from "./discovery";
import { LcuHttp } from "./http";
import { LcuSocket, type LcuEvent } from "./socket";

const POLL_MS = 2000;

export declare interface LcuManager {
  on(event: "status", listener: (s: LcuStatus) => void): this;
  on(event: "connected", listener: (http: LcuHttp, creds: LcuCredentials) => void): this;
  on(event: "disconnected", listener: () => void): this;
  on(event: "event", listener: (e: LcuEvent) => void): this;
  on(event: "discovery", listener: (r: DiscoveryResult) => void): this;
}

export class LcuManager extends EventEmitter {
  status: LcuStatus = "searching";
  http: LcuHttp | null = null;
  private stopped = false;
  private socket: LcuSocket | null = null;
  private lastNotes = "";

  constructor(private readonly opts: DiscoveryOptions = {}) {
    super();
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.http?.destroy();
  }

  private setStatus(s: LcuStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.emit("status", s);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const result = await discover(this.opts).catch(
        (e: Error): DiscoveryResult => ({ credentials: null, notes: [`discovery error: ${e.message}`] }),
      );
      // Only report discovery notes when they change, to keep the console quiet while polling.
      const notes = result.notes.join("; ");
      if (notes !== this.lastNotes || result.credentials) {
        this.lastNotes = notes;
        this.emit("discovery", result);
      }

      if (result.credentials && !this.stopped) {
        await this.runSession(result.credentials);
        this.lastNotes = "";
      }
      if (!this.stopped) await sleep(POLL_MS);
    }
  }

  /** Connects and resolves when the session ends (socket closed or failed to open). */
  private async runSession(creds: LcuCredentials): Promise<void> {
    addSecret(creds.password);
    this.setStatus("connecting");
    const socket = new LcuSocket();
    this.socket = socket;
    try {
      await socket.connect(creds);
    } catch (e) {
      log.warn(`LCU websocket not ready on port ${creds.port}: ${(e as Error).message}`);
      this.socket = null;
      this.setStatus("searching");
      removeSecret(creds.password);
      return;
    }

    const http = new LcuHttp(creds);
    this.http = http;
    socket.on("event", (e) => this.emit("event", e));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    this.setStatus("connected");
    this.emit("connected", http, creds);

    await closed;

    this.socket = null;
    this.http = null;
    http.destroy();
    removeSecret(creds.password);
    this.setStatus("searching");
    this.emit("disconnected");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
