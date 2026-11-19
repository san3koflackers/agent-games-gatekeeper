// HMAC-SHA256 helpers (WebCrypto; works in Cloudflare Workers and Node 19+).
// Header (both directions): x-agent-games-signature, over the raw body bytes.
// Source: Rules §1.3 + Build §Security (see ../docs/protocol-spec.md §3).
//
// OPEN (OQ2): the platform never publishes the header encoding. Verification
// tries hex, then base64, then `sha256=<hex>` — all are HMAC-SHA256 over the
// same raw bytes, so trying candidates is safe (forgery still requires the
// secret). Signing uses lowercase hex (most common convention); confirm via
// practice mode and change SIGN_ENCODING if the platform rejects it.

const SIGN_ENCODING = "hex"; // "hex" | "base64"

function hexToBytes(hex) {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64.trim());
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Constant-time equality for same-length buffers.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacSha256(secretHex, dataBytes) {
  return hmacSha256Bytes(hexToBytes(secretHex), dataBytes);
}

async function hmacSha256Bytes(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(sig);
}

// The platform never publishes whether the HMAC key is the hex-DECODED
// secret (32 bytes) or the UTF-8 bytes of the hex STRING (64 bytes).
// Both require the secret, so trying both is safe. Returns the matching
// key form ("hex" | "utf8") or null.
export async function verifySignatureMulti(secret, bodyBytes, headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  const v = headerValue.trim();
  let candidate;
  try {
    if (v.startsWith("sha256=")) {
      candidate = hexToBytes(v.slice(7));
    } else if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) {
      candidate = hexToBytes(v);
    } else {
      candidate = base64ToBytes(v);
    }
  } catch {
    return null;
  }
  const keyForms = [
    ["hex", hexToBytes(secret)],
    ["utf8", new TextEncoder().encode(String(secret).trim())],
  ];
  for (const [form, keyBytes] of keyForms) {
    const expected = await hmacSha256Bytes(keyBytes, bodyBytes);
    if (timingSafeEqual(candidate, expected)) return form;
  }
  return null;
}

/** Sign raw response bytes. Returns the header value. */
export async function signBody(secretHex, bodyBytes, keyForm = "hex") {
  const keyBytes = keyForm === "utf8"
    ? new TextEncoder().encode(String(secretHex).trim())
    : hexToBytes(secretHex);
  const sig = await hmacSha256Bytes(keyBytes, bodyBytes);
  return SIGN_ENCODING === "base64" ? bytesToBase64(sig) : bytesToHex(sig);
}

/**
 * Verify an incoming x-agent-games-signature header against raw body bytes.
 * Accepts hex, base64, or `sha256=<hex>`. Returns true only on a match.
 */
export async function verifySignature(secretHex, bodyBytes, headerValue) {
  if (!headerValue || typeof headerValue !== "string") return false;
  const expected = await hmacSha256(secretHex, bodyBytes);
  const v = headerValue.trim();
  const candidates = [];
  if (v.startsWith("sha256=")) {
    candidates.push(hexToBytes(v.slice(7)));
  } else if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) {
    candidates.push(hexToBytes(v));
  } else {
    try {
      candidates.push(base64ToBytes(v));
    } catch {
      return false;
    }
  }
  return candidates.some((c) => timingSafeEqual(c, expected));
}
