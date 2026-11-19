// Local test for the Gatekeeper Worker (no deploy, no secrets).
// Run: npm test   (after: npm install && npm run build-assets)
// Uses a DUMMY HMAC secret — never the real agent secret.
//
// Tests:
//  1. Decision engine on all 7 trap varieties (+ boundary cases).
//  2. HMAC sign/verify round-trip (hex + base64 + sha256= forms).
//  3. Groth16 prove + local verify for a VALID task.
//  4. Full handler round-trip (HMAC-signed POST -> signed response).

import assert from "node:assert/strict";
import { decide, REASON } from "../src/decision.js";
import { signBody, verifySignature } from "../src/hmac.js";
import { proveDecision } from "../src/prover.js";
import { VK } from "../src/vk.js";
import worker from "../src/index.js";

// Dummy 32-byte hex secret — for local tests ONLY.
const TEST_SECRET = "00".repeat(32);

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
  proof_tx: "0xa4c1000000000000000000000000000000000000000000000000000000008ff1",
};

function taskWith(input, taskId = "gk_test_1") {
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60000).toISOString(),
    input,
  };
}

const neverSeen = async () => false;
const alwaysSeen = async () => true;

console.log("== 1. decision engine ==");
let d = await decide(BASE_INPUT, neverSeen);
assert.equal(d.decision, "APPROVE");
assert.equal(d.reason_code, REASON.VALID);
console.log("VALID_CONDITION -> APPROVE ok");

d = await decide({ ...BASE_INPUT, proof_vk: "0xaaaa" }, neverSeen);
assert.equal(d.decision, "REJECT");
assert.equal(d.reason_code, REASON.VK);
console.log("VK_SUBSTITUTION -> REJECT ok");

d = await decide({ ...BASE_INPUT, public_balance: "999" }, neverSeen);
assert.equal(d.reason_code, REASON.THRESHOLD);
console.log("THRESHOLD_MISMATCH -> REJECT ok");

d = await decide({ ...BASE_INPUT, public_balance: "1000" }, neverSeen);
assert.equal(d.decision, "APPROVE");
console.log("balance == minimum -> APPROVE ok");

d = await decide(BASE_INPUT, alwaysSeen);
assert.equal(d.reason_code, REASON.REUSED);
console.log("PROOF_REUSED -> REJECT ok");

d = await decide({ ...BASE_INPUT, current_block: 19842202 }, neverSeen);
assert.equal(d.reason_code, REASON.EXPIRED);
console.log("EXPIRED_CONDITION -> REJECT ok");

d = await decide({ ...BASE_INPUT, current_block: 19842201 }, neverSeen);
assert.equal(d.decision, "REJECT");
assert.equal(d.reason_code, REASON.EXPIRED);
console.log("current == expiry -> REJECT ok (boundary PROVEN by circuit probe T7/T8)");

d = await decide({ ...BASE_INPUT, recipient: "0xbbbb" }, neverSeen);
assert.equal(d.reason_code, REASON.RECIPIENT);
console.log("RECIPIENT_MISMATCH -> REJECT ok");

d = await decide({ ...BASE_INPUT, amount: "1001" }, neverSeen);
assert.equal(d.reason_code, REASON.AMOUNT);
console.log("AMOUNT_OVERFLOW -> REJECT ok");

d = await decide({ ...BASE_INPUT, amount: "1000" }, neverSeen);
assert.equal(d.decision, "APPROVE");
console.log("amount == max_transfer -> APPROVE ok");

console.log("== 2. HMAC round-trip ==");
const body = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
const hexSig = await signBody(TEST_SECRET, body);
assert.equal(await verifySignature(TEST_SECRET, body, hexSig), true);
assert.equal(await verifySignature(TEST_SECRET, body, hexSig.toUpperCase()), true);
assert.equal(await verifySignature(TEST_SECRET, body, "sha256=" + hexSig), true);
assert.equal(await verifySignature(TEST_SECRET, body, "00".repeat(32)), false);
assert.equal(await verifySignature(TEST_SECRET, new TextEncoder().encode("tampered"), hexSig), false);
console.log("HMAC sign/verify ok (hex, HEX, sha256=, reject-wrong, reject-tampered)");

console.log("== 3. Groth16 prove + local verify (VALID task) ==");
const t0 = Date.now();
const { proof, publicSignals } = await proveDecision(taskWith(BASE_INPUT), "APPROVE", VK);
console.log(`prove+verify ok in ${Date.now() - t0} ms; publicSignals: ${publicSignals.length} (expect 13)`);
assert.equal(publicSignals.length, 13);
assert.equal(proof.protocol, "groth16");
assert.equal(proof.curve, "bn128");

console.log("== 4. full handler round-trip ==");
const task = taskWith(BASE_INPUT, "gk_test_roundtrip");
const raw = new TextEncoder().encode(JSON.stringify(task));
const sig = await signBody(TEST_SECRET, raw);
const req = new Request("https://sanlav-gatekeeper.workers.dev/", {
  method: "POST",
  headers: { "content-type": "application/json", "x-agent-games-signature": sig },
  body: raw,
});
// Minimal env: no KV binding (in-memory fallback), dummy secret.
const res = await worker.fetch(req, { AGENT_GAMES_HMAC_SECRET: TEST_SECRET });
assert.equal(res.status, 200);
const resBody = await res.json();
assert.equal(resBody.decision, "APPROVE");
assert.equal(resBody.reason_code, REASON.VALID);
assert.equal(resBody.proof_tx, BASE_INPUT.proof_tx);
assert.ok(resBody.proof, "response should carry a proof");
assert.equal(resBody.public_signals.length, 13);
const resSig = res.headers.get("x-agent-games-signature");
assert.ok(resSig, "response should be HMAC-signed");
console.log("handler round-trip ok:", JSON.stringify({ decision: resBody.decision, reason_code: resBody.reason_code, proof: "present" }));

// Bad signature -> 401.
const badReq = new Request("https://sanlav-gatekeeper.workers.dev/", {
  method: "POST",
  headers: { "content-type": "application/json", "x-agent-games-signature": "00".repeat(32) },
  body: raw,
});
const badRes = await worker.fetch(badReq, { AGENT_GAMES_HMAC_SECRET: TEST_SECRET });
assert.equal(badRes.status, 401);
console.log("bad signature -> 401 ok");

// Preflight: signed request -> signed { ok: true, protocolVersion: "v1" }.
const preflight = {
  type: "agent-games.preflight.v1",
  agent_id: "agt_test",
  issued_at: new Date().toISOString(),
  nonce: "abc123",
};
const preRaw = new TextEncoder().encode(JSON.stringify(preflight));
const preSig = await signBody(TEST_SECRET, preRaw);
const preReq = new Request("https://sanlav-gatekeeper.workers.dev/agent", {
  method: "POST",
  headers: { "content-type": "application/json", "x-agent-games-signature": preSig },
  body: preRaw,
});
const preRes = await worker.fetch(preReq, { AGENT_GAMES_HMAC_SECRET: TEST_SECRET });
assert.equal(preRes.status, 200);
const preBody = await preRes.json();
assert.equal(preBody.ok, true);
assert.equal(preBody.protocolVersion, "v1");
assert.ok(preRes.headers.get("x-agent-games-signature"), "preflight response should be signed");
console.log("preflight -> signed { ok: true, protocolVersion: v1 } ok");

// Health check.
const health = await worker.fetch(new Request("https://sanlav-gatekeeper.workers.dev/health"), {});
assert.equal(health.status, 200);
console.log("GET /health -> 200 ok");

console.log("\nALL LOCAL TESTS PASSED");
