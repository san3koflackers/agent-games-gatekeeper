# APPLIED + DEPLOYED 2026-11-19 09:43 WIB (was DRAFT — user approved "Apply fix aja" 09:42)

- Edit applied to `src/prover.js`: `taskIdToField` added (UUID as 128-bit int, sha256 fallback), `buildCircuitInput` uses it; salt unchanged.
- Local checks passed: exact expected value 79893134504856089056082090541902360740, prefix-independent, fallback OK, `npm test` ALL PASSED (prove+verify 679 ms).
- Deployed: wrangler deploy 09:44 WIB, Version ID 217b4332-1fec-46dc-bd43-4b1d1e37b2ea, same URL.
- Live verified 09:45–09:46 WIB: UUID probe → APPROVE + proof, Groth16 local verify TRUE; fallback probe → same; local prove of the same UUID task gives identical publicSignals[0] (1967888172…84068) — the deployed Worker provably uses the new mapping. (First live-test right after deploy returned no proof — transient, first-request-after-deploy; two later probes prove fine.)
- Confirmation that matters: Ronde 7 (19 Nov 17:30 WIB) verified-correct numbers from the dashboard. If still 0, salt is the next suspect.

Original draft below (kept for reference):

# DRAFT — Gatekeeper taskId mapping fix (NOT applied, NOT deployed)

Prepared 2026-11-17 ~19:05 WIB. Needs the user's approval before any edit to
`src/prover.js` or redeploy. Do NOT deploy during a live round window
(Round 5 runs 17:30–03:30 WIB tonight); earliest safe slot is after 03:30 WIB
or before Round 6 starts 17:30 WIB on 2026-11-18.

## Why this exists

A fellow Gatekeeper participant published a Creator Track build log today
(Medium, Vjindramunggahari, 2026-11-17T06:25:38Z):
https://medium.com/@vjindramunggahari1990/fail-closed-by-default-lessons-from-running-a-zkverify-gatekeeper-agent-b120b916fc7f

Two claims in it bear directly on SanLav:

1. **Our current mapping is exactly the variant that failed for them.**
   SanLav today (`src/prover.js` lines 30–34, `stringToField`):
   `taskId -> BigInt(sha256(taskId)) mod p` — hashes the WHOLE task_id string.
   The article: "My first version hashed the whole ID string; the fix reads
   the identifier part as a 128-bit integer, with SHA-256 mod p only as a
   fallback." After that fix, their verified-correct decisions went from 4 to
   8 in the same round (Round 3); after Round 4 they stand at 15
   verified-correct, rank 25. Task IDs arrive as text like
   `practice_3c1adba6-80cc-4a87-8b67-e8eb510270a4` (prefix + UUID); the
   identifier part is the UUID, a 128-bit integer, which fits the BN128 field
   prime. `publicSignals[0]` is Poseidon(salt, taskId), so a wrong taskId
   binding means a rejected proof even when every decision is correct.
   Scoring cost of a wrong mapping: −2 per provable task plus the lost +0–5
   reliability bonus per round (up to ~−21 points per 8-task round).

2. **The practice-task test cannot confirm the fix.** The article:
   "Practice mode could never confirm the fix: it never submits proofs
   on-chain, and a VERIFIED badge proves the decision and response shape were
   accepted, not that a proof verified. The real test was round 3, where the
   platform re-verifies against its own key." This matches the 15 Nov 00:01
   note that the practice "Proof: VERIFIED" badge refers to the proof built
   into the task itself, not a proof from the Worker. The two practice-test
   reminders sent 16–17 Nov asked for a test that would not have answered
   the question. The real evidence is the scored rounds' verified-correct
   counts in the dashboard/leaderboard.

## Caveats (do not over-claim)

- The author is a different participant, not the platform and not SanLav.
  Their fix is strong evidence, not platform confirmation.
- The salt mapping (`salt = sha256("salt:" + taskId) mod p`) is NOT addressed
  by the article and stays unchanged in this draft. If Round 6 still shows
  0 verified after this fix, salt is the next suspect.
- SanLav's Round 3/4 verified-correct counts are still unknown — the
  dashboard check below settles whether the mapping was wrong.

## Quick check the user can do (1 minute, dashboard)

Open the SanLav dashboard and read the verified-correct count for Rounds 3
and 4. If decisions were mostly correct but verified-correct is 0 (or far
below correct), the mapping was wrong and this fix is the prime suspect.
If verified-correct is already high, do NOT apply this fix.

## Proposed change (only `taskId` in `buildCircuitInput`)

Replace in `src/prover.js`:

```js
// String id -> field element: sha256(id) mod p.
async function stringToField(text) {
  const h = await sha256Hex(text);
  return (BigInt("0x" + h) % FIELD_P).toString();
}
```

with a taskId-specific mapper (keep `stringToField` for salt):

```js
// Task id -> field element: the identifier part (UUID) as a 128-bit
// integer; SHA-256 mod p only as a fallback for non-UUID ids.
// Rationale: fellow participant's Round 3 evidence (see header) — hashing
// the whole "prefix_uuid" string fails platform verification, while the
// UUID-as-integer verifies. Prefix-independent: "practice_<uuid>" and
// "task_<uuid>" map identically.
async function taskIdToField(taskId) {
  const m = String(taskId).match(
    /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/,
  );
  if (m) return (BigInt("0x" + m[1].replace(/-/g, "")) % FIELD_P).toString();
  return stringToField(taskId);
}
```

and in `buildCircuitInput` change:

```js
    taskId: await stringToField(task.task_id),
```

to:

```js
    taskId: await taskIdToField(task.task_id),
```

## Sanity check already run (node, 2026-11-17)

- `practice_3c1adba6-80cc-4a87-8b67-e8eb510270a4` → 79893134504856089056082090541902360740
- `task_3c1adba6-80cc-4a87-8b67-e8eb510270a4` → same value (prefix-independent)
- `live_probe_1` → null → falls back to existing sha256 path
- UUID integer < FIELD_P: true

## After approval

1. Apply the edit, run local prove+verify in workerd (same as the 15 Nov
   proving-fix verification, ~0.5–0.7 s).
2. Redeploy (`npx wrangler deploy`, same URL) OUTSIDE a round window.
3. Verify in Round 6 (18 Nov 17:30 WIB): read the verified-correct count
   from the dashboard after the round — that, not a practice badge, is the
   confirmation. If verified jumps, the mapping is fixed for Rounds 6–8.

## Live state checked 2026-11-17 19:03 WIB

- Worker `/health`: HTTP 200, `{"status":"ok","agent":"SanLav",
  "track":"proof-gatekeeper"}`, 0.83 s — endpoint alive inside the Round 5
  window (17:30–03:30 WIB).
- `bsc-tx-guard` root: HTTP 200.
- No change made to `src/prover.js` or the deployed Worker by this draft.
