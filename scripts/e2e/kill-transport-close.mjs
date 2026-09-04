// When an honest viewer is stopped by the kill switch, does the MEDIA actually stop arriving,
// or does the page merely stop showing it?
//
// The distinction matters. stopForKill() removes <moq-watch>, which certainly ends the
// display. If the underlying WebTransport session survives that, then "terminated" is a
// statement about the UI rather than about the connection — the bytes would still be flowing
// to a browser that has been told to look away, and anyone able to run devtools could keep
// watching a stream we said we had stopped.
//
// Instruments WebTransport before the page loads and inspects whether each session's `closed`
// promise settles after the kill.
//
//   WF_PUBLISH_KEY=<key> node scripts/e2e/kill-transport-close.mjs [origin]

import puppeteer from "puppeteer";
import { execFileSync } from "node:child_process";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
const STEP = (m) => console.log(`  ${m}`);

const d1 = (sql) =>
  execFileSync("npx", ["wrangler", "d1", "execute", "e2emoq-db", "--remote", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

let streamId = null;

try {
  const bc = await browser.newPage();
  await bc.goto(`${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  streamId = await bc.evaluate(() => new URLSearchParams(location.search).get("stream"));
  await bc.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 320),
    { timeout: 45000 }
  );
  const shareUrl = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
  STEP(`broadcasting ${streamId}`);
  await new Promise((r) => setTimeout(r, 5000));

  const ctx = await browser.createBrowserContext();
  const vw = await ctx.newPage();

  // Wrap WebTransport before any page script runs, and record when each session closes.
  await vw.evaluateOnNewDocument(() => {
    window.__sessions = [];
    const Real = window.WebTransport;
    if (!Real) return;
    window.WebTransport = function (...args) {
      const t = new Real(...args);
      const rec = { url: String(args[0]), openedAt: performance.now(), closedAt: null };
      window.__sessions.push(rec);
      t.closed
        .then(() => { rec.closedAt = performance.now(); })
        .catch(() => { rec.closedAt = performance.now(); });
      return t;
    };
    window.WebTransport.prototype = Real.prototype;
  });

  await vw.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await vw.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 640),
    { timeout: 60000 }
  );
  await new Promise((r) => setTimeout(r, 4000));

  const before = await vw.evaluate(() => ({
    sessions: window.__sessions?.length ?? 0,
    open: (window.__sessions ?? []).filter((s) => s.closedAt === null).length,
    hasPlayer: !!document.querySelector("moq-watch"),
  }));
  STEP(`watching: ${before.sessions} WebTransport session(s), ${before.open} open`);
  if (!before.sessions) {
    throw new Error("no WebTransport sessions recorded — this build may be on the WebSocket fallback, so this test cannot measure anything");
  }

  // ── Kill, and let the cooperative path do its thing ────────────────────────────────────
  d1(`UPDATE stream_salts SET killed_at = datetime('now'), salt = 'killed-by-transport-test' WHERE stream_id = '${streamId}'`);
  STEP("killed — waiting for the page to react");

  await vw.waitForFunction(() => !document.querySelector("moq-watch"), { timeout: 20000 })
    .catch(() => { throw new Error("the player element was never removed — the cooperative teardown did not run"); });

  // Give the transport a moment to close after the element went away.
  await new Promise((r) => setTimeout(r, 5000));

  const after = await vw.evaluate(() => ({
    sessions: window.__sessions.length,
    open: window.__sessions.filter((s) => s.closedAt === null).length,
    closed: window.__sessions.filter((s) => s.closedAt !== null).length,
    hasPlayer: !!document.querySelector("moq-watch"),
    terminatedShown: /terminated/i.test(document.body.innerText),
  }));

  console.log("");
  STEP(`player element removed:     ${!after.hasPlayer}`);
  STEP(`terminated message shown:   ${after.terminatedShown}`);
  STEP(`WebTransport sessions:      ${after.sessions} total, ${after.closed} closed, ${after.open} still open`);
  console.log("");

  if (after.open > 0) {
    console.log(
      `VERDICT: DISPLAY ONLY — the page stopped showing the stream but ${after.open} transport\n` +
      `         session(s) are still open. Media may still be arriving at a browser that has\n` +
      `         merely been told to look away. Termination is cosmetic at the transport layer;\n` +
      `         only token expiry actually severs it.\n`
    );
    process.exitCode = 1;
  } else {
    console.log(
      `VERDICT: FULLY SEVERED — the player was removed AND every transport session closed.\n` +
      `         An honest viewer stops receiving the media, not just rendering it.\n`
    );
  }
} catch (e) {
  console.error(`\nERROR: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  if (streamId) {
    try { d1(`UPDATE stream_salts SET killed_at = NULL, note = NULL WHERE stream_id = '${streamId}'`); } catch { /* best effort */ }
  }
  await browser.close();
}
