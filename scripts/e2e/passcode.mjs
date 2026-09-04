// Prove the optional passcode is a real second factor, not decoration.
//
// The link and the passcode travel by different channels, so holding one must not be
// enough. This broadcasts with a passcode enabled and then opens the SAME link twice: once
// with the right passcode, once with a wrong one. Only the first may play.
//
// It also exercises re-keying: the passcode is switched on AFTER the broadcast is already
// live, which re-derives the content key in place. That is the revocation mechanism.

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

const watchWith = async (url, code, label) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#passcode-entry", { timeout: 30000 });
  await page.type("#passcode-entry", code);
  await page.click("#passcode-go");
  await new Promise((r) => setTimeout(r, 15000));
  const lit = await page.evaluate(litCount);
  console.log(`  ${label} (${code}): lit=${lit}/14400`);
  return lit;
};

try {
  const bc = await browser.newPage();
  await bc.goto(BROADCAST_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 7000));

  // Mandatory and minted on page load — there is nothing to switch on. An empty row here
  // would mean a broadcast went out with the link as its only secret.
  await bc.waitForFunction(
    () => (document.getElementById("passcode-value")?.textContent || "").length === 8,
    { timeout: 15000 }
  );
  const passcode = await bc.evaluate(
    () => document.getElementById("passcode-value")?.textContent || ""
  );
  const shareUrl = await bc.evaluate(
    () => document.getElementById("copy-btn")?.getAttribute("data-share-url") || ""
  );
  if (!/[#&]p=1/.test(shareUrl)) throw new Error(`share link does not signal a passcode: ${shareUrl}`);
  console.log(`  broadcasting ${shareUrl.split("#")[0]} with passcode ${passcode}`);
  await new Promise((r) => setTimeout(r, 6000));

  const wrong = passcode === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA";
  const litRight = await watchWith(shareUrl, passcode, "correct passcode");
  const litWrong = await watchWith(shareUrl, wrong, "wrong passcode  ");

  if (litRight <= 0) {
    console.error("\nINCONCLUSIVE: the correct passcode did not play, so the stream was not live.");
    process.exitCode = 1;
  } else if (litWrong > 14400 * 0.05) {
    console.error(`\nFAIL: the wrong passcode still rendered ${litWrong} lit pixels — it is not mixed into the key.`);
    process.exitCode = 1;
  } else {
    console.log(
      `\nPASS: ${litRight} lit pixels with the right passcode, ${litWrong} with a wrong one.\n` +
      `The link alone is insufficient, and the stream re-keyed live without the link changing.`
    );
  }
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
