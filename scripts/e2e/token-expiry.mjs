// Does the CDN enforce viewer-token expiry on an ESTABLISHED session, or only at connect?
//
// This decides what the kill switch actually is.
//
//   If expiry IS enforced mid-session: drop VIEWER_TOKEN_TTL to ~60s, renew through the
//   Worker, and a terminated stream dies within one token lifetime for ANY client — including
//   one deliberately ignoring the `killed` flag, and including a custom client that never ran
//   our JavaScript at all. Kill becomes enforceable.
//
//   If it is NOT: a token is a door key checked once at the door. Kill stays cooperative, and
//   the only real fix is a disconnect API from the CDN operator.
//
// Method: broadcast normally (the PUBLISHER keeps its full-length token, so the source stays
// up throughout), connect a viewer with ?ttl=<short>, and sample past expiry. The publisher is
// sampled too — if it stopped, the viewer going quiet proves nothing.
//
//   WF_PUBLISH_KEY=<key> node scripts/e2e/token-expiry.mjs [origin] [ttlSeconds]

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const TTL = Number(process.argv[3] || 60);
const WATCH_FOR = Math.round(TTL * 2.5); // well past expiry, to catch a lazy sweep
const PK = process.env.WF_PUBLISH_KEY || "";
const STEP = (m) => console.log(`  ${m}`);

const LAUNCH = {
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
};

const SAMPLE = () => {
  const els = [...document.querySelectorAll("video,canvas")]
    .map((el) => ({ el, w: el.videoWidth || el.width || 0, h: el.videoHeight || el.height || 0 }))
    .filter((m) => m.w > 0 && m.h > 0)
    .sort((a, b) => b.w * b.h - a.w * a.h);
  if (!els.length) return { ok: false, reason: "no media element" };
  const { el, w, h } = els[0];
  const c = document.createElement("canvas");
  c.width = Math.min(w, 320);
  c.height = Math.min(h, 180);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  try { ctx.drawImage(el, 0, 0, c.width, c.height); } catch (e) { return { ok: false, reason: e.message }; }
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let sum = 0, lit = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i] + data[i + 1] + data[i + 2];
    sum = (sum + v * (i + 1)) >>> 0;
    if (v > 30) lit++;
  }
  return { ok: true, sum, lit, total: data.length / 4 };
};

const browser = await puppeteer.launch(LAUNCH);

try {
  // ── Publish ────────────────────────────────────────────────────────────────────────────
  const bc = await browser.newPage();
  await bc.goto(`${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`, {
    waitUntil: "networkidle2", timeout: 60000,
  });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  const streamId = await bc.evaluate(() => new URLSearchParams(location.search).get("stream"));
  await bc.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 320),
    { timeout: 45000 }
  );
  const shareUrl = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
  STEP(`broadcasting ${streamId} (publisher token unchanged — the source stays up)`);
  await new Promise((r) => setTimeout(r, 5000));

  // ── Watch with a deliberately short token ──────────────────────────────────────────────
  // ?ttl= goes on the page URL, before the fragment, so the key survives.
  const [base, frag] = shareUrl.split("#");
  const watchUrl = `${base}?ttl=${TTL}#${frag}`;

  const ctx = await browser.createBrowserContext();
  const vw = await ctx.newPage();

  // Read the lifetime out of the TOKEN, not out of a field the server says it used. The JWT's
  // own `exp` claim is what the relay would enforce, so it is the only number worth measuring
  // — an echoed `token_ttl` could be right while the minted token was something else, and a
  // run against a stale edge would look identical to a successful one.
  let grantedTtl = null;
  let routeSeen = false;
  vw.on("response", async (r) => {
    if (!/\/route(\?|$)/.test(r.url())) return;
    routeSeen = true;
    try {
      const body = await r.json();
      if (!body.jwt) return;
      const claims = JSON.parse(Buffer.from(body.jwt.split(".")[1], "base64url").toString());
      if (typeof claims.exp === "number") grantedTtl = claims.exp - Math.floor(Date.now() / 1000);
    } catch { /* not a JSON route response */ }
  });

  await vw.goto(watchUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await vw.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 640),
    { timeout: 60000 }
  );
  await vw.waitForFunction(
    () => {
      const el = [...document.querySelectorAll("video,canvas")].filter((e) => (e.videoWidth || e.width || 0) >= 640)[0];
      if (!el) return false;
      const c = document.createElement("canvas");
      c.width = 64; c.height = 36;
      const x = c.getContext("2d", { willReadFrequently: true });
      try { x.drawImage(el, 0, 0, 64, 36); } catch { return false; }
      const d = x.getImageData(0, 0, 64, 36).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
      return lit > (d.length / 4) * 0.05;
    },
    { timeout: 60000, polling: 500 }
  );

  const connectedAt = Date.now();
  if (!routeSeen) {
    throw new Error("never saw a /route response — cannot tell what token the viewer holds");
  }
  if (grantedTtl === null) {
    throw new Error("could not read exp from the viewer's token — refusing to guess");
  }
  STEP(`viewer connected with a token expiring in ${grantedTtl}s (asked for ${TTL}s)`);
  // Abort rather than produce a confident wrong answer. A run against a stale edge hands back
  // the 6h default and would then "prove" expiry is unenforced while never testing it.
  if (Math.abs(grantedTtl - TTL) > 15) {
    throw new Error(
      `token lifetime is ${grantedTtl}s, not ~${TTL}s — the ?ttl= override did not take effect ` +
      `(stale edge, or the param is being dropped before /route). Nothing measurable here.`
    );
  }
  STEP("");
  STEP("    t      viewer                      broadcaster");

  let prevV = await vw.evaluate(SAMPLE);
  let prevB = await bc.evaluate(SAMPLE);
  let viewerStalledAt = null;
  let publisherStalledAt = null;

  for (let t = 10; t <= WATCH_FOR; t += 10) {
    await new Promise((r) => setTimeout(r, 10000));
    const v = await vw.evaluate(SAMPLE);
    const b = await bc.evaluate(SAMPLE);
    const vMoving = v.ok && prevV.ok && v.sum !== prevV.sum;
    const bMoving = b.ok && prevB.ok && b.sum !== prevB.sum;
    const past = Math.round((Date.now() - connectedAt) / 1000) > TTL ? " (past expiry)" : "";

    STEP(
      `  ${String(t).padStart(3)}s   ${((v.ok ? `lit=${v.lit}/${v.total}` : "gone") + (vMoving ? " moving" : " STOPPED")).padEnd(28)}` +
      `${(b.ok ? `lit=${b.lit}/${b.total}` : "gone")}${bMoving ? " moving" : " STOPPED"}${past}`
    );

    if (!viewerStalledAt && !vMoving) viewerStalledAt = t;
    if (!publisherStalledAt && !bMoving) publisherStalledAt = t;
    prevV = v; prevB = b;
    if (viewerStalledAt) break;
  }

  console.log("");
  if (publisherStalledAt) {
    console.log(
      `VERDICT: INCONCLUSIVE — the publisher stopped at ${publisherStalledAt}s, so the viewer's\n` +
      `         behaviour says nothing about token expiry. Re-run.\n`
    );
    process.exitCode = 1;
  } else if (!viewerStalledAt) {
    console.log(
      `VERDICT: expiry is NOT enforced mid-session.\n` +
      `         The viewer kept decoding for ${WATCH_FOR}s on a ${grantedTtl}s token — ${Math.round(WATCH_FOR / TTL)}x its lifetime —\n` +
      `         while the publisher kept sending. The token is checked at connect and not again.\n` +
      `         => Shortening TTLs will NOT make the kill switch enforceable. Kill stays\n` +
      `            cooperative; enforcement needs a disconnect API from the CDN.\n`
    );
  } else if (viewerStalledAt >= TTL) {
    console.log(
      `VERDICT: expiry IS enforced mid-session.\n` +
      `         The viewer stopped at ${viewerStalledAt}s on a ${grantedTtl}s token while the publisher\n` +
      `         was still sending — the relay dropped it for the token, not for lack of media.\n` +
      `         => Dropping VIEWER_TOKEN_TTL and renewing would make kill enforceable against\n` +
      `            ANY client, including one that never ran our JavaScript.\n`
    );
  } else {
    console.log(
      `VERDICT: INCONCLUSIVE — the viewer stopped at ${viewerStalledAt}s, BEFORE its ${grantedTtl}s token\n` +
      `         expired. That is some other failure, not expiry enforcement. Re-run.\n`
    );
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`\nERROR: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
