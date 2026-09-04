/**
 * Publish and watch in one process, and print BOTH consoles.
 *
 * broadcast-watch.mjs is the gate — it answers pass/fail. This answers "why", by keeping the
 * broadcaster alive while a viewer joins and showing what each side says. The line that matters
 * is the viewer's `announced:` — the relay listing what is published. Empty means the viewer
 * subscribed to a broadcast the relay does not have, which is a different failure from a viewer
 * that cannot decode one it does have.
 *
 *   E2EMOQ_PUBLISH_KEY=<code> node scripts/e2e/pipeline-probe.mjs [origin]
 */
import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const KEY = process.env.E2EMOQ_PUBLISH_KEY || "";

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const tap = (page, tag, sink) => {
  const keep = (s) => sink.push(`${tag} ${String(s).replace(/jwt=[\w.-]+/g, "jwt=<redacted>").slice(0, 200)}`);
  page.on("console", (m) => keep(`${m.type().padEnd(5)} ${m.text()}`));
  page.on("pageerror", (e) => keep(`ERR   ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400) keep(`HTTP${r.status()} ${r.url()}`); });
};

const pubLog = [], viewLog = [];

// ── publisher ──────────────────────────────────────────────────────────────────────────
const bc = await browser.newPage();
if (KEY) {
  await bc.evaluateOnNewDocument((k) => {
    try { localStorage.setItem("e2emoq.publishKey", k); } catch { /* private mode */ }
  }, KEY);
}
tap(bc, "[pub] ", pubLog);
await bc.goto(`${ORIGIN}/broadcast`, { waitUntil: "networkidle2", timeout: 60000 });
await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
await bc.click('button.publish-btn[title="Camera"]');
await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
const shareUrl = await bc.evaluate(async () => {
  // Wait for the copy button to carry the link, which only happens once the key is derived.
  for (let i = 0; i < 40; i++) {
    const u = document.getElementById("copy-btn")?.getAttribute("data-share-url");
    if (u && u.includes("#k=")) return u;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
});
if (!shareUrl) { console.log("broadcaster never produced a share link"); await browser.close(); process.exit(1); }
console.log(`broadcasting ${new URL(shareUrl).pathname.slice(1)} — letting it settle 8s\n`);
await new Promise((r) => setTimeout(r, 8000));

// ── viewer, separate context so nothing is shared ──────────────────────────────────────
const ctx = await browser.createBrowserContext();
const vw = await ctx.newPage();
tap(vw, "[view]", viewLog);
await vw.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

// BACKGROUND THE BROADCASTER. This is what a person does: they open the share link in another
// tab to check it, and the broadcasting tab goes hidden. Chrome throttles hidden tabs hard —
// rAF stops entirely — so a publisher that depends on rAF freezes its viewers silently, and a
// probe that leaves the broadcaster in front would never see it.
await vw.bringToFront();
console.log("viewer brought to front — broadcaster is now a hidden tab\n");

// Long enough to outlast the ~5s mark where the real broadcast died.
const WATCH_MS = Number(process.env.WATCH_MS || 60000);
const samples = [];
for (let i = 0; i < Math.floor(WATCH_MS / 5000); i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = await vw.evaluate(() => {
    const c = document.querySelector("moq-watch canvas");
    if (!c) return null;
    const p = document.createElement("canvas");
    p.width = 32; p.height = 18;
    const x = p.getContext("2d", { willReadFrequently: true });
    try { x.drawImage(c, 0, 0, 32, 18); } catch { return "tainted"; }
    const d = x.getImageData(0, 0, 32, 18).data;
    let sum = 0;
    for (let k = 0; k < d.length; k += 4) sum = (sum + d[k] * (k + 1)) >>> 0;
    return sum;
  });
  samples.push(s);
}
// A frozen picture keeps its pixels but stops CHANGING. Comparing consecutive checksums is the
// only way to tell "still streaming" from "stalled on the last frame it got".
const changed = samples.filter((v, i) => i > 0 && v !== samples[i - 1]).length;
console.log(`frame checksum changed in ${changed}/${samples.length - 1} intervals`);

const painting = await vw.evaluate(() => {
  const c = document.querySelector("moq-watch canvas");
  if (!c) return { canvas: null };
  const p = document.createElement("canvas");
  p.width = 32; p.height = 18;
  const x = p.getContext("2d", { willReadFrequently: true });
  try { x.drawImage(c, 0, 0, 32, 18); } catch { return { canvas: `${c.width}x${c.height}`, painting: "tainted" }; }
  const d = x.getImageData(0, 0, 32, 18).data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  return { canvas: `${c.width}x${c.height}`, spread: Math.round(hi - lo), painting: hi - lo >= 8 };
});

await browser.close();

const dedupe = (rows) => {
  const seen = new Set(), out = [];
  for (const r of rows) {
    const k = r.replace(/\d/g, "#");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
};
console.log("── broadcaster ──");
for (const l of dedupe(pubLog)) console.log("  " + l);
console.log("\n── viewer ──");
for (const l of dedupe(viewLog)) console.log("  " + l);
console.log("\n── result ──");
console.log(`  canvas   ${painting.canvas}`);
console.log(`  painting ${painting.painting}  (spread ${painting.spread})`);
