// What does the kill switch do to someone ALREADY watching?
//
// The reasoned answer was "nothing, until their session drops": the Worker is not in the
// media path, kill is enforced at /route and at go-live, and an established viewer makes no
// further requests. Erik observed the opposite while testing — he was watching, hit kill, and
// the stream stopped. One of those is wrong, and the difference decides whether this system
// can actually stop a live broadcast or only prevent new ones.
//
// So: measure. Broadcast, watch, confirm frames are flowing, kill out-of-band, then sample
// BOTH sides every few seconds. Watching only the viewer cannot distinguish "the viewer was
// cut off" from "the publisher stopped and the viewer ran dry", which are very different
// properties — the first is enforcement, the second is the publisher's client cooperating.
//
//   WF_PUBLISH_KEY=<key> node scripts/e2e/kill-live-viewer.mjs [origin]
//
// Kills via D1 directly, so it needs wrangler auth but not the admin password.

import puppeteer from "puppeteer";
import { execFileSync } from "node:child_process";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
const STEP = (m) => console.log(`  ${m}`);

const LAUNCH = {
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
};

const SAMPLE = () => {
  const els = [...document.querySelectorAll("video,canvas")]
    .map((el) => ({ el, w: el.videoWidth || el.width || 0, h: el.videoHeight || el.height || 0 }))
    .filter((m) => m.w > 0 && m.h > 0)
    .sort((a, b) => b.w * b.h - a.w * a.h);
  if (!els.length) return { ok: false, reason: "no media element" };
  const { el, w, h } = els[0];
  const c = document.createElement("canvas");
  c.width = Math.min(w, 320);
  c.height = Math.min(h, 180);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  try { ctx.drawImage(el, 0, 0, c.width, c.height); } catch (e) { return { ok: false, reason: e.message }; }
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let sum = 0, lit = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i] + data[i + 1] + data[i + 2];
    sum = (sum + v * (i + 1)) >>> 0;
    if (v > 30) lit++;
  }
  return { ok: true, w, h, sum, lit, total: data.length / 4 };
};

const d1 = (sql) =>
  execFileSync("npx", ["wrangler", "d1", "execute", "e2emoq-db", "--remote", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const browser = await puppeteer.launch(LAUNCH);
let verdict = "inconclusive";

try {
  // ── Broadcast ──────────────────────────────────────────────────────────────────────────
  const bc = await browser.newPage();
  await bc.goto(`${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`, {
    waitUntil: "networkidle2", timeout: 60000,
  });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  const streamId = await bc.evaluate(() => new URLSearchParams(location.search).get("stream"));
  STEP(`broadcasting ${streamId}`);

  await bc.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 320),
    { timeout: 45000 }
  );
  const shareUrl = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
  if (!/#k=/.test(shareUrl)) throw new Error("share link carries no key");

  await new Promise((r) => setTimeout(r, 5000));

  // ── Watch ──────────────────────────────────────────────────────────────────────────────
  const ctx = await browser.createBrowserContext();
  const vw = await ctx.newPage();
  await vw.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await vw.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 640),
    { timeout: 60000 }
  );
  await vw.waitForFunction(
    () => {
      const el = [...document.querySelectorAll("video,canvas")]
        .filter((e) => (e.videoWidth || e.width || 0) >= 640)[0];
      if (!el) return false;
      const c = document.createElement("canvas");
      c.width = 64; c.height = 36;
      const x = c.getContext("2d", { willReadFrequently: true });
      try { x.drawImage(el, 0, 0, 64, 36); } catch { return false; }
      const d = x.getImageData(0, 0, 64, 36).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
      return lit > (d.length / 4) * 0.05;
    },
    { timeout: 60000, polling: 500 }
  );

  const before1 = await vw.evaluate(SAMPLE);
  await new Promise((r) => setTimeout(r, 3000));
  const before2 = await vw.evaluate(SAMPLE);
  STEP(`viewer decoding: lit=${before2.lit}/${before2.total} moving=${before1.sum !== before2.sum}`);
  if (before1.sum === before2.sum) throw new Error("viewer was not actually receiving frames before the kill");

  // ── Kill, out of band ──────────────────────────────────────────────────────────────────
  STEP(`killing ${streamId} via D1 …`);
  d1(`UPDATE stream_salts SET killed_at = datetime('now'), salt = 'killed-by-experiment' WHERE stream_id = '${streamId}'`);
  const killedAt = Date.now();

  // ── Watch both sides for a minute ──────────────────────────────────────────────────────
  STEP("");
  STEP("   t     viewer                        broadcaster");
  let viewerStoppedAt = null;
  let publisherStoppedAt = null;
  let prevV = before2, prevB = await bc.evaluate(SAMPLE);

  for (let t = 5; t <= 60; t += 5) {
    await new Promise((r) => setTimeout(r, 5000));
    const v = await vw.evaluate(SAMPLE);
    const b = await bc.evaluate(SAMPLE);

    const vMoving = v.ok && prevV.ok && v.sum !== prevV.sum;
    const bMoving = b.ok && prevB.ok && b.sum !== prevB.sum;
    const vLit = v.ok ? `lit=${v.lit}/${v.total}` : `gone (${v.reason})`;
    const bLit = b.ok ? `lit=${b.lit}/${b.total}` : `gone (${b.reason})`;

    STEP(`  ${String(t).padStart(2)}s   ${(vLit + (vMoving ? " moving" : " stopped")).padEnd(32)}${bLit}${bMoving ? " moving" : " stopped"}`);

    if (!viewerStoppedAt && !vMoving) viewerStoppedAt = t;
    if (!publisherStoppedAt && !bMoving) publisherStoppedAt = t;
    prevV = v; prevB = b;
    if (viewerStoppedAt && publisherStoppedAt) break;
  }

  // ── What the viewer's page believes ────────────────────────────────────────────────────
  const viewerState = await vw.evaluate(() => ({
    url: location.href.split("#")[0],
    terminatedMessage: /terminated|has been stopped/i.test(document.body.innerText),
    bodyStart: document.body.innerText.slice(0, 160).replace(/\s+/g, " "),
  }));

  console.log("");
  STEP(`viewer stopped:      ${viewerStoppedAt ? `${viewerStoppedAt}s after kill` : "still playing after 60s"}`);
  STEP(`broadcaster stopped: ${publisherStoppedAt ? `${publisherStoppedAt}s after kill` : "still capturing after 60s"}`);
  STEP(`viewer page says:    ${viewerState.terminatedMessage ? "shows a terminated message" : "no terminated message"}`);
  STEP(`viewer text:         "${viewerState.bodyStart}"`);

  console.log("");
  // The terminated message is the discriminator, and the reason it is worth rendering at all.
  // Media going quiet is ambiguous — a viewer that merely ran dry because the publisher
  // stopped looks identical at the pixel level to one that acted on the kill itself. Only the
  // viewer's own page can say which happened, and it can only say so if it noticed.
  if (!viewerStoppedAt) {
    verdict = "FAIL — viewer kept watching; kill does not reach an established viewer";
    process.exitCode = 1;
  } else if (!viewerState.terminatedMessage) {
    verdict = `AMBIGUOUS — viewer went quiet at ${viewerStoppedAt}s but never said it was terminated, so it probably just ran dry`;
    process.exitCode = 1;
  } else if (!publisherStoppedAt) {
    verdict = `PARTIAL — the viewer stopped and knows why, but the PUBLISHER is still sending after 60s`;
    process.exitCode = 1;
  } else {
    verdict =
      `PASS — viewer stopped at ${viewerStoppedAt}s and shows the terminated message (it acted on the kill, ` +
      `not on silence); publisher stopped at ${publisherStoppedAt}s, so the source is off too`;
  }
  console.log(`VERDICT: ${verdict}\n`);

  // Leave nothing killed behind; this ran against production.
  d1(`UPDATE stream_salts SET killed_at = NULL WHERE stream_id = '${streamId}'`);
} catch (e) {
  console.error(`\nERROR: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
