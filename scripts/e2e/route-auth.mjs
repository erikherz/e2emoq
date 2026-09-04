// Does /route require proof that the caller holds the share link?
//
// Before this existed, the Worker minted a viewer token to anyone who could name a live
// stream id. Ids are [a-z0-9]{5} — about 60 million values — so a stranger could sweep for
// live broadcasts and pull their ciphertext. Content was never exposed (the key lives in a
// fragment the Worker never sees), but it made this account an open tap for our own CDN
// egress and disclosed who was broadcasting and when.
//
// The test drives a REAL broadcast, then attacks its own stream three ways: no tag, a wrong
// tag, and the right one. The first two must be indistinguishable from a stream that is not
// live at all — a guesser must not even learn that the id exists.
//
//   WF_PUBLISH_KEY=<key> node scripts/e2e/route-auth.mjs [origin]

import puppeteer from "puppeteer";
import { webcrypto as wc } from "node:crypto";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
const STEP = (m) => console.log(`  ${m}`);

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

// Mirrors deriveRouteTag() in src/crypto/media-crypto.ts. Deliberately reimplemented rather
// than imported: if the two ever disagree, this test should notice.
async function routeTag(secretB64url, streamId) {
  const enc = new TextEncoder();
  const raw = Buffer.from(secretB64url, "base64url");
  const base = await wc.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
  const bits = await wc.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(`wf-route|${streamId}`),
      info: enc.encode("e2emoq-route-auth-v1"),
    },
    base,
    256
  );
  return Buffer.from(bits).toString("base64url");
}

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

try {
  const bc = await browser.newPage();
  await bc.goto(`${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  const streamId = await bc.evaluate(() => new URLSearchParams(location.search).get("stream"));
  await bc.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 320),
    { timeout: 45000 }
  );
  const shareUrl = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
  const secret = new URLSearchParams(shareUrl.split("#")[1]).get("k");
  if (!secret) throw new Error("share link carries no #k= secret");
  STEP(`broadcasting ${streamId}`);
  await new Promise((r) => setTimeout(r, 4000));

  const tag = await routeTag(secret, streamId);
  const hit = async (qs) => (await fetch(`${ORIGIN}/api/streams/${streamId}/route${qs}`)).status;

  console.log("");
  // The attacker's position: knows the id (guessed or swept), has no link.
  check("no tag is refused", await hit(""), 404);
  check("a wrong tag is refused", await hit(`?tag=${"A".repeat(43)}`), 404);
  check("a truncated tag is refused", await hit(`?tag=${tag.slice(0, -4)}`), 404);
  // Indistinguishable from an id that was never used, so sweeping learns nothing.
  check("an id that is not live answers the same way", await hit("").then(() => fetch(`${ORIGIN}/api/streams/zzzzz/route`).then((r) => r.status)), 404);
  // The legitimate viewer's position.
  check("the correct tag is accepted", await hit(`?tag=${encodeURIComponent(tag)}`), 200);

  // And the token that comes back is the short, renewable one.
  const body = await (await fetch(`${ORIGIN}/api/streams/${streamId}/route?tag=${encodeURIComponent(tag)}`)).json();
  const claims = JSON.parse(Buffer.from(body.jwt.split(".")[1], "base64url").toString());
  const ttl = claims.exp - Math.floor(Date.now() / 1000);
  check("the viewer token is short-lived", ttl > 60 && ttl <= 130, true);
  STEP(`  (token lifetime ${ttl}s)`);
} catch (e) {
  failures++;
  console.error(`\nERROR: ${e.message}`);
} finally {
  await browser.close();
}

console.log(failures ? `\nFAIL: ${failures} assertion(s)\n` : "\nPASS: /route requires proof of the link\n");
process.exit(failures ? 1 : 0);
