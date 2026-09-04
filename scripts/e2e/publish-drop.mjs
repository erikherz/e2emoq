// When the publish dies under a live broadcast, is the broadcaster told?
//
// This is the failure that made two separate reports on 2026-08-29 read as "it froze" with no
// explanation available anywhere. The publish can stop while everything a broadcaster looks at
// keeps saying it is fine:
//
//   - the preview keeps moving, because it is drawn locally from the camera and never touches
//     the relay;
//   - the Server Status card keeps the answer it was handed at go-live and is never revisited,
//     so it read "Connected: cdn.moq.pro" for two and a half minutes after the relay had
//     dropped the publisher;
//   - the only thing that changed was a status emoji, 🟢 to ⚪, in the corner of a control bar.
//
// Provoked here by taking the broadcaster's network away, which is the one cause that can be
// produced on demand. The point is not the cause — it is that ANY loss of the publish has to
// say so, because the broadcaster cannot see it from anything else on the page.
//
//   node --env-file=/tmp/wf.env scripts/e2e/publish-drop.mjs [origin]
//
// THIS TEST CURRENTLY FAILS, ON PURPOSE. It is a reproduction of an open bug, not a guard on a
// fix, and it is deliberately not wired into any npm script.
//
// The first attempt at a fix watched publisher.connection.status and warned when it left
// "connected". Measured against production with the network switched off by CDP, that signal
// reads "connected" for at least 90 seconds — and every other field on the connection object
// (enabled, established, announced, signals.abort.aborted) is byte-identical 25 seconds after
// the network is gone. The moq client simply does not notice, so there is nothing on the page
// to hang a warning on. The attempt was reverted rather than shipped as a warning that could
// never fire.
//
// Closing this needs a liveness check we own: something that asks whether the relay still sees
// this broadcast announced, and says so when the answer turns to no.

import puppeteer from "puppeteer";
import { clearSeedGate } from "./lib/seed-gate.mjs";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY;
if (!PK) throw new Error("WF_PUBLISH_KEY not set");

const failures = [];
const check = (label, got, want) => {
  const ok = want instanceof RegExp ? want.test(String(got)) : got === want;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${want})`}`);
  if (!ok) {
    failures.push(label);
    process.exitCode = 1;
  }
};

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const state = (page) =>
  page.evaluate(() => ({
    notice: (() => {
      const n = document.querySelector(".capture-notice");
      return n && !n.classList.contains("hidden") ? (n.textContent || "").trim() : "";
    })(),
    dot: document.querySelector(".publish-status")?.getAttribute("data-status-text") || "",
    panel: (document.querySelector("#server-panel .server-status-summary")?.textContent || "")
      .replace(/\s+/g, " ").trim(),
    cameraOn: !!document.querySelector('button.publish-btn[title="Camera"]')?.classList.contains("toggle-on"),
  }));

let eventId = null;
try {
  const bc = await browser.newPage();
  bc.on("response", async (r) => {
    if (!r.url().includes("/api/stats/broadcast") || /\/end$/.test(r.url())) return;
    try { eventId = JSON.parse(await r.text()).id ?? eventId; } catch { /* refusal */ }
  });
  await bc.goto(`${ORIGIN}/broadcast?pk=${encodeURIComponent(PK)}`, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await clearSeedGate(bc, (m) => console.log(`  -- ${m}`));
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });

  await bc.waitForFunction(
    () => document.querySelector(".publish-status")?.getAttribute("data-status-text") === "Live",
    { timeout: 45000 }
  );
  const live = await state(bc);
  console.log(`  -- live: dot=${live.dot} panel="${live.panel}"`);
  check("nothing is being complained about while it works", live.notice, "");

  // Take the network away. The publish cannot survive this, and unlike the causes seen in the
  // wild it happens on command.
  const cdp = await bc.createCDPSession();
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  console.log("  -- broadcaster is offline now");

  await bc.waitForFunction(
    () => {
      const n = document.querySelector(".capture-notice");
      return !!n && !n.classList.contains("hidden") && (n.textContent || "").length > 0;
    },
    { timeout: 60000, polling: 500 }
  ).catch(() => {});

  const dropped = await state(bc);
  console.log(`  -- after the drop: dot=${dropped.dot} panel="${dropped.panel}"`);
  console.log(`  -- notice: "${dropped.notice}"`);

  check("the camera is still on, so this is not an ordinary stop", dropped.cameraOn, true);
  check("something on screen says the publish is gone", dropped.notice.length > 0, true);
  check("and it says viewers are getting nothing", dropped.notice, /nobody watching|not receiving/i);
  check("the Server Status card stops claiming Connected", dropped.panel, /disconnected/i);

  if (!failures.length) console.log("\nPASS: a dropped publish reports itself");
} catch (e) {
  failures.push(e.message);
  process.exitCode = 1;
} finally {
  if (eventId) {
    const r = await fetch(`${ORIGIN}/api/stats/broadcast/${eventId}/end`, { method: "POST" });
    console.log(`  cleanup: ended event ${eventId} -> HTTP ${r.status}`);
  }
  await browser.close();
  for (const f of failures) console.error(`\nFAIL: ${f}`);
}
