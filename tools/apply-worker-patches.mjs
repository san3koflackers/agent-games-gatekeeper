// Re-applies the Cloudflare Workers patches in ../patches/ to
// node_modules/ffjavascript after `npm install` (node_modules is not
// committed, so the patches would otherwise be lost).
//
// Why: Cloudflare Workers bans WebAssembly.compile() at runtime, and
// snarkjs/ffjavascript calls it in two places — the circom witness
// calculator and the BN128 curve-engine builder. The patches make both
// accept a pre-compiled WebAssembly.Module (statically imported wasm, compiled
// at deploy time). See ../patches/README.md for the full story and the
// workerd verification numbers.
//
// Idempotent: `patch --forward` skips hunks that are already applied.
// Safe in Node: every patch keeps the old bytes path working when no
// prebuilt Module is injected (verified by `npm test`).
//
// Usage: node tools/apply-worker-patches.mjs   (also runs as postinstall)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const patchesDir = join(root, "patches");
const targetDir = join(root, "node_modules", "ffjavascript");

if (!existsSync(targetDir)) {
  console.log("apply-worker-patches: node_modules/ffjavascript not present, skipping (run npm install first).");
  process.exit(0);
}

const patches = readdirSync(patchesDir)
  .filter((f) => f.endsWith(".patch"))
  .sort();

let applied = 0;
for (const patch of patches) {
  const patchPath = join(patchesDir, patch);
  try {
    execFileSync("patch", ["-p1", "--forward", "-d", targetDir, "-i", patchPath, "--silent"], {
      stdio: "pipe",
    });
    console.log(`apply-worker-patches: applied ${patch}`);
    applied++;
  } catch (e) {
    const out = String(e.stdout || "") + String(e.stderr || "");
    if (/previously applied|Reversed \(or previously applied\) patch detected/i.test(out)) {
      console.log(`apply-worker-patches: already applied ${patch}`);
    } else {
      console.error(`apply-worker-patches: FAILED ${patch}\n${out}`);
      process.exit(1);
    }
  }
}
console.log(`apply-worker-patches: done (${applied} newly applied, ${patches.length} total).`);
