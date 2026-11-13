/** Test helpers: a fake League client that records calls, and an ActionError matcher. */

import { expect } from "vitest";
import { ActionError } from "../src/actions";
import type { HttpMethod, LcuHttp, LcuResponse } from "../src/lcu/http";

export type Route = (body: unknown) => { status: number; json?: unknown };

/** Fake LCU: records every call and answers from a route table keyed by "METHOD path". */
export function fakeLcu(routes: Record<string, Route>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const request = async (method: HttpMethod, path: string, body?: unknown): Promise<LcuResponse> => {
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    const r = route ? route(body) : { status: 404, json: { message: "Invalid URI format" } };
    return { status: r.status, contentType: "application/json", body: Buffer.from(r.json === undefined ? "" : JSON.stringify(r.json)) };
  };
  const http = {
    request,
    async json(method: HttpMethod, path: string, body?: unknown) {
      const res = await request(method, path, body);
      return { status: res.status, data: res.body.length ? JSON.parse(res.body.toString()) : undefined };
    },
    async getOrNull(path: string) {
      const res = await request("GET", path);
      return res.status === 200 && res.body.length ? JSON.parse(res.body.toString()) : null;
    },
  } as unknown as LcuHttp;
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { http, calls, writes };
}

export const ok = (json?: unknown): Route => () => ({ status: json === undefined ? 204 : 200, json });

export async function expectError(p: Promise<unknown>, status: number, msg?: RegExp) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(ActionError);
  expect((err as ActionError).status).toBe(status);
  if (msg) expect((err as ActionError).message).toMatch(msg);
}

