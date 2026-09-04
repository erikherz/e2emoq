// Publisher authorization: admission + name ownership.
//
// Exercises the endpoint directly rather than through a browser, so each failure mode can be
// probed in isolation. Before this existed, every one of these cases returned 200 and a
// publish token.
//
//   WF_PUBLISH_KEY=<secret> node scripts/e2e/publisher-auth.mjs [origin]

import { webcrypto as c } from "node:crypto";

const ORIGIN = process.argv[2] || "https://e2emoq.com";
const PK = process.env.WF_PUBLISH_KEY;
if (!PK) {
  console.error("WF_PUBLISH_KEY is required");
  process.exit(1);
}

const CLAIM_CONTEXT = "e2emoq-claim-v1";
const b64url = (b) => Buffer.from(b).toString("base64url");
const rid = () => Math.random().toString(36).slice(2, 7).replace(/[^a-z0-9]/g, "a");

const challenge = async () => (await (await fetch(`${ORIGIN}/api/publish/challenge`)).json()).challenge;

const claimFor = async (streamId, pair) => {
  const ch = await challenge();
  const kp = pair ?? (await c.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]));
  const msg = new TextEncoder().encode(`${CLAIM_CONTEXT}|${streamId}|${ch}`);
  const sig = await c.subtle.sign("Ed25519", kp.privateKey, msg);
  const raw = await c.subtle.exportKey("raw", kp.publicKey);
  return { kp, body: { pubkey: b64url(raw), challenge: ch, signature: b64url(sig) } };
};

const post = async (body) => {
  const r = await fetch(`${ORIGIN}/api/stats/broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name} — got ${actual}, expected ${expected}`);
};

// 1. No credential at all.
const s1 = rid();
check("no publish key is refused", (await post({ stream_id: s1 })).status, 403);

// 2. Wrong credential.
const { body: claim2 } = await claimFor(s1);
check(
  "wrong publish key is refused",
  (await post({ stream_id: s1, publish_key: "not-the-key", ...claim2 })).status,
  403
);

// 3. Right credential, but no proof of name ownership.
check(
  "missing signed claim is refused",
  (await post({ stream_id: s1, publish_key: PK })).status,
  400
);

// 4. Right credential, signature over a DIFFERENT stream id — a replayed claim.
const other = rid();
const { body: claimOther } = await claimFor(other);
check(
  "claim signed for another stream is refused",
  (await post({ stream_id: s1, publish_key: PK, ...claimOther })).status,
  403
);

// 5. The legitimate case.
const { body: claimGood } = await claimFor(s1);
check("valid credential + claim succeeds", (await post({ stream_id: s1, publish_key: PK, ...claimGood })).status, 200);

// 6. Hijack: a DIFFERENT keypair claiming the name that is now live. This is the attack the
//    ownership check exists for — anyone holding a share link knows the stream id.
const { body: claimHijack } = await claimFor(s1);
check(
  "hijacking a live broadcast name is refused",
  (await post({ stream_id: s1, publish_key: PK, ...claimHijack })).status,
  409
);

console.log(failures === 0 ? "\nPASS: all publisher authorization checks behaved as expected." : `\nFAIL: ${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
