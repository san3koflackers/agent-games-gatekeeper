// Workers-compat polyfill. MUST be imported before snarkjs (see index.js).
//
// snarkjs/ffjavascript calls URL.createObjectURL() at module top level to
// prepare a Web Worker URL for its multi-thread prover. Cloudflare Workers
// ships URL.createObjectURL as a stub that EXISTS but THROWS "not
// implemented", so the upload validation fails (error 10021) — a typeof
// guard is not enough, the stub must be detected by calling it.
//
// The URL is never actually used in Workers: buildThreadManager forces
// singleThread mode when globalThis.Worker is absent (always true here),
// so replacing it with a dummy is safe.
let needsStub = typeof URL === "undefined" || typeof URL.createObjectURL !== "function";
if (!needsStub) {
  try {
    const probe = URL.createObjectURL(new Blob(["probe"]));
    try { URL.revokeObjectURL(probe); } catch { /* ignore */ }
  } catch {
    needsStub = true; // exists but throws (workerd)
  }
}
if (needsStub && typeof URL !== "undefined") {
  URL.createObjectURL = () => "blob:stub";
}
