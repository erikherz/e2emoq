// Negative control: prove the `#k=` fragment is what actually grants decryption.
//
// broadcast-watch.mjs proves a viewer holding the full share link can decode. That alone
// cannot distinguish "encrypted, correctly decrypted" from "never encrypted" -- both play
// identically. This test opens the SAME live stream with the fragment removed, which is
// precisely the position of our own Worker, our database, and the CDN: full knowledge of
// the stream id, a valid relay token, and no key.
//
// PASS = the deprived viewer renders nothing. FAIL = it decodes, meaning either the media
// is not really encrypted or the key is reachable without the link.

import puppeteer from "puppeteer";

const ORIGIN = process.argv[2] || "https://e2emoq.com";
const PK = process.env.WF_PUBLISH_KEY || "";
const BROADCAST_URL = `${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`;
const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const litCount = () => {
  const el = [...document.querySelectorAll("video,canvas")]
    .filter((e) => (e.videoWidth || e.width || 0) >= 640)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!el) return -1;
  const c = document.createElement("canvas");
  c.width = 160;
  c.height = 90;
  const x = c.getContext("2d", { willReadFrequently: true });
  try { x.drawImage(el, 0, 0, 160, 90); } catch { return -1; }
  const d = x.getImageData(0, 0, 160, 90).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
  return lit;
};

const watch = async (url, label) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 14000));
  const lit = await page.evaluate(litCount);
  console.log(`  ${label}: lit=${lit}/14400`);
  return lit;
};

try {
  const bc = await browser.newPage();
  await bc.goto(BROADCAST_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  const shareUrl = await bc.evaluate(
    () => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? ""
  );
  if (!/#k=/.test(shareUrl)) throw new Error(`share link carries no #k= secret: ${shareUrl}`);
  const bare = shareUrl.split("#")[0];
  console.log(`  broadcasting ${bare}`);
  await new Promise((r) => setTimeout(r, 8000));

  // Control first: if this is black the broadcast is dead and the result below means nothing.
  const litWith = await watch(shareUrl, "WITH #k= (a real share link) ");
  const litWithout = await watch(bare, "WITHOUT #k= (our own position)");

  if (litWith <= 0) {
    console.error("\nINCONCLUSIVE: the control viewer never decoded, so the stream was not live.");
    process.exitCode = 1;
  } else if (litWithout > 14400 * 0.05) {
    console.error(`\nFAIL: a viewer without the fragment rendered ${litWithout} lit pixels — the key is reachable without the link.`);
    process.exitCode = 1;
  } else {
    console.log(
      `\nPASS: ${litWith} lit pixels with the fragment, ${litWithout} without.\n` +
      `The link is the sole capability. e2eMoQ's Worker and database hold nothing that\n` +
      `would decrypt this stream, because the secret never reaches them.`
    );
  }
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
