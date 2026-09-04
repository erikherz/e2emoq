// Why did token renewal not fire? Dumps the viewer's console and the raw token claims.
//   WF_PUBLISH_KEY=<key> node scripts/e2e/debug-renewal.mjs [origin] [ttl]

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const TTL = Number(process.argv[3] || 40);
const PK = process.env.WF_PUBLISH_KEY || "";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

try {
  const bc = await browser.newPage();
  await bc.goto(`${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  await bc.waitForFunction(() => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 320), { timeout: 45000 });
  const shareUrl = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
  await new Promise((r) => setTimeout(r, 5000));

  const [base, frag] = shareUrl.split("#");
  const ctx = await browser.createBrowserContext();
  const vw = await ctx.newPage();

  vw.on("console", (m) => {
    const t = m.text();
    if (/\[token\]|\[watch-timing\]|\[route\]|error/i.test(t)) console.log(`  console: ${t.slice(0, 160)}`);
  });
  vw.on("pageerror", (e) => console.log(`  PAGEERROR: ${e.message}`));

  vw.on("response", async (r) => {
    if (!/\/route(\?|$)/.test(r.url())) return;
    try {
      const body = await r.json();
      if (!body.jwt) { console.log("  route response has NO jwt"); return; }
      const seg = body.jwt.split(".")[1];
      console.log(`  jwt payload segment length=${seg.length}, len%4=${seg.length % 4}`);
      console.log(`  claims (node decode): ${Buffer.from(seg, "base64url").toString().slice(0, 200)}`);
    } catch (e) { console.log(`  route parse failed: ${e.message}`); }
  });

  await vw.goto(`${base}?ttl=${TTL}#${frag}`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 12000));

  // Reproduce the browser-side decode exactly as main.ts does it.
  const decodeCheck = await vw.evaluate(async (origin, streamId) => {
    const r = await fetch(`/api/streams/${streamId}/route?ttl=40`);
    if (!r.ok) return { status: r.status };
    const data = await r.json();
    const seg = data.jwt?.split(".")[1];
    const out = { hasJwt: !!data.jwt, segLen: seg?.length, mod4: seg ? seg.length % 4 : null };
    try {
      out.decoded = JSON.parse(atob(seg.replace(/-/g, "+").replace(/_/g, "/")));
      out.atobOk = true;
    } catch (e) {
      out.atobOk = false;
      out.atobError = e.message;
    }
    return out;
  }, ORIGIN, base.split("/").pop());

  console.log("\n  browser-side decode:", JSON.stringify(decodeCheck, null, 2).slice(0, 600));
} catch (e) {
  console.error(`ERROR: ${e.message}`);
} finally {
  await browser.close();
}
