// The kill switch: can we terminate a stream without being able to see it?
//
// Run in two phases around an out-of-band kill, because the admin password is a secret this
// script does not hold:
//
//   node scripts/e2e/kill-switch.mjs setup            -> prints a live stream id
//   (kill it: admin API, or UPDATE stream_salts SET killed_at = datetime('now') ...)
//   node scripts/e2e/kill-switch.mjs verify <id>      -> checks it is really dead
//
// Phase 1 also confirms the admin endpoints refuse an unauthenticated caller, which is the
// one part of the surface that does not need the password to test.

import { webcrypto as c } from "node:crypto";

const [phase, streamArg] = process.argv.slice(2);
const ORIGIN = process.env.WF_ORIGIN || "https://e2emoq.com";
const PK = process.env.WF_PUBLISH_KEY;
if (!PK) {
  console.error("WF_PUBLISH_KEY is required");
  process.exit(1);
}

const CLAIM_CONTEXT = "e2emoq-claim-v1";
const b64url = (b) => Buffer.from(b).toString("base64url");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name} — got ${actual}, expected ${expected}`);
};

const goLive = async (streamId) => {
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
      publish_key: PK,
      pubkey: b64url(raw),
      challenge: ch,
      signature: b64url(sig),
    }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

if (phase === "setup") {
  const streamId = "k" + Math.random().toString(36).slice(2, 6).replace(/[^a-z0-9]/g, "a");
  const live = await goLive(streamId);
  check("broadcast starts", live.status, 200);
  if (!live.body.salt) {
    failures++;
    console.log("  FAIL  go-live returned no salt");
  } else {
    console.log(`  ok    go-live returned a salt`);
  }

  const route = await fetch(`${ORIGIN}/api/streams/${streamId}/route`);
  check("viewers can route to it", route.status, 200);
  const routeBody = await route.json().catch(() => ({}));
  check("viewer salt matches publisher salt", routeBody.salt, live.body.salt);

  // Admin surface must not be usable without the password.
  for (const ep of ["kill", "unkill", "kill-all"]) {
    const r = await fetch(`${ORIGIN}/api/admin/${ep}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream_id: streamId }),
    });
    check(`/api/admin/${ep} refuses an unauthenticated caller`, r.status, 401);
  }

  console.log(`\nSTREAM_ID=${streamId}`);
  console.log(failures === 0 ? "setup ok — now kill it, then run: verify " + streamId : `FAIL: ${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
} else if (phase === "verify") {
  if (!streamArg) {
    console.error("usage: kill-switch.mjs verify <streamId>");
    process.exit(1);
  }
  const route = await fetch(`${ORIGIN}/api/streams/${streamArg}/route`);
  check("killed stream refuses viewers", route.status, 410);

  const relive = await goLive(streamArg);
  check("killed stream refuses a new broadcast", relive.status, 403);

  console.log(failures === 0 ? "\nPASS: the stream is terminated for both viewers and publisher." : `\nFAIL: ${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
} else {
  console.error("usage: kill-switch.mjs setup | verify <streamId>");
  process.exit(1);
}
