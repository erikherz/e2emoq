// Per-person publish codes: proof of work, admission, and every way a code must fail.
//
// The point of a stateless capability is that the seal, not a lookup, is what makes it
// trustworthy — so the tests that matter are the ones where a code is edited. If a tampered
// payload were ever accepted, the expiry would become a suggestion and the whole design would
// silently be back to one shared secret that never expires.
//
//   WF_ADMIN_PASSWORD=<secret> node scripts/e2e/publish-code.mjs [origin]
//
// Runs against a DEPLOYED worker (there is no pre-deploy environment on this account). Give
// the edge a moment after `npm run deploy` or the first assertions read the old code.

import { webcrypto as c } from "node:crypto";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
// Optional: without it the revocation sections are skipped rather than failed, so the
// tamper-resistance assertions — the ones that matter most — still run for anyone.
const ADMIN = process.env.WF_ADMIN_PASSWORD;

const CLAIM_CONTEXT = "e2emoq-claim-v1";
const b64url = (b) => Buffer.from(b).toString("base64url");
const rid = () => Math.random().toString(36).slice(2, 7).replace(/[^a-z0-9]/g, "a");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok ? "" : `  (got ${actual}, want ${expected})`}`);
};

// ── Proof of work ────────────────────────────────────────────────────────────────────────
// Mirrors powIsValid() in the Worker and solve() in public/request.html. Three copies of one
// rule is two too many; if it ever changes, change all three or nothing will validate.
const leadingZeroBits = (bytes) => {
  let seen = 0;
  for (const byte of bytes) {
    if (byte === 0) { seen += 8; continue; }
    seen += Math.clz32(byte) - 24;
    break;
  }
  return seen;
};

async function solve(challenge, bits) {
  const enc = new TextEncoder();
  for (let i = 0; ; i++) {
    const d = new Uint8Array(await c.subtle.digest("SHA-256", enc.encode(`${challenge}|${i}`)));
    if (leadingZeroBits(d) >= bits) return String(i);
  }
}

async function requestCode() {
  const chal = await (await fetch(`${ORIGIN}/api/publish-code/challenge`)).json();
  const nonce = await solve(chal.challenge, chal.bits);
  const r = await fetch(`${ORIGIN}/api/publish-code/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: chal.challenge, nonce }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})), chal };
}

// ── Admission probe ──────────────────────────────────────────────────────────────────────
// A full, correctly signed go-live differing ONLY in the credential, so a rejection can only
// be the credential's doing.
const admit = async (credential) => {
  const streamId = rid();
  const ch = (await (await fetch(`${ORIGIN}/api/publish/challenge`)).json()).challenge;
  const kp = await c.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const msg = new TextEncoder().encode(`${CLAIM_CONTEXT}|${streamId}|${ch}`);
  const sig = await c.subtle.sign("Ed25519", kp.privateKey, msg);
  const raw = await c.subtle.exportKey("raw", kp.publicKey);
  const r = await fetch(`${ORIGIN}/api/stats/broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream_id: streamId,
      publish_key: credential,
      pubkey: b64url(raw),
      challenge: ch,
      signature: b64url(sig),
    }),
  });
  return r.status;
};

const admin = (path, body) =>
  fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify(body),
  }).then((r) => r.json().catch(() => ({})));

console.log(`\npublish codes @ ${ORIGIN}\n`);

// ── 1. Proof of work is actually required ────────────────────────────────────────────────
{
  const chal = await (await fetch(`${ORIGIN}/api/publish-code/challenge`)).json();
  console.log(`difficulty: ${chal.bits} bits · delay: ${chal.delay_hours}h · ttl: ${chal.ttl_days}d`);

  const r = await fetch(`${ORIGIN}/api/publish-code/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: chal.challenge, nonce: "0" }),
  });
  // "0" solving an 18-bit target is a 1-in-262,144 accident; treat it as a real failure.
  check("unsolved proof of work is refused", r.status, 403);

  const forged = await fetch(`${ORIGIN}/api/publish-code/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: `${Math.floor(Date.now() / 1000)}.notarealmac`, nonce: "0" }),
  });
  check("self-minted challenge is refused", forged.status, 403);
}

// ── 2. A real code admits ────────────────────────────────────────────────────────────────
const started = Date.now();
const { status: mintStatus, body: minted } = await requestCode();
check("a solved request mints a code", mintStatus, 200);
console.log(`  proof of work took ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (!minted.code) {
  console.error("\nno code returned; cannot continue");
  process.exit(1);
}
const activeNow = new Date(minted.active_at) <= new Date();
console.log(`  active_at ${minted.active_at} (${activeNow ? "usable now" : "delayed"})`);

check("a minted code is admitted", await admit(minted.code), activeNow ? 200 : 403);

// ── 3. Tampering. The whole reason the expiry can live inside the credential. ────────────
{
  const [v, payload, mac] = minted.code.split(".");

  const flipped = mac.slice(0, -1) + (mac.slice(-1) === "A" ? "B" : "A");
  check("a tampered MAC is refused", await admit(`${v}.${payload}.${flipped}`), 403);

  // Extend the expiry by a decade, keeping the original MAC — the attack the seal exists for.
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  claims.exp += 10 * 365 * 86400;
  const extended = Buffer.from(JSON.stringify(claims)).toString("base64url");
  check("an extended expiry is refused", await admit(`${v}.${extended}.${mac}`), 403);

  // Same, for the batch: revoking a cohort is worthless if a holder can rewrite their own.
  claims.exp -= 10 * 365 * 86400;
  claims.batch = 424242;
  const rebatched = Buffer.from(JSON.stringify(claims)).toString("base64url");
  check("a rewritten batch is refused", await admit(`${v}.${rebatched}.${mac}`), 403);

  check("a truncated code is refused", await admit(`${v}.${payload}`), 403);
  check("nonsense is refused", await admit("wf1.aaaa.bbbb"), 403);
  check("an empty credential is refused", await admit(""), 403);
}

// ── 4. Revoking one code without knowing whose it is ─────────────────────────────────────
if (activeNow && !ADMIN) console.log("  skip  revocation (WF_ADMIN_PASSWORD unset)");
if (activeNow && ADMIN) {
  const res = await admin("/api/admin/revoke-code", { code: minted.code, note: "e2e" });
  check("revoke-code returns a hash, not the code", typeof res.code_hash === "string", true);
  check("revoke-code stores no copy of the code", JSON.stringify(res).includes(minted.code), false);
  check("a revoked code is refused", await admit(minted.code), 403);

  await admin("/api/admin/revoke-code", { code: minted.code, undo: true });
  check("undo restores it", await admit(minted.code), 200);
}

// ── 5. Revoking a whole cohort ───────────────────────────────────────────────────────────
if (activeNow && ADMIN) {
  const claims = JSON.parse(Buffer.from(minted.code.split(".")[1], "base64url").toString());
  await admin("/api/admin/revoke-batch", { batch: claims.batch, note: "e2e" });
  check(`a code in revoked batch ${claims.batch} is refused`, await admit(minted.code), 403);

  await admin("/api/admin/revoke-batch", { batch: claims.batch, undo: true });
  check("undo restores the cohort", await admit(minted.code), 200);
}

// ── 6. The shared secret still works alongside codes ─────────────────────────────────────
if (process.env.WF_PUBLISH_KEY) {
  check("the shared PUBLISH_SECRET still admits", await admit(process.env.WF_PUBLISH_KEY), 200);
} else {
  console.log("  skip  shared-secret coexistence (WF_PUBLISH_KEY unset)");
}

console.log(failures ? `\nFAIL: ${failures} assertion(s)\n` : "\nPASS: publish codes\n");
process.exit(failures ? 1 : 0);
