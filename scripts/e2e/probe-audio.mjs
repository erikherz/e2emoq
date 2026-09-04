// Introspect a real <moq-watch> in a real browser, instead of inferring its shape from
// minified source. Answers one question: is `backend.audio.context` actually reachable, and
// does it hold an AudioContext?
//
//   node probe-audio.mjs "<watch url with #k=...>"

import puppeteer from "puppeteer";

const url = process.argv[2];
if (!url) {
  console.error("usage: node probe-audio.mjs <watch-url>");
  process.exit(1);
}

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
});
const page = await browser.newPage();
page.on("console", (m) => console.log(`  [console] ${m.type()}: ${m.text()}`.slice(0, 300)));
page.on("pageerror", (e) => console.log(`  [pageerror] ${String(e).slice(0, 300)}`));

console.log(`\nloading ${url}\n`);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(12000);

const report = await page.evaluate(() => {
  const el = document.querySelector("moq-watch");
  if (!el) return { found: false };
  const b = el.backend;
  const shape = (o) => (o ? Object.keys(o).slice(0, 20) : null);
  let ctx = null, ctxErr = null;
  try {
    ctx = b?.audio?.context?.peek?.();
  } catch (e) {
    ctxErr = String(e);
  }
  return {
    found: true,
    muted: el.muted,
    hasBackend: !!b,
    backendKeys: shape(b),
    audioKeys: shape(b?.audio),
    audioContextSignalType: typeof b?.audio?.context,
    contextPeekIsFn: typeof b?.audio?.context?.peek,
    ctxPresent: !!ctx,
    ctxState: ctx?.state ?? null,
    ctxErr,
    canvasSize: (() => {
      const c = el.querySelector("canvas");
      return c ? `${c.width}x${c.height}` : null;
    })(),
  };
});

console.log("\n--- probe ---");
console.log(JSON.stringify(report, null, 2));
await browser.close();
