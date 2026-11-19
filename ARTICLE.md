# Building SanLav: A Deterministic Proof Gatekeeper That Proves Every Decision It Makes

*An engineering deep-dive on our entry for the Proof Gatekeeper track of zkVerify Agent Games Season 01 — a Cloudflare Worker that verifies ZK-proof-backed payment requests, decides approve or reject in under 60 seconds, and attaches a Groth16 proof of its reasoning to every answer.*

## The game: judge the proof, prove the judgement

In the Proof Gatekeeper track of [zkVerify Agent Games](https://agentgames.zkverify.io/events/proof-gatekeeper), your agent is a **gatekeeper**: the platform delivers payment requests backed by zero-knowledge proofs, and your agent must decide — **APPROVE** or **REJECT** — and back that decision with a Groth16 proof of its own.

The format is unforgiving:

- **8 rounds × 8 tasks**, one round per day (13–20 Nov 2026), 10-hour window per round, cumulative scores.
- **60 seconds** per task; late means a timeout (−2).
- A correct decision scores **+12**. A wrong APPROVE costs **−6**; a wrong REJECT costs **−3**. Approving a trap is more expensive than being cautious — the build guide says it plainly: *"Reject on timeout or uncertainty."*
- Every provable task answered **without a valid Groth16 proof** costs an extra **−2**, and a per-round **reliability bonus of +0 to +5** is pro-rated by the fraction of provable tasks whose proof verified. The proof is worth up to 40 points over the event.

Our agent is **SanLav**: a Cloudflare Worker that verifies HMAC-signed tasks, runs a deterministic seven-way trap check, generates a Groth16 proof of its decision locally with snarkjs, and returns a signed response — all inside the 60-second window. Along the way we reverse-engineered the gatekeeper circuit from its compiled artifacts alone: the circuit source was never published.

## Architecture: a Worker, a seen-set, and a prover

The whole agent is a single Cloudflare Worker (`sanlav-gatekeeper`), chosen for one reason above all: **it never sleeps**. The rules warn explicitly that free-tier hosting that idles out will cost you tasks.

The request pipeline is a strict sequence — every stage must pass before the next begins:

```
POST /  ──► HMAC-verify (raw body, before parsing)
        ──► Idempotency check (task_id)
        ──► Decision engine (7 trap checks)
        ──► Record proof_tx in the seen-set
        ──► Groth16 prove (snarkjs, local; skipped for PROOF_REUSED)
        ──► HMAC-signed JSON response (< 60 s)
```

**HMAC first, parsing second.** The platform signs every delivery with the `x-agent-games-signature` header over the raw request body, and the build guide requires verification *before parsing or processing*. Our handler reads the raw bytes, verifies the signature, and only then touches the JSON. The secret — issued at registration — never appears in code: it is stored as a Wrangler secret and read from the environment at runtime.

**Idempotency by `task_id`.** The platform may retry a delivery after a network failure, so the same `task_id` can arrive twice. The Worker caches each response in KV for seven days and replays the identical answer on a duplicate delivery. (Deterministic salt derivation, below, is what makes the replayed proof byte-identical.)

**The seen-set.** Reuse detection is the one trap that cannot be decided from a single task in isolation: it needs memory of every `proof_tx` the agent has ever accepted. We keep that set in Cloudflare KV, keyed per mode (`seen:competition:<proofTx>` / `seen:practice:<proofTx>`), so practice tasks can never poison competition state. Every `proof_tx` is recorded — including from rejected tasks.

**Fail closed, everywhere.** Any uncertainty resolves to REJECT. If the prover throws or times out, the agent still returns the decision without a proof — a correct decision without a proof nets +10, which beats a −2 timeout every time. If the handler itself throws, a last-resort catch returns a signed REJECT: the worst case of a wrong REJECT (−3) is half the worst case of a wrong APPROVE (−6).

## The seven traps

The platform publishes all seven trap varieties in advance — *"The test is whether your agent checks every field — not whether it can guess."* Roughly half of all tasks are valid; the rest carry exactly one trap (shares are the published frequencies):

| # | `reason_code` | Decision | Exact condition | Share |
|---|---|---|---|---|
| 1 | `VALID_CONDITION` | APPROVE | All checks pass | ~50% |
| 2 | `VK_SUBSTITUTION` | REJECT | `proof_vk != registered_vk` | ~13% |
| 3 | `THRESHOLD_MISMATCH` | REJECT | `public_balance < minimum` | ~8% |
| 4 | `PROOF_REUSED` | REJECT | `proof_tx` already seen | ~11% |
| 5 | `EXPIRED_CONDITION` | REJECT | `current_block >= expiry_block` | ~6% |
| 6 | `RECIPIENT_MISMATCH` | REJECT | `recipient != condition_recipient` | ~6% |
| 7 | `AMOUNT_OVERFLOW` | REJECT | `amount > max_transfer` | ~6% |

Three implementation details matter more than they look. **Amounts are decimal strings** — `minimum`, `public_balance`, `amount`, and `max_transfer` must be compared as `BigInt`, never as floats. **Hex is normalised before comparison** — VK hashes and addresses are compared lowercase with the `0x` prefix stripped. **Boundaries are inclusive except one**: `public_balance == minimum` and `amount == max_transfer` are valid, but `current_block == expiry_block` is **expired** — a strict `currentBlock < expiryBlock` rule, taken from the circuit itself, not the ambiguous prose (next section).

When several traps apply to one task, the platform never states which `reason_code` wins, and a correct REJECT may require the trap to be "correctly identified" to score +12. Our engine evaluates in a fixed documented order — reuse → VK → threshold → expiry → recipient → amount — returns the first hit, and logs *all* detected traps for debugging. Reuse comes first because it is the only trap with no proof to submit, so it must be decided before the prover runs.

## The ZK pipeline: recovering a circuit from its own shadow

The most interesting part of this build was not the Worker. It was the circuit. The platform publishes the compiled artifacts — `gatekeeper.wasm` (~1.7 MB) and `gatekeeper_final.zkey` (~0.3 MB) — and the registered verification-key hash on zkVerify mainnet (`0x6b79c601…77b0`), but **not the circuit source**. No `.circom` file, no symbol table, no public repository. To generate a proof, we needed the circuit's inputs: their names, their order, and their semantics. We recovered all of it empirically.

**Step 1: what the artifacts say for free.** Exporting the verification key with snarkjs 0.7.5 and parsing the zkey header gave us the skeleton: **Groth16 over BN128**, Circom 2.2.3, `nPublic = 13`, 647 constraints, domain size 2¹⁰ — a tiny circuit, which is why local proving takes seconds. Running `strings` over the wasm revealed the main template — `GatekeeperEvaluation` — and its sub-templates: `PoseidonEx`/`Poseidon`, comparators, and `AND`. That inventory alone told us the circuit's shape: a Poseidon hash plus a set of comparisons ANDed together.

**Step 2: recovering the 13 input names.** Circom's wasm witness generator resolves input signals by the FNV-1a-64 hash of the bare signal name, and exports `getInputSignalSize(h1, h2)` — 1 for a real input signal, 0 otherwise. That function is a read-only oracle. We tested 398 candidate names × two prefixes × four hash variants, and got **exactly 13 hits** — matching `getInputSize() = 13`, i.e. complete coverage:

`minimum`, `recipient`, `amount`, `publicBalance`, `expiryBlock`, `currentBlock`, `conditionRecipient`, `maxTransfer`, `registeredVkHash`, `proofVkHash`, `salt`, `decision`, `taskId`.

Twelve are public inputs; `salt` is the single private input. The 13 public signals are those 12 inputs plus one circuit output: a Poseidon digest (below).

Two structural facts fell out immediately. First, **`proof_tx` is not a circuit input** — reuse cannot be proven in-circuit because it needs off-chain state, which is exactly why PROOF_REUSED tasks "have no proof to submit and are excluded" from the reliability bonus. Second, the proof hides exactly one thing — the salt — and is otherwise a *verifiable attestation that the decision is the correct evaluation of the public task values*.

**Step 3: the prove/verify oracle.** With the input names known, we turned snarkjs into an oracle: a trial assignment verifies **if and only if** it satisfies the circuit. Twelve test assignments (T1–T12) settled everything the prose left ambiguous:

- **Decision encoding: 1 = APPROVE, 0 = REJECT.** An all-pass assignment with `decision=1` verifies; with `decision=0` it fails at witness generation. A failing assignment with `decision=0` verifies; with `decision=1` it fails. The circuit *asserts* that the decision equals its own evaluation.
- **Boundaries, empirically.** `publicBalance == minimum` with `decision=1` verifies (threshold is `>=`); `amount == maxTransfer` with `decision=1` verifies (cap is `<=`); but `currentBlock == expiryBlock` with `decision=1` **fails**, while with `decision=0` it verifies. Expiry is strict — the result the event page's prose leaves ambiguous, resolved by the platform's own artefact.
- **Fail-fast behaviour.** A wrong decision does not produce an invalid proof — `fullProve` **throws** at witness generation (`Assert Failed`, template `GatekeeperEvaluation`, line 102). In production this is a feature: a throw means our decision logic disagrees with the circuit, and we treat it as a bug signal, never as a sendable state.
- **Public-signal order.** Recovered from the probe assignments: `[0]` Poseidon digest, `[1]` `registeredVkHash`, `[2]` `proofVkHash`, `[3]` `minimum`, `[4]` `publicBalance`, `[5]` `expiryBlock`, `[6]` `currentBlock`, `[7]` `recipient`, `[8]` `conditionRecipient`, `[9]` `amount`, `[10]` `maxTransfer`, `[11]` `decision`, `[12]` `taskId`.

**Step 4: the Poseidon binding.** Public signal `[0]` is identical across every probe with the same `(salt, taskId)` despite different decisions and task values — so the digest depends only on those two inputs. Recomputing with `circomlibjs` confirmed it on two independent points: `Poseidon([0, 1])` matches the T1 digest exactly, and `Poseidon([999999, 424242])` matches T11; reversed order and single-input variants do not match:

```
publicSignals[0] = Poseidon(salt, taskId)   // 2-input Poseidon over BN128
```

The digest binds each proof to a specific task and a specific salt. Since `salt` is private, the platform cannot recompute the digest unless the agent reveals the salt or the salt is derived from something the platform knows — one of the open questions below. The digest also gives the platform free replay detection: the same digest twice means a replayed proof.

**Step 5: proving inside the Worker.** The Worker embeds the circuit artifacts as base64 (generated at build time from the `.wasm` and `.zkey`, ~2 MB total) and runs `snarkjs.groth16.fullProve` in-process, followed by a local `groth16.verify` before anything is sent. Proving is raced against a 40-second timeout, leaving headroom inside the 60-second deadline; on timeout, the decision still goes out without the proof.

## Design decisions — and the questions we are honest about

A build like this is defined as much by what the documentation does *not* say as by what it does. We made explicit, documented choices for each gap — each one falsifiable in practice mode before a scored round depends on it.

**Response proof format (the biggest open question).** The public pages require a Groth16 proof and say to "include the proof in your response" — but no published sample response contains a proof field. Our working hypothesis (H1) is that the proof is embedded: extra `proof` (the snarkjs object `{pi_a, pi_b, pi_c, protocol, curve}`) and `public_signals` (13 decimal strings) fields alongside the confirmed `decision`, `reason_code`, and `proof_tx`. The strongest support is the Steal the VFY section of the same build page, which describes *its* response as "circuitVersion plus the Groth16 proof and public_signals". The alternative (H2) — submitting the proof to zkVerify via Kurier or zkVerifyJS — would require a funded on-chain submission per task inside the same 60 seconds. We implemented H1, isolated the response shape in a single function, and deliberately omitted `circuitVersion` until its expected value is confirmed.

**HMAC construction.** The rules say "HMAC" but never name the hash or the header encoding. We implemented HMAC-SHA256 — the industry default, and the natural match for a 32-byte secret — with verification accepting hex, base64, or `sha256=<hex>` (trying candidate encodings is safe: forgery still requires the secret) and timing-safe comparison throughout. Production has since confirmed it: every scored delivery across Rounds 3–6 verified and was answered (32/32 tasks).

**Deriving field elements.** A 32-byte vkHash does not fit in a single BN128 field element (~254 bits), and a string `task_id` like `gk_24_9d1` is not a number at all — so the circuit inputs need derivations the platform never published. Our choices: `vkHash → BigInt(0xhash) mod p`, `salt → BigInt(sha256("salt:" + taskId)) mod p`. The salt derivation is deliberately deterministic per task: a retried delivery must prove identically. The `taskId` mapping changed mid-competition: we first used `BigInt(sha256(taskId)) mod p`, but a fellow participant's published build log showed their verified-correct count jumping 4 → 8 within a single round after switching to reading the task UUID as a 128-bit integer — so on 19 November we applied the same mapping (UUID as an integer, SHA-256 fallback for non-UUID ids) and redeployed. Round 7 is the live test of whether our proofs were being rejected on this alone; if the count stays at zero, the salt derivation is the next suspect.

**What the dashboard must confirm.** One correction to our own plan: practice mode never submits proofs on-chain, so it cannot validate proof acceptance at all — its VERIFIED badge only confirms the decision and response shape. The real evidence is the per-round verified-correct count on the dashboard, which only the platform sees. Status as of 19 November: the HMAC construction is confirmed (32/32 scored deliveries verified); the health-check and signed preflight passed at registration; the response proof format (embedded `proof` + `public_signals`) and the field derivations are still unconfirmed — Round 7, running on the corrected taskId mapping, is the test. The `reason_code` for APPROVE (`VALID_CONDITION`, presumed) and multi-trap precedence remain unconfirmed either way.

## What we learned, and why this pattern matters

**1. The circuit is the specification.** When the prose was ambiguous — the expiry boundary, the decision encoding, the public-signal order — the compiled circuit answered every question, because the circuit *is* the platform's own enforcement. Probing a circuit with prove/verify as an oracle is a technique any agent builder can reuse: you do not need the source, only its artifacts.

**2. Determinism is the whole game.** A gatekeeper that is right 95% of the time is a liability; the scoring punishes wrong approvals twice as hard as wrong rejections because an unreliable gatekeeper is worse than a cautious one. Every design choice in SanLav — BigInt comparisons, normalised hex, a fixed trap precedence, deterministic salt, fail-closed defaults — exists to make the same task always produce the same correct answer. The ZK proof then turns that determinism into something *checkable by a third party*: the platform does not have to trust our code, only the proof.

**3. A proof of a decision is a different kind of trust.** Most agent-economy designs ask you to trust the agent: its code, its operator, its incentives. The gatekeeper pattern inverts that: the judgement arrives with a succinct proof that it follows from the public inputs. Agents that move money on your behalf should not ask for trust; they should *prove* each decision, in a form anyone can verify. zkVerify's role in that stack is the verification layer that makes the proof cheap to check and expensive to fake.

SanLav answered 32/32 tasks in Rounds 3–6 with that design, and Round 7 is now testing the corrected taskId mapping. The scoreboard will tell us whether the remaining hypotheses held. Either way, the circuit probe, the decision engine, and the honest list of open questions are the durable output.

---

*Build state as of the 19 November 2026 update: SanLav is registered for the Proof Gatekeeper track; the Cloudflare Worker is live; Rounds 1–2 were missed while the endpoint was being built; Rounds 3–6 answered 32/32 tasks; the taskId mapping fix (UUID as a 128-bit integer) was applied and deployed on 19 November and is being tested in Round 7. No verified-correct counts are claimed here — those live only on the platform dashboard. Code: [github.com/san3koflackers/agent-games-gatekeeper](https://github.com/san3koflackers/agent-games-gatekeeper) (no secrets in the repo — the HMAC secret is deployed only as a Wrangler secret).*

### Sources

- zkVerify Agent Games — Proof Gatekeeper event page: <https://agentgames.zkverify.io/events/proof-gatekeeper>
- Agent Games build guide: <https://agentgames.zkverify.io/build>
- Agent Games rules: <https://agentgames.zkverify.io/rules>
- Circuit info API: <https://agentgames.zkverify.io/api/circuit-info> (gatekeeper vkHash `0x6b79c601…77b0`, artifact URLs, mainnet)
- zkVerify docs — Quickstart: <https://docs.zkverify.io/handbook/quickstart>
- zkVerify docs — Kurier: <https://docs.zkverify.io/overview/getting-started/kurier>
- zkVerifyJS reference: <https://docs.zkverify.io/overview/zkverifyjs>
- Circuit probe (our own work): 12 prove/verify assignments over the published `gatekeeper.wasm` / `gatekeeper_final.zkey` (snarkjs 0.7.5); input names recovered via the wasm `getInputSignalSize` oracle; Poseidon digest confirmed with circomlibjs.
