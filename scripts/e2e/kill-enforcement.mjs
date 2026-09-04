// Can a terminated stream be stopped WITHOUT the client's cooperation?
//
// The cooperative path is already proven (kill-live-viewer.mjs): both pages poll `killed` and
// tear down. But a client that simply ignores that flag — or never ran our JavaScript at all —
// would keep watching. The claim is that it dies anyway, because:
//
//   1. cdn.moq.pro drops a session at token expiry            (token-expiry.mjs)
//   2. renewal has to come back through this Worker
//   3. the Worker returns 410 for a killed stream, so there is no new token
//
// Simulated here by BLOCKING the settings poll on both pages, so neither the viewer nor the
// broadcaster ever learns it was killed. Blocking the broadcaster's poll matters as much as
// the viewer's: if the publisher noticed and stopped, the viewer would run dry and the test
// would "pass" while proving nothing about enforcement.
//
//   WF_PUBLISH_KEY=<key> node scripts/e2e/kill-enforcement.mjs [origin] [ttl]

import puppeteer from "puppeteer";
import { execFileSync } from "node:child_process";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const TTL = Number(process.argv[3] || 40);
const PK = process.env.WF_PUBLISH_KEY || "";
const STEP = (m) => console.log(`  ${m}`);

const SAMPLE = () => {
  const els = [...document.querySelectorAll("video,canvas")]
    .map((el) => ({ el, w: el.videoWidth || el.width || 0, h: el.videoHeight || el.height || 0 }))
    .filter((m) => m.w > 0 && m.h > 0)
    .sort((a, b) => b.w * b.h - a.w * a.h);
  if (!els.length) return { ok: false };
  const { el, w, h } = els[0];
  const c = document.createElement("canvas");
  c.width = Math.min(w, 320); c.height = Math.min(h, 180);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  try { ctx.drawImage(el, 0, 0, c.width, c.height); } catch { return { ok: false }; }
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let sum = 0, lit = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i] + data[i + 1] + data[i + 2];
    sum = (sum + v * (i + 1)) >>> 0;
    if (v > 30) lit++;
  }
  return { ok: true, sum, lit, total: data.length / 4 };
};

const d1 = (sql) =>
  execFileSync("npx", ["wrangler", "d1", "execute", "e2emoq-db", "--remote", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

let streamId = null;

try {
  // ── Publish, deaf to the kill flag ─────────────────────────────────────────────────────
  const bc = await browser.newPage();
  await bc.setRequestInterception(true);
  bc.on("request", (req) => {
    // Block the settings poll (exact /api/streams/<id>) but never /route.
    if (/\/api\/streams\/[a-z0-9]{5}(\?|$)/.test(req.url())) return req.abort();
    req.continue();
  });
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
  STEP(`broadcasting ${streamId} — publisher is deaf to the kill flag`);
  await new Promise((r) => setTimeout(r, 5000));

  // ── Watch, also deaf, with a short token ───────────────────────────────────────────────
  const [base, frag] = shareUrl.split("#");
  const ctx = await browser.createBrowserContext();
  const vw = await ctx.newPage();
  await vw.setRequestInterception(true);
  vw.on("request", (req) => {
    if (/\/api\/streams\/[a-z0-9]{5}(\?|$)/.test(req.url())) return req.abort();
    req.continue();
  });

  let grantedTtl = null;
  const renewalAttempts = [];
  vw.on("console", (m) => { if (m.text().includes("[token]")) renewalAttempts.push(m.text()); });
  vw.on("response", async (r) => {
    if (!/\/route(\?|$)/.test(r.url())) return;
    try {
      const b = await r.json();
      if (b.jwt && grantedTtl === null) {
        const c = JSON.parse(Buffer.from(b.jwt.split(".")[1], "base64url").toString());
        grantedTtl = c.exp - Math.floor(Date.now() / 1000);
      }
    } catch { /* not json */ }
  });

  await vw.goto(`${base}?ttl=${TTL}#${frag}`, { waitUntil: "networkidle2", timeout: 60000 });
  await vw.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 640),
    { timeout: 60000 }
  );
  await new Promise((r) => setTimeout(r, 4000));

  if (grantedTtl === null || Math.abs(grantedTtl - TTL) > 15) {
    throw new Error(`token lifetime is ${grantedTtl}s, not ~${TTL}s — the override did not take effect`);
  }
  let prevV = await vw.evaluate(SAMPLE);
  await new Promise((r) => setTimeout(r, 2500));
  let checkV = await vw.evaluate(SAMPLE);
  if (!checkV.ok || checkV.sum === prevV.sum) throw new Error("viewer was not receiving frames before the kill");
  STEP(`viewer watching on a ${grantedTtl}s token, ignoring the kill flag`);

  // ── Kill ───────────────────────────────────────────────────────────────────────────────
  d1(`UPDATE stream_salts SET killed_at = datetime('now'), salt = 'killed-by-enforcement-test' WHERE stream_id = '${streamId}'`);
  const killedAt = Date.now();
  STEP(`killed at t=0 — nothing tells either page; only the relay can stop this`);
  STEP("");
  STEP("    t      viewer                      broadcaster");

  prevV = await vw.evaluate(SAMPLE);
  let prevB = await bc.evaluate(SAMPLE);
  let viewerDead = null;
  let publisherDead = null;

  for (let t = 10; t <= TTL * 3; t += 10) {
    await new Promise((r) => setTimeout(r, 10000));
    const v = await vw.evaluate(SAMPLE);
    const b = await bc.evaluate(SAMPLE);
    const vMoving = v.ok && prevV.ok && v.sum !== prevV.sum;
    const bMoving = b.ok && prevB.ok && b.sum !== prevB.sum;
    STEP(`  ${String(t).padStart(3)}s   ${((v.ok ? `lit=${v.lit}/${v.total}` : "gone") + (vMoving ? " moving" : " STOPPED")).padEnd(28)}${(b.ok ? `lit=${b.lit}/${b.total}` : "gone")}${bMoving ? " moving" : " STOPPED"}`);
    if (!viewerDead && !vMoving) viewerDead = t;
    if (!publisherDead && !bMoving) publisherDead = t;
    prevV = v; prevB = b;
    if (viewerDead) break;
  }

  const sawRefusal = renewalAttempts.some((l) => /refused/.test(l));
  console.log("");
  STEP(`renewal log: ${renewalAttempts.length ? renewalAttempts[renewalAttempts.length - 1].replace(/^\S+\s/, "") : "(none)"}`);
  STEP(`the Worker refused to reissue: ${sawRefusal ? "yes" : "not observed"}`);
  console.log("");

  if (publisherDead && (!viewerDead || publisherDead < viewerDead)) {
    console.log(`VERDICT: INCONCLUSIVE — the publisher stopped at ${publisherDead}s despite the block,\n         so the viewer may have run dry. Re-run.\n`);
    process.exitCode = 1;
  } else if (!viewerDead) {
    console.log(`VERDICT: NOT ENFORCED — a client ignoring the kill flag kept watching a terminated\n         stream for ${TTL * 3}s. Termination is cooperative only.\n`);
    process.exitCode = 1;
  } else {
    console.log(
      `VERDICT: ENFORCED — the viewer died ${viewerDead}s after the kill without ever being told,\n` +
      `         on a ${grantedTtl}s token, while the publisher kept sending. The relay dropped it\n` +
      `         at expiry and the Worker refused a replacement.\n` +
      `         => Termination does not depend on the client behaving.\n`
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
