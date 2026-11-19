# DEPLOY.md — SanLav Proof Gatekeeper

Deploy the Gatekeeper agent to Cloudflare Workers. You deploy from your own
machine with your own Cloudflare account (the same one used for the vAPI
worker). Estimated time: ~10 minutes.

## 0. What you need

- Node.js 18+ and npm (already installed — you deployed the vAPI worker).
- This folder (`sanlav-gatekeeper/`), extracted from the zip.
- The agent HMAC secret (shown once when you registered SanLav — you have it;
  it is never written in any file here).

## 1. Install

```bash
cd sanlav-gatekeeper
npm install
```

## 2. Create the KV namespace (seen-set for PROOF_REUSED detection)

```bash
npx wrangler kv namespace create SEEN
```

Copy the `id` from the output and paste it into `wrangler.toml`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`.

## 3. Set the HMAC secret

```bash
npx wrangler secret put AGENT_GAMES_HMAC_SECRET
```

When prompted, paste the HMAC secret. (Wrangler secrets are encrypted at
rest by Cloudflare and never appear in code or dashboards.)

## 4. Deploy

```bash
npx wrangler deploy
```

Note the URL in the output, e.g. `https://sanlav-gatekeeper.<you>.workers.dev`.

## 4b. Redeploy after the proving fix (15 Nov 2026)

The Worker currently live answers tasks **without a proof** (Cloudflare
bans `WebAssembly.compile()` at runtime — see `patches/README.md`). The fix
is already in this folder and verified locally in workerd (full prove +
local verify in ~0.5–0.7 s, inside the 60 s deadline). To ship it:

```bash
npm install        # postinstall re-applies patches/ to node_modules/ffjavascript
npx wrangler deploy
```

No dashboard change is needed — the Worker URL stays the same. Then
dispatch **one practice task** from the dashboard and check its result:
that is the first live confirmation that the platform accepts our proof.
One mapping is still our best guess, not platform-confirmed: how `salt`
and `taskId` map to field elements (`src/prover.js`, OQ3). If a practice
task's proof is rejected by the platform while it verifies locally, that
mapping is the first suspect — send me the dashboard error.

## 5. Register the endpoint on Agent Games

1. Open https://agentgames.zkverify.io/dashboard
2. Open the **SanLav** agent settings.
3. Paste the Worker URL **with the `/agent` path** into the **Agent endpoint**
   field and save, e.g. `https://sanlav-gatekeeper.<you>.workers.dev/agent`.
   (The platform's deploy checklist asks for the full handler path, not just
   the root domain. The Worker answers task POSTs on any path, so the root
   URL would also work — `/agent` matches the documented shape.)
4. The platform immediately sends a **signed preflight** request; the Worker
   answers it automatically. Once preflight passes, the agent is marked
   active (status flips from UNHEALTHY) and tasks can flow.

## 6. Preflight + practice (required before scored rounds)

From the dashboard, run **at least one practice task** (Practice:
https://agentgames.zkverify.io/dashboard/practice).
Practice tasks are identical in format to scored tasks and do not affect the
leaderboard — they confirm the response schema, the HMAC signing, and the
proof all verify on the platform's side. If a practice task fails, send me
the error from the dashboard and I will patch the Worker (then redeploy with
`npx wrangler deploy`).

## 7. Rounds

- Scored rounds run **17:30–03:30 WIB** daily. Rounds 1–2 are missed;
  the target is Rounds 3–8 starting **15 Nov 17:30 WIB**.
- The Worker stays up by itself (Workers do not sleep). No action needed
  during rounds.
- To watch live logs: `npx wrangler tail`.

## Troubleshooting

- `wrangler login` — run `npx wrangler login` if the CLI asks for auth.
- `npm run build-assets` — regenerates the embedded circuit files
  (`src/wasm-b64.js`, `src/zkey-b64.js`, `src/vk.js`) from `../circuits/`.
  Only needed if those files are missing.
- `npm test` — runs the local test suite (decision engine, HMAC, proving,
  handler round-trip). Uses a dummy secret; safe to run anywhere.
- If you rotate the HMAC secret on Agent Games, re-run step 3 with the new
  secret and redeploy.
