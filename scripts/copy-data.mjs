// scripts/copy-data.mjs
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve(process.cwd(), "data");
const dst = resolve(process.cwd(), "dist", "data");

if (!existsSync(src)) {
  console.warn("[copy-data] No data/ folder at", src);
  process.exit(0);
}

mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });

console.log("[copy-data] Copied data -> dist/data");
