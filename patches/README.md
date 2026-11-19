# Workers patches for ffjavascript (proving fix, 15 Nov 2026)

## The problem

Cloudflare Workers bans `WebAssembly.compile()` at runtime
(`Wasm code generation disallowed by embedder`). `snarkjs` calls it in two
places, so the Gatekeeper worker answered every task **without a proof**
(correct decision, but −2 per provable task and no reliability bonus):

1. **Witness calculation** — `circom_runtime` compiles the gatekeeper circuit
   wasm from bytes.
2. **BN128 curve engine** — `ffjavascript` generates the engine wasm at
   runtime (`wasmbuilder` `ModuleBuilder.build()`) and compiles it in
   `buildThreadManager`.

## The fix (verified in workerd, 15 Nov 2026)

1. **Circuit wasm → static Module.** `src/gatekeeper.wasm` is imported as a
   WebAssembly Module (compiled at deploy time by wrangler/esbuild) and
   instantiated by `src/prover.js`; the Instance is handed to
   `WitnessCalculatorBuilder`, which accepts an Instance directly — no
   compile. Witness in ~90 ms in workerd.
2. **BN128 engine wasm → prebuilt Module.** `ModuleBuilder.build()` output
   is **deterministic** (byte-identical across runs, sha256
   `eea61e66b72d1c0eb49c91521a25a8fa09a4d9d51c2fe74cabf596f48eea8639`)
   and identical to the shipped `wasmcurves/build/bn128.wasm`, so the file is
   statically imported as `src/bn128-engine.wasm` and injected via
   `globalThis.__BN128_WASM_MODULE__ = { module, meta }` (offsets in
   `src/prover.js` `BN128_META`). The patches below make `buildThreadManager`
   / the in-process thread accept a Module instead of compiling, and force
   single-thread mode when no `Worker` global exists (Workers has none).
3. **Node fallback kept.** Node cannot link a `.wasm` whose imports
   (`"env"`/`"runtime"`) are not ESM packages, so in Node the dynamic wasm
   imports throw and `src/prover.js` falls back to the original
   `snarkjs.groth16.fullProve` with embedded bytes. `npm test` exercises
   this path and still passes.

## Verification (workerd, local `wrangler dev --local`)

| Task | Result |
|---|---|
| APPROVE / VALID_CONDITION | proof OK, locally verified, 13 public signals, decision signal `1`, **~470–640 ms total** |
| REJECT / VK_SUBSTITUTION | proof OK, locally verified, 13 public signals, decision signal `0`, **~620 ms total** |
| Before the fix | `prove-failed: WebAssembly.compile(): Wasm code generation disallowed`, response without proof |

Both well inside the 60 s response deadline. The `npm test` suite
(decision engine, HMAC, full handler round-trip with proof) still passes
in Node.

## Files

- `ffjavascript-src-threadman.js.patch` — `buildThreadManager` accepts a
  Module; forces single-thread when `Worker` is undefined.
- `ffjavascript-src-threadman_thread.js.patch` — the in-process thread's
  `init()` accepts a Module.
- `ffjavascript-src-bn128.js.patch` — `buildBn128` uses the injected
  prebuilt Module + meta instead of generating + compiling.
- `ffjavascript-build-browser.esm.js.patch` — the same three changes in the
  prebuilt browser bundle, which is what wrangler/esbuild actually bundles
  for Workers (the `"browser"` export condition). **This is the patch that
  matters for deploy; the `src/` patches matter for Node.**

The patches are re-applied automatically after `npm install` by the
`postinstall` script (`tools/apply-worker-patches.mjs`, idempotent,
uses the `patch` CLI). To verify manually:
`cd node_modules/ffjavascript && patch -p1 --dry-run < ../../patches/<file>.patch`
should report "previously applied" (or apply cleanly on a fresh install).

## Known limitation

The multi-thread path (`threadStr`, used only when real `Worker`s are
spawned) still contains a `WebAssembly.compile` call inside its embedded
string. It is dead code in Workers because single-thread mode is forced
when no `Worker` global exists, and dead in the browser build for the same
reason. If a future runtime ever takes the multi-thread path, that path
would need the same Module treatment.
