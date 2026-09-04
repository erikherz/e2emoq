/**
 * Open a live share link as a real viewer and report what actually happens.
 *
 * Captures the client's own console, then asks the DOM the only question that matters: is the
 * player's canvas PAINTING? A connection that stays up and a canvas that stays black are
 * different failures with the same description ("no video"), and the console alone does not
 * separate them.
 *
 *   node scripts/e2e/watch-probe.mjs 'https://e2emoq.com/<id>#k=<key>'
 *
 * The URL contains the content key, so it is never echoed back — only the stream id is printed.
 */
import puppeteer from "puppeteer";

const URL_ = process.argv[2];
if (!URL_) { console.log("usage: watch-probe.mjs <share link>"); process.exit(1); }
const streamId = new URL(URL_).pathname.replace(/^\//, "");
console.log(`watching ${streamId} (key withheld)\n`);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();

const lines = [];
page.on("console", (m) => {
  const t = m.text();
  // The key rides in the connect URL the client logs; keep it out of this transcript.
  lines.push(`${m.type().padEnd(7)} ${t.replace(/jwt=[\w.-]+/g, "jwt=<redacted>").slice(0, 220)}`);
});
page.on("pageerror", (e) => lines.push(`pageerr ${String(e.message).slice(0, 220)}`));

// Network failures, which the console only ever summarises as "404 ()" with no URL — the one
// piece of information needed to act on it.
page.on("response", (r) => {
  if (r.status() >= 400) lines.push(`HTTP${r.status()} ${r.url().replace(/jwt=[\w.-]+/g, "jwt=<redacted>").slice(0, 200)}`);
});
page.on("requestfailed", (r) => lines.push(`REQFAIL ${r.url().slice(0, 160)} ${r.failure()?.errorText ?? ""}`));

await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise((r) => setTimeout(r, 20000));

const state = await page.evaluate(() => {
  const canvas = document.querySelector("moq-watch canvas");
  let painting = null, size = null, spread = null;
  if (canvas) {
    size = `${canvas.width}x${canvas.height}`;
    try {
      // Sample the frame. A canvas that has never been painted, or is painted black, has no
      // luminance spread — which is what distinguishes "connected but nothing arriving" from
      // "video is flowing".
      const p = document.createElement("canvas");
      p.width = 32; p.height = 18;
      const ctx = p.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0, 32, 18);
      const px = ctx.getImageData(0, 0, 32, 18).data;
      let lo = 255, hi = 0;
      for (let i = 0; i < px.length; i += 4) {
        const l = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
        if (l < lo) lo = l;
        if (l > hi) hi = l;
      }
      spread = Math.round(hi - lo);
      painting = spread >= 8;
    } catch (e) { painting = `error: ${e.message}`; }
  }
  const el = document.querySelector("moq-watch");
  return {
    hasPlayer: !!el,
    canvas: size,
    painting,
    spread,
    status: document.querySelector(".watch-status, #status")?.textContent?.trim()?.slice(0, 120) ?? null,
    bodyHint: document.querySelector("#watch-view h2")?.textContent?.trim() ?? null,
  };
});

await browser.close();

console.log("── console ──");
const seen = new Set();
for (const l of lines) {
  const k = l.replace(/\d/g, "#");           // collapse the reconnect loop
  if (seen.has(k)) continue;
  seen.add(k);
  console.log("  " + l);
}
console.log("\n── player ──");
console.log(`  element   ${state.hasPlayer}`);
console.log(`  canvas    ${state.canvas ?? "none"}`);
console.log(`  painting  ${state.painting}  (luminance spread ${state.spread})`);
if (state.status) console.log(`  status    ${state.status}`);
if (state.bodyHint) console.log(`  heading   ${state.bodyHint}`);
