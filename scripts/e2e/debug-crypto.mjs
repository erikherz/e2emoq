// Diagnostic: dump every console message from both sides of a broadcast, plus the state of
// the media-crypto hook object, to locate where encrypted playback breaks down.
import puppeteer from "puppeteer";

const ORIGIN = process.argv[2] || "https://e2emoq.com";
const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const wire = (page, tag, sink) => {
  page.on("console", (m) => sink.push(`[${tag}:${m.type()}] ${m.text().slice(0, 220)}`));
  page.on("pageerror", (e) => sink.push(`[${tag}:pageerror] ${e.message.slice(0, 220)}`));
};

const probe = () => {
  const mc = globalThis.__VIVOH_MEDIA_CRYPTO__;
  return {
    installed: !!mc,
    shouldEncrypt: mc ? mc.shouldEncrypt("probe") : null,
    shouldDecrypt: mc ? mc.shouldDecrypt() : null,
  };
};

const bcLogs = [];
const vwLogs = [];

const bc = await browser.newPage();
wire(bc, "bcast", bcLogs);
await bc.goto(`${ORIGIN}/broadcast`, { waitUntil: "networkidle2", timeout: 60000 });
await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
await bc.click('button.publish-btn[title="Camera"]');
await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
const streamId = await bc.evaluate(() => new URLSearchParams(location.search).get("stream"));
await new Promise((r) => setTimeout(r, 9000));
const bcState = await bc.evaluate(probe);

const ctx = await browser.createBrowserContext();
const vw = await ctx.newPage();
wire(vw, "watch", vwLogs);
await vw.goto(`${ORIGIN}/${streamId}`, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 12000));
const vwState = await vw.evaluate(probe);
const vwMedia = await vw.evaluate(() =>
  [...document.querySelectorAll("video,canvas")].map((e) => ({
    tag: e.tagName, w: e.videoWidth || e.width, h: e.videoHeight || e.height,
  }))
);

console.log(`stream: ${streamId}`);
console.log(`broadcaster crypto: ${JSON.stringify(bcState)}`);
console.log(`viewer crypto:      ${JSON.stringify(vwState)}`);
console.log(`viewer media:       ${JSON.stringify(vwMedia)}`);
console.log(`\n--- broadcaster console (crypto/media/error) ---`);
console.log(bcLogs.filter((l) => /crypto|media|error|encrypt|key/i.test(l)).slice(0, 18).join("\n") || "(none)");
const INTERESTING = /crypto|decrypt|error|warn|decode|frame|fail|key|group/i;
console.log(`\n--- viewer console (filtered) ---`);
console.log(vwLogs.filter((l) => INTERESTING.test(l)).slice(0, 30).join("\n") || "(none)");
console.log(`\n--- viewer console (last 12) ---`);
console.log(vwLogs.slice(-12).join("\n") || "(none)");

await browser.close();
