/**
 * LCU websocket (WAMP 1.0 flavoured).
 *
 * Subscribe: [5, "OnJsonApiEvent"]
 * Event:     [8, "OnJsonApiEvent", { uri, eventType, data }]
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { LcuCredentials } from "./discovery";
import { LCU_HOST } from "./http";

export interface LcuEvent {
  uri: string;
  eventType: "Create" | "Update" | "Delete" | string;
  data: unknown;
}

const OP_SUBSCRIBE = 5;
const OP_EVENT = 8;
const TOPIC = "OnJsonApiEvent";

export declare interface LcuSocket {
  on(event: "event", listener: (e: LcuEvent) => void): this;
  on(event: "close", listener: (reason: string) => void): this;
}

export class LcuSocket extends EventEmitter {
  private ws: WebSocket | null = null;

  /** Resolves once the socket is open and subscribed; rejects on failure. */
  connect(creds: LcuCredentials): Promise<void> {
    return new Promise((resolve, reject) => {
      const auth = "Basic " + Buffer.from(`riot:${creds.password}`).toString("base64");
      // rejectUnauthorized:false applies to this one localhost connection only.
      const ws = new WebSocket(`wss://${LCU_HOST}:${creds.port}/`, {
        headers: { Authorization: auth },
        rejectUnauthorized: false,
        handshakeTimeout: 5000,
        perMessageDeflate: false,
        maxPayload: 32 * 1024 * 1024,
      });
      this.ws = ws;
      let opened = false;

      ws.on("open", () => {
        opened = true;
        ws.send(JSON.stringify([OP_SUBSCRIBE, TOPIC]));
        resolve();
      });

      ws.on("message", (raw) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!Array.isArray(msg) || msg[0] !== OP_EVENT || msg[1] !== TOPIC) return;
        const payload = msg[2] as Partial<LcuEvent> | undefined;
        if (!payload || typeof payload.uri !== "string") return;
        this.emit("event", { uri: payload.uri, eventType: String(payload.eventType ?? ""), data: payload.data });
      });

      ws.on("error", (err) => {
        if (!opened) reject(err);
      });

      ws.on("close", (code) => {
        this.ws = null;
        if (!opened) reject(new Error(`LCU socket closed during handshake (${code})`));
        else this.emit("close", `code ${code}`);
      });
    });
  }

  close(): void {
    this.ws?.terminate();
    this.ws = null;
  }
}
