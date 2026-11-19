// Live smoke test against the DEPLOYED Worker. Uses the REAL HMAC secret
// (read from ~/.agent-games/hmac-secret, never printed) and verifies:
//   1. GET /health -> 200
//   2. signed preflight -> {ok:true, protocolVersion:"v1"} + valid signature
//   3. signed VALID_CONDITION task (mode:practice) -> APPROVE + Groth16 proof,
//      response signature valid, proof verifies locally against the VK.
// Run: node test/live-test.mjs

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { signBody, verifySignature } from "../src/hmac.js";
import { VK } from "../src/vk.js";
import * as snarkjs from "snarkjs";

const BASE = "https://sanlav-gatekeeper.sankoflack4.workers.dev";
const SECRET = readFileSync(join(homedir(), ".agent-games/hmac-secret"), "utf8").trim();
const timeout = (ms) => AbortSignal.timeout(ms);

const BASE_INPUT = {
  registered_vk: "0x7d3a00000000000000000000000000000000000000000000000000000000f291",
  proof_vk: "0x7d3a00000000000000000000000000000000000000000000000000000000f291",
  minimum: "1000",
  public_balance: "1460",
  expiry_block: 19842201,
  current_block: 19832000,
  recipient: "0xDe4200000000000000000000000000000000009f01",
  condition_recipient: "0xDe4200000000000000000000000000000000009f01",
  amount: "500",
  max_transfer: "1000",
  proof_tx: "0xLIVE0000000000000000000000000000000000000000000000000000000beef".replace("LIVE", "11e0"),
};

async function signedPost(path, obj) {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const sig = await signBody(SECRET, body);
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-games-signature": sig },
    body,
    signal: timeout(60000),
  });
  const raw = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(raw);
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw text */ }
  const respSig = res.headers.get("x-agent-games-signature");
  const sigOk = respSig ? await verifySignature(SECRET, raw, respSig) : false;
  return { status: res.status, json, text, sigOk };
}

// 1. health
const health = await fetch(BASE + "/health", { signal: timeout(30000) });
console.log("1. GET /health ->", health.status, (await health.text()).slice(0, 120));

// 2. preflight
const pf = await signedPost("/agent", {
  type: "agent-games.preflight.v1",
  agent_id: "sanlav",
  issued_at: new Date().toISOString(),
  nonce: "live-probe-1",
});
console.log("2. preflight ->", pf.status, JSON.stringify(pf.json), "resp-sig-valid:", pf.sigOk);

// 3. full VALID task (practice mode: keeps the competition seen-set clean)
const t0 = Date.now();
const task = await signedPost("/agent", {
  type: "agent-games.proof-gatekeeper.v1",
  task_id: "live_probe_1",
  mode: "practice",
  issued_at: new Date().toISOString(),
  deadline_at: new Date(Date.now() + 60000).toISOString(),
  input: BASE_INPUT,
});
console.log("3. task ->", task.status, "in", Date.now() - t0, "ms",
  "| decision:", task.json?.decision, "| reason:", task.json?.reason_code,
  "| proof:", !!task.json?.proof, "| signals:", task.json?.public_signals?.length,
  "| resp-sig-valid:", task.sigOk);
if (task.json?.proof && task.json?.public_signals) {
  const ok = await snarkjs.groth16.verify(VK, task.json.public_signals, task.json.proof);
  console.log("   Groth16 proof verifies locally:", ok);
} else {
  console.log("   response body:", task.text.slice(0, 500));
}
