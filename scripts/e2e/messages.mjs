// Video messages: a viewer records one, the broadcaster puts it on screen, and nobody without
// the link can do either.
//
//   node scripts/e2e/messages.mjs [origin]        # default: https://e2emoq.com
//
// Asserts, in order:
//   1. The send button is HIDDEN until the broadcaster opts in — it is off by default and the
//      viewer should not see an invitation that would be refused.
//   2. A viewer can record and send, and the broadcaster's inbox shows it.
//   3. "Show" composites it: the lower-left of the broadcaster's canvas, which was the
//      background a moment earlier, is now carrying different pixels.
//   4. NEGATIVE — the API refuses a wrong route tag for both submit and read, with the same
//      404 a non-existent stream gets.
//
// Exit 0 = pass. Exit 1 = fail, with the reason on stderr.

import puppeteer from "puppeteer";
import { clearSeedGate } from "./lib/seed-gate.mjs";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
const STEP = (m) => console.log(`  ${m}`);
const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exitCode = 1;
};

const LAUNCH = {
  headless: "new",
  protocolTimeout: 180000,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
};

// Sample a rectangle of a canvas, so "did the PiP appear" is a question about the corner the
// message is drawn in rather than about the whole frame, which is moving anyway.
const SAMPLE_RECT = (sel, fx, fy, fw, fh) => {
  const c = document.querySelector(sel);
  if (!c || !c.width) return null;
  const p = document.createElement("canvas");
  p.width = 40;
  p.height = 30;
  const x = p.getContext("2d", { willReadFrequently: true });
  try {
    x.drawImage(c, c.width * fx, c.height * fy, c.width * fw, c.height * fh, 0, 0, 40, 30);
  } catch {
    return null;
  }
  const d = x.getImageData(0, 0, 40, 30).data;
  let sum = 0;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] + d[i + 1] + d[i + 2];
    sum = (sum + v * (i + 1)) >>> 0;
    if (v > 30) lit++;
  }
  return { sum, lit };
};

const browser = await puppeteer.launch(LAUNCH);

try {
  // ── broadcaster goes live ──────────────────────────────────────────────────────
  const bc = await browser.newPage();
  bc.on("pageerror", (e) => console.log(`     [bc pageerror] ${e.message}`));
  STEP(`opening ${ORIGIN}/broadcast`);
  await bc.goto(`${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000, polling: 500 });
  await clearSeedGate(bc, STEP);
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(
    () => document.querySelector("[data-share-url]")?.getAttribute("data-share-url")?.includes("#k="),
    { timeout: 40000, polling: 500 }
  );
  const shareUrl = await bc.$eval("[data-share-url]", (e) => e.getAttribute("data-share-url"));
  const streamId = new URL(shareUrl).pathname.replace(/^\//, "");
  STEP(`live: ${streamId}`);

  // ── 1. the button is hidden before opt-in ──────────────────────────────────────
  const vw = await browser.newPage();
  vw.on("pageerror", (e) => console.log(`     [vw pageerror] ${e.message}`));
  await vw.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await vw.waitForFunction(
    () => [...document.querySelectorAll("canvas")].some((c) => c.width >= 320),
    { timeout: 45000, polling: 500 }
  );
  const hiddenFirst = await vw.evaluate(
    () => document.getElementById("msg-send-btn")?.classList.contains("hidden") !== false
  );
  if (hiddenFirst) STEP("send button hidden before the broadcaster opts in");
  else fail("the send button was offered while messages were still disabled");
  await vw.close();

  // ── broadcaster opts in ────────────────────────────────────────────────────────
  await bc.waitForSelector("#msg-enable", { timeout: 20000, polling: 500 });
  await bc.evaluate(() => {
    const el = document.getElementById("msg-enable");
    el.scrollIntoView({ block: "center" });
    el.click();
  });
  await bc.waitForFunction(() => document.getElementById("msg-enable")?.checked === true, {
    timeout: 15000,
  });
  await new Promise((r) => setTimeout(r, 2500));

  // ── 2. viewer records and sends ────────────────────────────────────────────────
  const vw2 = await browser.newPage();
  vw2.on("pageerror", (e) => console.log(`     [vw2 pageerror] ${e.message}`));
  await vw2.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await vw2.waitForFunction(
    () => document.getElementById("msg-send-btn")?.classList.contains("hidden") === false,
    { timeout: 45000, polling: 500 }
  );
  STEP("send button appeared after opt-in");

  await vw2.click("#msg-send-btn");
  await vw2.waitForSelector("#msg-record", { visible: true, timeout: 10000 });
  await vw2.click("#msg-record");
  await new Promise((r) => setTimeout(r, 4000));
  await vw2.click("#msg-record"); // stop early
  await vw2.waitForFunction(() => document.getElementById("msg-submit")?.disabled === false, {
    timeout: 20000,
  });
  STEP("recorded and previewed");
  await vw2.click("#msg-submit");
  try {
    await vw2.waitForFunction(
      () => /Message sent/.test(document.getElementById("rec-status")?.textContent || ""),
      { timeout: 30000, polling: 500 }
    );
    STEP("message sent");
  } catch {
    // submitMessage reports its failure into the compose timer, not the watch status line, so
    // a bare timeout here says nothing about WHY. Read both before giving up.
    const why = await vw2.evaluate(() => ({
      timer: document.getElementById("msg-timer")?.textContent || "",
      status: document.getElementById("rec-status")?.textContent || "",
    }));
    throw new Error(`send did not confirm — timer=${JSON.stringify(why.timer)} status=${JSON.stringify(why.status)}`);
  }

  // ── 3. broadcaster sees it and shows it ────────────────────────────────────────
  try {
    await bc.waitForFunction(() => document.querySelectorAll("#msg-list .msg-row").length > 0, {
      timeout: 45000,
      polling: 500,
    });
    STEP("inbox shows the message");
  } catch {
    // The inbox polls with a tag it derives itself. If that tag is wrong the list 404s
    // silently and the UI just stays empty, so ask the page what it actually got.
    const why = await bc.evaluate(async (id) => {
      const el = document.getElementById("msg-enable");
      const probe = await fetch(`/api/streams/${id}/messages?tag=BAD`);
      return {
        enabled: el?.checked,
        count: document.getElementById("msg-count")?.textContent || "",
        rows: document.querySelectorAll("#msg-list .msg-row").length,
        badTagStatus: probe.status,
      };
    }, streamId);
    throw new Error(`inbox never listed it — ${JSON.stringify(why)}`);
  }

  const before = await bc.evaluate(SAMPLE_RECT, "moq-publish canvas, #publish-preview, canvas", 0.02, 0.55, 0.44, 0.42);
  await bc.evaluate(() => document.querySelector("#msg-list .msg-row button")?.click());
  await new Promise((r) => setTimeout(r, 4000));
  const after = await bc.evaluate(SAMPLE_RECT, "moq-publish canvas, #publish-preview, canvas", 0.02, 0.55, 0.44, 0.42);

  if (!before || !after) {
    fail("could not sample the broadcaster's composite canvas");
  } else if (before.sum === after.sum) {
    fail("the lower-left of the composite is unchanged — the message was not drawn in");
  } else {
    STEP(`message composited (corner checksum ${before.sum} -> ${after.sum})`);
  }

  // ── 4. NEGATIVE: the API refuses a wrong tag ───────────────────────────────────
  const probe = await bc.evaluate(async (id) => {
    const post = await fetch(`/api/streams/${id}/messages?tag=wrong`, {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });
    const get = await fetch(`/api/streams/${id}/messages?tag=wrong`);
    const none = await fetch(`/api/streams/${id}/messages`);
    return { post: post.status, get: get.status, none: none.status };
  }, streamId);
  if (probe.post === 404 && probe.get === 404 && probe.none === 404) {
    STEP("wrong and missing route tags both refused with 404");
  } else {
    fail(`the API answered a wrong tag: ${JSON.stringify(probe)}`);
  }

  await bc.close();
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
}

console.log(process.exitCode ? "\nmessages: FAILED" : "\nmessages: PASS");
