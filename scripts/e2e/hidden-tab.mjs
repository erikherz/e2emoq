// Does the broadcast survive the broadcaster looking at something else?
//
// Reported 2026-08-29: "i saw video briefly, then when I added location it froze and now even
// after refresh i don't see video". The location burn-in was a coincidence of timing. The real
// cause is that the compositor's draw loop was requestAnimationFrame, rAF does not fire in a
// hidden tab, and canvas.captureStream() only produces a frame when the canvas is painted.
//
// So switching tabs stopped the pictures. Everyone watching froze on the last frame while
// nothing anywhere reported a problem: the publisher stayed connected, the status light stayed
// green, and audio kept flowing because WebAudio is not rAF-driven. Opening your own share link
// in a second tab to check on your stream was enough to kill it — which is exactly what the
// person who reported it had done.
//
// Measured before the fix: rAF 60/s visible, 0/s hidden. setInterval 30/s in BOTH, because a
// page holding a live getUserMedia capture is exempt from Chrome's intensive background timer
// throttling — which is what makes the timer fallback a real one rather than 1fps of token
// effort.
//
//   node --env-file=/tmp/wf.env scripts/e2e/hidden-tab.mjs [origin]
//
// Asserts on the VIEWER, not on the broadcaster's own canvas: what matters is whether pictures
// are still arriving somewhere else, and the broadcaster's canvas can look busy while nothing
// is being published.
//
// TWO BROWSERS, and the reason is the bug itself. Only one tab per browser is in the foreground,
// and the watch page paints through rAF as well — so a viewer sharing a browser with the
// broadcaster goes blind exactly when the broadcaster comes back to the front. The first version
// of this test did that and reported "still frozen after coming back" against a build that was
// working perfectly. The broadcaster's visibility is therefore toggled with a second tab inside
// its OWN browser, while the viewer sits alone in another and stays visible throughout.

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

const ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];
const bBrowser = await puppeteer.launch({ headless: "new", args: ARGS });
const vBrowser = await puppeteer.launch({ headless: "new", args: ARGS });

// A checksum of what is actually painted, not just "is there a picture". A frozen stream is
// still a full frame of lit pixels — the whole failure is that it never CHANGES.
const SAMPLE = () => {
  const el = [...document.querySelectorAll("video,canvas")].find((e) => (e.videoWidth || e.width || 0) >= 320);
  if (!el) return null;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 36;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(el, 0, 0, 64, 36);
  const d = x.getImageData(0, 0, 64, 36).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum = (sum + d[i] * (i + 1)) >>> 0;
  return sum;
};

let eventId = null;
try {
  const bc = await bBrowser.newPage();
  bc.on("response", async (r) => {
    if (!r.url().includes("/api/stats/broadcast") || /\/end$/.test(r.url())) return;
    try { eventId = JSON.parse(await r.text()).id ?? eventId; } catch { /* a refusal */ }
  });
  await bc.goto(`${ORIGIN}/broadcast?pk=${encodeURIComponent(PK)}`, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await clearSeedGate(bc, (m) => console.log(`  -- ${m}`));
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 9000));
  const share = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
  console.log(`  -- broadcasting ${share.split("#")[0]}`);

  const vw = await vBrowser.newPage();
  await vw.goto(share, { waitUntil: "networkidle2", timeout: 60000 });
  await vw.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((e) => (e.videoWidth || e.width || 0) >= 320),
    { timeout: 45000 }
  );
  await new Promise((r) => setTimeout(r, 6000));

  // A second tab in the broadcaster's own browser — "let me check my own share link" — which is
  // all it took to stop the pictures.
  const other = await bBrowser.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  check("a second tab hides the broadcaster", await bc.evaluate(() => document.visibilityState), "hidden");

  const moving = async (page, secs) => {
    const a = await page.evaluate(SAMPLE);
    await new Promise((r) => setTimeout(r, secs * 1000));
    const b = await page.evaluate(SAMPLE);
    return { a, b, moved: a !== null && b !== null && a !== b };
  };

  const bg = await moving(vw, 6);
  console.log(`  -- viewer while the broadcaster is hidden: ${bg.a} -> ${bg.b}`);
  check("the viewer keeps receiving new pictures", bg.moved, true);

  // And it still works when the broadcaster comes back, i.e. the swap back to rAF is wired up
  // too. A fix that only ever ran the timer would pass the check above and quietly halve the
  // frame rate for every broadcaster who never switches tabs.
  await bc.bringToFront();
  check("the broadcaster is visible again", await bc.evaluate(() => document.visibilityState), "visible");
  const fg = await moving(vw, 6);
  console.log(`  -- viewer after coming back:               ${fg.a} -> ${fg.b}`);
  check("and still receiving after coming back", fg.moved, true);

  // One more round trip: the listener has to survive being toggled, not just fire once.
  await other.bringToFront();
  const bg2 = await moving(vw, 6);
  console.log(`  -- viewer on the second background:        ${bg2.a} -> ${bg2.b}`);
  check("and on the second time hidden", bg2.moved, true);

  if (!failures.length) console.log("\nPASS: a backgrounded broadcaster keeps broadcasting");
} catch (e) {
  failures.push(e.message);
  process.exitCode = 1;
} finally {
  if (eventId) {
    const r = await fetch(`${ORIGIN}/api/stats/broadcast/${eventId}/end`, { method: "POST" });
    console.log(`  cleanup: ended event ${eventId} -> HTTP ${r.status}`);
  }
  await bBrowser.close();
  await vBrowser.close();
  for (const f of failures) console.error(`\nFAIL: ${f}`);
}
