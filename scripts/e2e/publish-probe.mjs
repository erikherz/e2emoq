/**
 * Drive a broadcast headlessly and dump the BROADCASTER's console, unfiltered.
 *
 * broadcast-watch.mjs keeps only `console.error`, which is exactly the wrong filter for this:
 * the publisher reports its transport at `log` level, so a broadcast that never connects to the
 * relay produces no error at all and the suite just times out on the viewer. That reads as a
 * viewer problem and is not one.
 *
 * The question here is narrow: does <moq-publish> open a session to cdn.moq.pro and announce
 * the broadcast? If it does, the viewer's empty `announced: prefix=` is a relay-side mystery.
 * If it does not, everything downstream is a symptom.
 *
 *   node scripts/e2e/publish-probe.mjs [origin]
 */
import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await browser.newPage();

// Seed a publish key BEFORE the app loads, so this reproduces a broadcaster who already has
// one. Without it buildPublisherClaim() returns null and go-live sits at a key prompt forever
// — a different failure from the one under investigation, and one that logs nothing.
const KEY = process.env.E2EMOQ_PUBLISH_KEY || "";
if (KEY) {
  await page.evaluateOnNewDocument((k) => {
    try { localStorage.setItem("e2emoq.publishKey", k); } catch { /* private mode */ }
  }, KEY);
}
console.log(KEY ? "  (publish key seeded)" : "  (NO publish key — expect a prompt, not a broadcast)");

const lines = [];
const keep = (s) => lines.push(String(s).replace(/jwt=[\w.-]+/g, "jwt=<redacted>").slice(0, 240));
page.on("console", (m) => keep(`${m.type().padEnd(7)} ${m.text()}`));
page.on("pageerror", (e) => keep(`pageerr ${e.message}`));
page.on("requestfailed", (r) => keep(`REQFAIL ${r.url()} ${r.failure()?.errorText ?? ""}`));
page.on("response", (r) => { if (r.status() >= 400) keep(`HTTP${r.status()} ${r.url()}`); });

await page.goto(`${ORIGIN}/broadcast`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
await page.click('button.publish-btn[title="Camera"]');
await page.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 })
  .catch(() => {});

// Long enough for the relay handshake, the catalog write and a few seconds of frames.
await new Promise((r) => setTimeout(r, 25000));

const state = await page.evaluate(() => {
  const pub = document.querySelector("moq-publish");
  const id = (location.href.match(/[?&]stream=([a-z0-9]{5})/) || [])[1] ?? null;
  return {
    streamId: id,
    hasPublisher: !!pub,
    publisherUrl: pub?.getAttribute("url")?.replace(/jwt=[\w.-]+/, "jwt=<redacted>") ?? null,
    connection: (() => { try { return pub?.connection?.status?.peek?.() ?? null; } catch { return "unreadable"; } })(),
    notice: (() => {
      const n = document.querySelector("#capture-notice, .capture-notice");
      return n && !n.hidden ? n.textContent.trim().slice(0, 200) : null;
    })(),
  };
});

await browser.close();

console.log("── broadcaster console ──");
const seen = new Set();
for (const l of lines) {
  const k = l.replace(/\d/g, "#");
  if (seen.has(k)) continue;
  seen.add(k);
  console.log("  " + l);
}
console.log("\n── publisher state ──");
for (const [k, v] of Object.entries(state)) console.log(`  ${k.padEnd(14)} ${v}`);
