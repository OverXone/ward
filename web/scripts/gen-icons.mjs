// Writes the phone icons (the Ward logo, see scripts/logo.mjs) into web/public.
// Usage: npm run icons -w web
import { copyFileSync, writeFileSync } from "node:fs";
import { png, renderLogo } from "../../scripts/logo.mjs";

const dir = new URL("../public/", import.meta.url);
for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  writeFileSync(new URL(name, dir), png(size, renderLogo(size)));
  console.log("wrote", name);
}
copyFileSync(new URL("../../branding/ward.svg", import.meta.url), new URL("icon.svg", dir));
console.log("wrote icon.svg");
