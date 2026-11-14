/**
 * Signs dist/Ward.exe for the self-updater: writes dist/ward-update.json next to it.
 *
 *   node scripts/sign-release.mjs                       key from WARD_UPDATE_KEY (PEM text; used by CI)
 *   node scripts/sign-release.mjs --key <file.pem>      key from a file
 *
 * The signature covers version, SHA-256 and size (same message as signedMessage() in
 * connector/src/update.ts). Before writing, it checks the signature against the public key built
 * into the connector, so a release signed with the wrong key fails here instead of in users' hands.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "dist", "Ward.exe");
const out = path.join(root, "dist", "ward-update.json");

const { values } = parseArgs({ options: { key: { type: "string" } } });
const pem = values.key ? readFileSync(values.key, "utf8") : process.env.WARD_UPDATE_KEY;
if (!pem) throw new Error("No signing key: set WARD_UPDATE_KEY or pass --key <file.pem>.");
const privateKey = createPrivateKey(pem);

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const body = readFileSync(exe);
const sha256 = createHash("sha256").update(body).digest("hex");
const size = body.length;
const message = Buffer.from(`ward-update-v1\n${version}\n${sha256}\n${size}\n`, "utf8");
const signature = sign(null, message, privateKey).toString("base64");

const source = readFileSync(path.join(root, "connector", "src", "update.ts"), "utf8");
const builtIn = /UPDATE_PUBLIC_KEY = "([^"]+)"/.exec(source)?.[1];
if (!builtIn) throw new Error("UPDATE_PUBLIC_KEY not found in connector/src/update.ts");
const publicKey = createPublicKey({ key: Buffer.from(builtIn, "base64"), format: "der", type: "spki" });
if (!verify(null, message, publicKey, Buffer.from(signature, "base64")))
  throw new Error("This key doesn't match UPDATE_PUBLIC_KEY in connector/src/update.ts. Wrong key?");

writeFileSync(out, JSON.stringify({ version, sha256, size, signature }, null, 2) + "\n");
console.log(`Signed Ward ${version} (${(size / 1024 / 1024).toFixed(0)} MB, sha256 ${sha256.slice(0, 12)}...) -> ${path.relative(root, out)}`);
