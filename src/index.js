// SanLav — Proof Gatekeeper agent (zkVerify Agent Games).
// Cloudflare Worker. See README.md + ../docs/protocol-spec.md.
//
// Flow per task: HMAC-verify (raw body) -> idempotency (task_id) ->
// decision engine (7 traps) -> record proof_tx in seen-set ->
// Groth16 prove (snarkjs, local) -> signed JSON response, all < 60 s.
// Fail closed: any uncertainty -> REJECT. A late/missing proof still
// returns the decision (correct decision without proof = +10; timeout = -2).

import "./polyfill.js"; // FIRST: stubs URL.createObjectURL before snarkjs loads
import { decide, REASON } from "./decision.js";
import { signBody, verifySignatureMulti } from "./hmac.js";
import { proveDecision } from "./prover.js";
import { VK } from "./vk.js";

const TASK_TYPE = "agent-games.proof-gatekeeper.v1";
const PREFLIGHT_TYPE = "agent-games.preflight.v1";
const PROVE_TIMEOUT_MS = 40_000; // leave headroom inside the 60 s deadline
const IDEMPOTENCY_TTL_S = 7 * 24 * 3600; // 7 days

// In-memory fallback if the SEEN KV binding is missing (per-isolate only;
// the KV binding is required for correct cross-round reuse detection).
const memSeen = new Set();
const memTasks = new Map();

async function isSeen(env, mode, proofTx) {
  const key = `seen:${mode}:${proofTx}`;
  if (env.SEEN) return (await env.SEEN.get(key)) !== null;
  return memSeen.has(key);
}

async function markSeen(env, mode, proofTx, taskId) {
  const key = `seen:${mode}:${proofTx}`;
  if (env.SEEN) {
    await env.SEEN.put(key, taskId);
  } else {
    memSeen.add(key);
  }
}

async function getCachedResponse(env, mode, taskId) {
  const key = `task:${mode}:${taskId}`;
  if (env.SEEN) {
    const v = await env.SEEN.get(key);
    return v ? JSON.parse(v) : null;
  }
  return memTasks.get(key) ?? null;
}

async function cacheResponse(env, mode, taskId, body) {
  const key = `task:${mode}:${taskId}`;
  if (env.SEEN) {
    await env.SEEN.put(key, JSON.stringify(body), { expirationTtl: IDEMPOTENCY_TTL_S });
  } else {
    memTasks.set(key, body);
  }
}

function jsonResponse(env, status, body, sign, keyForm = "hex") {
  return (async () => {
    const raw = new TextEncoder().encode(JSON.stringify(body));
    const headers = { "content-type": "application/json" };
    if (sign && env.AGENT_GAMES_HMAC_SECRET) {
      headers["x-agent-games-signature"] = await signBody(env.AGENT_GAMES_HMAC_SECRET, raw, keyForm);
    }
    return new Response(raw, { status, headers });
  })();
}

function log(obj) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }));
}

// ---------------------------------------------------------------------------
// Response shape (H1 — pending confirmation from the /build starter prompts
// and practice mode; see protocol-spec §2.1 OQ1).
// Confirmed fields: decision, reason_code, proof_tx (echo of task proof_tx).
// Proof fields (best current hypothesis, mirroring the Steal the VFY text on
// the same Build page: "circuitVersion plus the Groth16 proof and
// public_signals"): proof + public_signals. circuitVersion is OMITTED until
// its expected value is confirmed — a wrong value could break acceptance.
// If practice shows the platform wants different field names, change ONLY
// this function.
// ---------------------------------------------------------------------------
function buildResponseBody(task, decision, proofResult) {
  const body = {
    decision: decision.decision,
    reason_code: decision.reason_code,
    proof_tx: task.input.proof_tx,
  };
  if (proofResult) {
    body.proof = proofResult.proof;
    body.public_signals = proofResult.publicSignals;
  }
  return body;
}

async function handleTask(env, rawBytes, task, keyForm = "hex") {
  const started = Date.now();
  const mode = task.mode || "competition";
  const taskId = task.task_id;

  // Idempotency: same task_id -> same response.
  const cached = await getCachedResponse(env, mode, taskId);
  if (cached) {
    log({ task_id: taskId, mode, event: "duplicate-delivery" });
    return jsonResponse(env, 200, cached, true, keyForm);
  }

  // Timestamp sanity (log only — the platform enforces the 60 s deadline;
  // a late answer is harmless, a refused answer forfeits the task).
  if (task.deadline_at) {
    const dl = Date.parse(task.deadline_at);
    if (!Number.isNaN(dl) && Date.now() > dl) {
      log({ task_id: taskId, mode, event: "task-already-expired", deadline_at: task.deadline_at });
    }
  }

  // Decision.
  const decision = await decide(task.input, (proofTx) => isSeen(env, mode, proofTx));

  // Record proof_tx as seen for EVERY task (including rejected ones).
  const proofTx = String(task.input.proof_tx ?? "").trim().toLowerCase();
  if (proofTx) await markSeen(env, mode, proofTx, taskId);

  // Proof — skipped for PROOF_REUSED (no proof to submit; excluded from the
  // reliability bonus). Raced against a timeout: a decision without proof
  // (+10 if correct) beats a timeout (-2).
  let proofResult = null;
  let proveMs = null;
  if (decision.reason_code !== REASON.REUSED) {
    const proveStarted = Date.now();
    try {
      proofResult = await Promise.race([
        proveDecision(task, decision.decision, VK),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("prove-timeout")), PROVE_TIMEOUT_MS),
        ),
      ]);
      proveMs = Date.now() - proveStarted;
    } catch (e) {
      log({ task_id: taskId, mode, event: "prove-failed", error: String(e?.message || e) });
    }
  }

  const body = buildResponseBody(task, decision, proofResult);
  await cacheResponse(env, mode, taskId, body);
  log({
    task_id: taskId,
    mode,
    decision: decision.decision,
    reason_code: decision.reason_code,
    traps: decision.traps,
    proof: proofResult ? "ok" : "none",
    prove_ms: proveMs,
    total_ms: Date.now() - started,
  });
  return jsonResponse(env, 200, body, true, keyForm);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Liveness: any GET/HEAD answers 200 (the platform's exact health-check
    // path is unpublished — OQ4; answer everywhere cheaply).
    if (request.method === "GET" || request.method === "HEAD") {
      return new Response(
        JSON.stringify({ status: "ok", agent: "SanLav", track: "proof-gatekeeper" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    // Raw body bytes (HMAC is computed over the exact bytes, before parsing).
    const rawBytes = new Uint8Array(await request.arrayBuffer());

    let task;
    try {
      task = JSON.parse(new TextDecoder().decode(rawBytes));
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    // Unknown POST payloads (health probes with a body, etc.) get a plain 200.
    if (!task || (task.type !== TASK_TYPE && task.type !== PREFLIGHT_TYPE)) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // HMAC verification — before any processing (preflight and tasks alike).
    if (!env.AGENT_GAMES_HMAC_SECRET) {
      log({ event: "misconfigured-no-hmac-secret", task_id: task.task_id });
      return new Response("agent misconfigured", { status: 500 });
    }
    // Signature header: primary name + plausible alternates (the platform
    // never publishes the exact header name — OQ2).
    const SIG_HEADERS = [
      "x-agent-games-signature",
      "x-zkverify-signature",
      "x-agent-signature",
      "x-signature",
    ];
    let sig = null;
    let sigHeader = null;
    for (const name of SIG_HEADERS) {
      const v = request.headers.get(name);
      if (v) { sig = v; sigHeader = name; break; }
    }
    // Key form unknown (hex-decoded vs UTF-8 string) — try both.
    const keyForm = await verifySignatureMulti(env.AGENT_GAMES_HMAC_SECRET, rawBytes, sig);
    if (!keyForm) {
      const headerNames = [...request.headers.keys()];
      log({
        event: "hmac-verify-failed",
        task_id: task.task_id,
        type: task.type,
        headerNames,
        sigHeader,
        sigLen: sig ? sig.length : 0,
        sigValue: sig || null,
        bodyPreview: new TextDecoder().decode(rawBytes).slice(0, 500),
      });
      return new Response("bad signature", { status: 401 });
    }
    if (task.type === PREFLIGHT_TYPE) {
      log({ event: "preflight-keyform", keyForm, sigHeader });
    }

    // Signed preflight: after registration / secret rotation the platform
    // sends this to verify the endpoint is live and signatures verify. No
    // task is sent until it passes. Response (verbatim from /build):
    // { ok: true, protocolVersion: "v1" }, HMAC-signed.
    if (task.type === PREFLIGHT_TYPE) {
      log({ event: "preflight", agent_id: task.agent_id, nonce: task.nonce });
      return jsonResponse(env, 200, { ok: true, protocolVersion: "v1" }, true, keyForm);
    }

    try {
      return await handleTask(env, rawBytes, task, keyForm);
    } catch (e) {
      // Last-resort fail-closed: a REJECT answer with the most frequent
      // REJECT trap as the reason code (a lottery fallback — the decision
      // engine itself is pure comparisons and should never throw).
      log({ event: "task-handler-error", task_id: task.task_id, error: String(e?.message || e) });
      const body = {
        decision: "REJECT",
        reason_code: REASON.VK,
        proof_tx: task.input?.proof_tx ?? "",
      };
      return jsonResponse(env, 200, body, true, keyForm);
    }
  },
};
