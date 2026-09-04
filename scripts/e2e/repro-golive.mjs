/**
 * Reproduce a go-live end to end, against a deployed origin, with no browser.
 *
 * Walks the exact three steps the client walks — mint a publish code behind the proof of work,
 * take a publish challenge, sign an ownership claim — and then POSTs /api/stats/broadcast.
 * Prints the status and body of every step, so a 500 is attributable to one of them instead of
 * being reported as "the server answered 500".
 *
 *   node scripts/e2e/repro-golive.mjs [origin]
 *
 * Side effect worth knowing: a successful run WRITES a live broadcast_events row and a
 * stream_salts row for a random id, exactly as a real broadcast would. It closes the row again
 * on the way out. Nothing is published to any relay.
 */
import { webcrypto as c } from "node:crypto";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const b64url = (b) => Buffer.from(b).toString("base64url");

async function step(label, url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  console.log(`\n── ${label}`);
  console.log(`   ${init?.method ?? "GET"} ${url.replace(ORIGIN, "")} → ${res.status}`);
  console.log(`   ${typeof body === "string" ? body : JSON.stringify(body).slice(0, 400)}`);
  return { status: res.status, body };
}

// 1. Publish code, behind the proof of work.
const pow = await step("publish-code challenge", `${ORIGIN}/api/publish-code/challenge`);
if (pow.status !== 200) process.exit(1);

const bits = pow.body.bits;
process.stdout.write(`\n   solving ${bits} bits`);
const t0 = Date.now();
let nonce = 0;
for (;;) {
  const d = new Uint8Array(
    await c.subtle.digest("SHA-256", new TextEncoder().encode(`${pow.body.challenge}|${nonce}`))
  );
  let seen = 0;
  for (const byte of d) {
    if (byte === 0) { seen += 8; continue; }
    seen += Math.clz32(byte) - 24;
    break;
  }
  if (seen >= bits) break;
  nonce++;
}
console.log(` — nonce ${nonce} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const code = await step("publish-code request", `${ORIGIN}/api/publish-code/request`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ challenge: pow.body.challenge, nonce: String(nonce) }),
});
if (code.status !== 200) process.exit(1);

// 2. Ownership: a keypair minted per broadcast, exactly as the browser does.
const streamId = Array.from({ length: 5 }, () =>
  "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
console.log(`\n   stream id: ${streamId}`);

const chal = await step("publish challenge", `${ORIGIN}/api/publish/challenge`);
if (chal.status !== 200) process.exit(1);

const kp = await c.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pubRaw = new Uint8Array(await c.subtle.exportKey("raw", kp.publicKey));
const CLAIM_CONTEXT = "e2emoq-claim-v1";
const msg = new TextEncoder().encode(`${CLAIM_CONTEXT}|${streamId}|${chal.body.challenge}`);
const sig = new Uint8Array(await c.subtle.sign("Ed25519", kp.privateKey, msg));

// 3. Go live.
const live = await step("go live", `${ORIGIN}/api/stats/broadcast`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    stream_id: streamId,
    publish_key: code.body.code,
    pubkey: b64url(pubRaw),
    challenge: chal.body.challenge,
    signature: b64url(sig),
    route_tag: null,
  }),
});

if (live.status === 200) {
  console.log(`\n✓ relay=${live.body.relay} path=${live.body.path} jwt=${live.body.jwt ? "minted" : "MISSING"}`);
  if (live.body.id) {
    await step("end broadcast", `${ORIGIN}/api/stats/broadcast/${live.body.id}/end`, { method: "POST" });
  }
} else {
  console.log(`\n✗ go-live failed with ${live.status} — this is the 500 the UI reports`);
}
process.exit(live.status === 200 ? 0 : 1);
