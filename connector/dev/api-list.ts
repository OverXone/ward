/**
 * Prints part of the League client's own API list (GET /help?format=Full). Read-only.
 *
 *   npm run api-list -- lol-perks received-invitations     endpoints + types whose path/name contains a filter
 *   npm run api-list -- --save                              also save the full list to lcu-help.json (gitignored)
 *
 * Uses the same discovery as the connector. The password is never printed.
 */

import { writeFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { discover } from "../src/lcu/discovery";

const args = process.argv.slice(2);
const save = args.includes("--save");
const dirArg = args.indexOf("--league-dir");
const leagueDir = dirArg >= 0 ? args[dirArg + 1] : undefined;
const filters = args.filter((a, i) => !a.startsWith("--") && !(dirArg >= 0 && i === dirArg + 1)).map((f) => f.toLowerCase());

interface Fn {
  name?: string;
  url?: string;
  http_method?: string;
  method?: string;
  arguments?: { name?: string; type?: unknown; optional?: boolean }[];
  returns?: unknown;
  description?: string;
}
interface TypeDef {
  name?: string;
  fields?: { name?: string; type?: unknown; optional?: boolean }[];
  values?: { name?: string; value?: unknown }[];
}

const typeName = (t: unknown): string => {
  if (!t) return "void";
  if (typeof t === "string") return t;
  const o = t as { type?: string; elementType?: string };
  if (o.type === "vector") return `${o.elementType}[]`;
  if (o.type === "map") return `map<${o.elementType}>`;
  return o.type ?? JSON.stringify(t);
};

async function main(): Promise<void> {
  const found = await discover({ leagueDir });
  const creds = found.credentials;
  if (!creds) throw new Error(`League client not found (${found.notes.join("; ")})`);
  // A dedicated agent for 127.0.0.1 only, like connector/src/lcu/http.ts.
  const agent = new https.Agent({ rejectUnauthorized: false });
  const auth = "Basic " + Buffer.from(`riot:${creds.password}`).toString("base64");
  const body = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      { host: "127.0.0.1", port: creds.port, path: "/help?format=Full", method: "GET", agent, headers: { Authorization: auth, Accept: "application/json" }, timeout: 20_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error(`GET /help answered ${res.statusCode}`))));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
  agent.destroy();

  if (save) {
    const file = path.resolve("lcu-help.json");
    writeFileSync(file, body);
    console.log(`Saved the full API list to ${file}`);
  }
  const help = JSON.parse(body) as { functions?: Fn[]; types?: TypeDef[]; events?: { name?: string }[] };
  const match = (s: string | undefined) => !filters.length || filters.some((f) => (s ?? "").toLowerCase().includes(f));

  const fns = (help.functions ?? []).filter((f) => match(f.url) || match(f.name));
  console.log(`\n=== Endpoints (${fns.length}) ===`);
  for (const f of fns) {
    const method = (f.http_method ?? f.method ?? "?").toUpperCase();
    const params = (f.arguments ?? []).map((a) => `${a.name}${a.optional ? "?" : ""}: ${typeName(a.type)}`).join(", ");
    console.log(`${method.padEnd(6)} ${f.url ?? f.name}  (${params}) -> ${typeName(f.returns)}`);
  }

  // Types named after a matching endpoint's plugin, or matching a filter directly.
  const plugins = new Set(fns.map((f) => (f.url ?? "").split("/")[1]?.replace(/-/g, "").toLowerCase()).filter(Boolean));
  const types = (help.types ?? []).filter((t) => match(t.name) || [...plugins].some((p) => (t.name ?? "").toLowerCase().startsWith(p!)));
  console.log(`\n=== Types (${types.length}) ===`);
  for (const t of types) {
    if (t.values?.length) {
      console.log(`${t.name} = ${t.values.map((v) => v.name).join(" | ")}`);
      continue;
    }
    console.log(`${t.name} {`);
    for (const fld of t.fields ?? []) console.log(`  ${fld.name}${fld.optional ? "?" : ""}: ${typeName(fld.type)}`);
    console.log("}");
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
