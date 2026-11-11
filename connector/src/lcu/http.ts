/**
 * HTTPS client for the local League Client API.
 *
 * The LCU serves a self-signed certificate on 127.0.0.1. Certificate
 * verification is disabled ONLY on the dedicated agent below, which is used
 * for nothing but requests to 127.0.0.1. NODE_TLS_REJECT_UNAUTHORIZED is never
 * touched, so every other TLS connection in the process keeps full verification.
 */

import https from "node:https";
import type { LcuCredentials } from "./discovery";

export const LCU_HOST = "127.0.0.1";

export interface LcuResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// Paths are built by our own code from constants + validated integers; this is defence in depth.
const SAFE_PATH = /^\/[A-Za-z0-9\-_/.]*$/;

export class LcuHttp {
  private readonly agent: https.Agent;
  private readonly authHeader: string;

  constructor(readonly credentials: LcuCredentials) {
    this.agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 6 });
    this.authHeader = "Basic " + Buffer.from(`riot:${credentials.password}`).toString("base64");
  }

  get port(): number {
    return this.credentials.port;
  }

  request(method: HttpMethod, path: string, jsonBody?: unknown, timeoutMs = 5000): Promise<LcuResponse> {
    if (!SAFE_PATH.test(path) || path.includes("..")) {
      return Promise.reject(new Error("refusing unsafe LCU path"));
    }
    const payload = jsonBody === undefined ? undefined : Buffer.from(JSON.stringify(jsonBody));
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: LCU_HOST,
          port: this.credentials.port,
          path,
          method,
          agent: this.agent,
          headers: {
            Authorization: this.authHeader,
            Accept: "application/json",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 8 * 1024 * 1024) {
              req.destroy(new Error("LCU response too large"));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers["content-type"] ?? ""),
              body: Buffer.concat(chunks),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`LCU ${method} ${path} timed out`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Request and parse JSON. `data` is undefined when the body is empty or not JSON. */
  async json<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<{ status: number; data: T | undefined }> {
    const res = await this.request(method, path, body);
    let data: T | undefined;
    if (res.body.length) {
      try {
        data = JSON.parse(res.body.toString("utf8")) as T;
      } catch {
        data = undefined;
      }
    }
    return { status: res.status, data };
  }

  /** GET that returns parsed JSON on 2xx and null otherwise (including network errors). */
  async getOrNull<T = unknown>(path: string): Promise<T | null> {
    try {
      const { status, data } = await this.json<T>("GET", path);
      return status >= 200 && status < 300 && data !== undefined ? data : null;
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.agent.destroy();
  }
}

/** Extracts the LCU's error message (`{ message }`) for display, trimmed and length-limited. */
export function lcuErrorMessage(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim().slice(0, 200);
    }
  } catch {
    // ignore
  }
  return null;
}
