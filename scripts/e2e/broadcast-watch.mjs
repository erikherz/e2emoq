// End-to-end proof that a broadcast actually reaches a viewer and decodes.
//
// This is the deploy gate for the Earthseed privacy port. A typecheck and a clean
// `wrangler deploy` say nothing about whether media still flows — especially while the
// encryption path is being rewritten — so nothing ships unless this passes.
//
//   node scripts/e2e/broadcast-watch.mjs [origin]        # default: https://e2emoq.com
//
// What it proves, in order:
//   1. /broadcast mints a stream id and the page goes live with a camera source.
//   2. A second, independent browser context can open /<id> and gets a media element
//      with real dimensions (not the 300x150 default a blank canvas reports).
//   3. Pixels are non-black AND change between two samples — i.e. frames are being
//      decoded continuously, not painted once. A still frame passes a "has pixels" test
//      but means the stream stalled after the first keyframe.
//
// Exit 0 = pass. Exit 1 = fail, with the reason on stderr.

import puppeteer from "puppeteer";
import { clearSeedGate } from "./lib/seed-gate.mjs";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");

// Broadcasting requires the admission credential. Passed via ?pk= (which the page then
// remembers) so the test does not need a pre-seeded browser profile.
const PK = process.env.WF_PUBLISH_KEY || "";
const BROADCAST_URL = `${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`;
const STEP = (m) => console.log(`  ${m}`);
const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exitCode = 1;
};

// Chrome's fake video device renders a moving pattern, so consecutive samples differ
// while frames flow and stop differing the moment they don't.
const LAUNCH = {
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
};

// Sample the largest visible <video>/<canvas>: dimensions, a cheap checksum, and how many
// pixels are meaningfully non-black.
const SAMPLE = () => {
  const els = [...document.querySelectorAll("video,canvas")]
    .map((el) => ({ el, w: el.videoWidth || el.width || 0, h: el.videoHeight || el.height || 0 }))
    .filter((m) => m.w > 0 && m.h > 0)
    .sort((a, b) => b.w * b.h - a.w * a.h);
  if (!els.length) return { ok: false, reason: "no media element with dimensions" };

  const { el, w, h } = els[0];
  const c = document.createElement("canvas");
  c.width = Math.min(w, 320);
  c.height = Math.min(h, 180);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  try {
    ctx.drawImage(el, 0, 0, c.width, c.height);
  } catch (e) {
    return { ok: false, reason: `drawImage failed: ${e.message}` };
  }
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let sum = 0;
  let lit = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i] + data[i + 1] + data[i + 2];
    sum = (sum + v * (i + 1)) >>> 0;
    if (v > 30) lit++;
  }
  return { ok: true, tag: el.tagName.toLowerCase(), w, h, sum, lit, total: data.length / 4 };
};

const browser = await puppeteer.launch(LAUNCH);
const errors = [];

try {
  // ── 1. Broadcast ────────────────────────────────────────────────────────────────
  const bc = await browser.newPage();
  bc.on("pageerror", (e) => errors.push(`broadcast pageerror: ${e.message}`));
  bc.on("console", (m) => {
    if (m.type() === "error") errors.push(`broadcast console: ${m.text()}`);
  });
  bc.on("requestfailed", (r) => errors.push(`broadcast netfail: ${r.url()} ${r.failure()?.errorText}`));
  bc.on("response", (r) => {
    if (r.status() >= 400) errors.push(`broadcast http ${r.status()}: ${r.url()}`);
  });

  STEP(`opening ${ORIGIN}/broadcast`);
  await bc.goto(BROADCAST_URL, { waitUntil: "networkidle2", timeout: 60000 });

  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await clearSeedGate(bc, STEP);
  await bc.click('button.publish-btn[title="Camera"]');
  STEP("camera enabled — waiting for go-live");

  // The URL carries the id as soon as the route resolves; the publisher needs a moment
  // more to assign a relay and bind tracks.
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  const streamId = await bc.evaluate(() => new URLSearchParams(location.search).get("stream"));
  STEP(`stream id: ${streamId}`);

  // Confirm the broadcaster is genuinely capturing before asking a viewer to watch —
  // otherwise a viewer failure is ambiguous between "publish broke" and "watch broke".
  await bc.waitForFunction(
    () =>
      [...document.querySelectorAll("video,canvas")].some(
        (el) => (el.videoWidth || el.width || 0) >= 320
      ),
    { timeout: 45000 }
  );
  const pub = await bc.evaluate(SAMPLE);
  if (!pub.ok) throw new Error(`broadcaster preview never rendered: ${pub.reason}`);
  STEP(`broadcaster preview ${pub.w}x${pub.h} (${pub.tag})`);

  // Take the share link the way a broadcaster does — from the copy button — rather than
  // rebuilding it. The link now carries the content key in its `#k=` fragment, so a
  // reconstructed URL would be undecryptable and this would test the wrong thing.
  const shareUrl = await bc.evaluate(
    () => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? ""
  );
  if (!/#k=/.test(shareUrl)) throw new Error(`share link carries no #k= secret: ${shareUrl}`);
  STEP(`share link carries a key (${shareUrl.split("#")[0]}#k=…)`);

  // Whether there is a passcode is now the broadcaster's choice (Protect, opt-in since
  // 2026-08-28), so this follows the link rather than assuming either answer.
  //
  // The reason it asserts at all: this test silently stopped proving anything the day the
  // passcode became mandatory. The viewer sat on the prompt until the 60s timeout and
  // reported "never decoded", which reads exactly like a broken relay. So the invariant is
  // that the link and the viewer AGREE — a link that signals p=1 must yield a passcode and a
  // prompt, and a link that does not must yield no prompt at all. Either mismatch is the
  // failure that cost a rollback, and either one now fails here by name.
  const wantsPasscode = /[#&]p=1/.test(shareUrl);
  let passcode = "";
  if (wantsPasscode) {
    await bc.waitForFunction(
      () => (document.getElementById("passcode-value")?.textContent || "").length === 8,
      { timeout: 30000 }
    );
    passcode = await bc.evaluate(() => document.getElementById("passcode-value")?.textContent || "");
    STEP(`passcode ${passcode}`);
  } else {
    STEP("no passcode on this link (Protect off) — the viewer must not be prompted");
  }

  // Give the relay a beat to accept the first group before a viewer subscribes.
  await new Promise((r) => setTimeout(r, 5000));

  // ── 2. Watch, from a separate context so no state is shared ─────────────────────
  const ctx = await browser.createBrowserContext();
  const vw = await ctx.newPage();
  vw.on("pageerror", (e) => errors.push(`watch pageerror: ${e.message}`));
  vw.on("console", (m) => {
    if (m.type() === "error") errors.push(`watch console: ${m.text()}`);
  });

  STEP(`opening the share link as a viewer`);
  await vw.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });

  // Hand over the second half of the secret. Without this the viewer never subscribes at all,
  // and every check below would be measuring a passcode prompt.
  if (wantsPasscode) {
    await vw.waitForSelector("#passcode-entry", { timeout: 30000 });
    await vw.type("#passcode-entry", passcode);
    await vw.click("#passcode-go");
    STEP("passcode entered");
  } else {
    // The other half of the agreement. A prompt here means the link under-declared what it
    // needs, and everything below would time out looking like a dead relay instead.
    await new Promise((r) => setTimeout(r, 3000));
    const prompted = await vw.$("#passcode-entry");
    if (prompted) throw new Error("viewer was asked for a passcode the share link did not signal");
  }

  // 640 rather than >0: a blank <canvas> reports 300x150 and would pass a naive check.
  await vw.waitForFunction(
    () =>
      [...document.querySelectorAll("video,canvas")].some(
        (el) => (el.videoWidth || el.width || 0) >= 640
      ),
    { timeout: 60000 }
  );

  // Wait for the FIRST decoded frame before timing anything. Sampling straight away
  // catches a still-black canvas, and "black then lit" would satisfy a naive
  // frames-differ check while actually proving only that decoding started once.
  await vw.waitForFunction(
    () => {
      const el = [...document.querySelectorAll("video,canvas")]
        .filter((e) => (e.videoWidth || e.width || 0) >= 640)
        .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
      if (!el) return false;
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 36;
      const x = c.getContext("2d", { willReadFrequently: true });
      try { x.drawImage(el, 0, 0, 64, 36); } catch { return false; }
      const d = x.getImageData(0, 0, 64, 36).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
      return lit > (d.length / 4) * 0.05;
    },
    { timeout: 60000, polling: 500 }
  );

  // Both samples now come from a stream already decoding, so a difference between them
  // means frames are still arriving — not merely that one arrived.
  const a = await vw.evaluate(SAMPLE);
  if (!a.ok) throw new Error(`viewer has no drawable media: ${a.reason}`);
  await new Promise((r) => setTimeout(r, 3000));
  const b = await vw.evaluate(SAMPLE);
  if (!b.ok) throw new Error(`viewer media went away: ${b.reason}`);

  STEP(`viewer ${a.w}x${a.h} (${a.tag}) — first frame decoded`);
  STEP(`sample 1: lit=${a.lit}/${a.total} sum=${a.sum}`);
  STEP(`sample 2: lit=${b.lit}/${b.total} sum=${b.sum}`);

  // The report control is the only abuse sensor there is: we cannot see the stream, so if a
  // viewer has no way to tell us, we learn about a problem from outside or not at all.
  // Asserted here rather than in its own script because it has to be present on a REAL
  // playing stream — it mounts as part of the watch path, where a silent failure is invisible.
  const reportUi = await vw.evaluate(() => {
    const btn = document.querySelector(".watch-report-btn");
    if (!btn) return { ok: false, reason: "no report control on the watch page" };
    btn.click();
    const opened = [...document.querySelectorAll("h2")].some((h) => /report this stream/i.test(h.textContent));
    if (!opened) return { ok: false, reason: "the report control does not open a dialog" };
    // Nothing may pre-fill the viewer's link: handing over a key must be a deliberate act.
    // Visibility, not existence — the input is always in the DOM and its ROW is what the
    // server's config reveals, so testing for the element would report "offered" either way.
    const box = document.querySelector("#report-evidence");
    const row = document.querySelector("#report-evidence-row");
    const shown = !!row && getComputedStyle(row).display !== "none";
    return { ok: true, offered: shown, prechecked: !!box?.checked };
  });
  if (!reportUi.ok) fail(reportUi.reason);
  else if (reportUi.prechecked) fail("the evidence-link box is pre-ticked — a key would leave by default");
  else STEP(`report control present (evidence link ${reportUi.offered ? "offered, unticked" : "not offered"})`);

  // ── 3. Verdict ──────────────────────────────────────────────────────────────────
  const litEnough = b.lit > b.total * 0.05;
  const moving = a.sum !== b.sum;

  if (!litEnough) fail(`viewer canvas went black (lit=${b.lit}/${b.total}) — decode stopped`);
  else if (!moving) fail("viewer frames are frozen (identical samples) — stream stalled mid-decode");
  else console.log(`\nPASS: ${streamId} decoded live at ${b.w}x${b.h} on ${ORIGIN}`);
} catch (e) {
  fail(e.message);
} finally {
  if (errors.length) {
    console.error(`\n--- page errors (${errors.length}) ---`);
    console.error([...new Set(errors)].slice(0, 15).join("\n"));
  }
  await browser.close();
}
