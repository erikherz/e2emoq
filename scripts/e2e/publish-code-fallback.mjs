/**
 * Auto-mint is silent, so its FAILURE has to be loud.
 *
 * Go-live now mints a publish code without asking. The risk that introduces is a broadcaster
 * who presses Camera, gets nothing, and is told nothing — because the thing that used to
 * explain the situation was the dialog that no longer appears. So the invariant is:
 *
 *   minting works    → no dialog, straight to live
 *   minting fails    → the dialog, with its paste box, every time
 *
 * Both are checked here. The failure is induced by refusing /api/publish-code/request at the
 * network layer, which is what an outage or a disabled ISSUE_KEY looks like from the browser.
 *
 *   node scripts/e2e/publish-code-fallback.mjs [origin]
 */
import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
let fails = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${expected}, got ${actual}`);
};

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

/** Drive one go-live in a clean context. `breakMint` refuses the issuance endpoint. */
async function run(breakMint) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  if (breakMint) {
    await page.setRequestInterception(true);
    page.on("request", (r) =>
      /\/api\/publish-code\/request/.test(r.url())
        ? r.respond({ status: 503, contentType: "application/json", body: '{"error":"code issuance is not enabled"}' })
        : r.continue()
    );
  }
  await page.goto(`${ORIGIN}/broadcast`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await page.click('button.publish-btn[title="Camera"]');
  // Long enough for the proof of work (~1s) plus the relay handshake.
  await new Promise((r) => setTimeout(r, 20000));
  const state = await page.evaluate(() => ({
    dialog: !!document.querySelector("#publish-key-entry"),
    live: !!document.querySelector("moq-publish")?.getAttribute("url"),
  }));
  await ctx.close();
  return state;
}

console.log("── minting works ──");
const ok = await run(false);
check("no dialog is shown", ok.dialog, false);
check("the broadcast goes live", ok.live, true);

console.log("\n── minting refused (503) ──");
const bad = await run(true);
check("the dialog appears", bad.dialog, true);
check("and the broadcast does not go live", bad.live, false);

await browser.close();
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
