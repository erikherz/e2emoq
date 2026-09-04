// Going live WITHOUT a publish key shows the camera. Does it also SEND it?
//
// The preview is local by construction — a <video> pointed at the capture MediaStream — so
// seeing yourself proves nothing either way, which is exactly why it deserves checking rather
// than reasoning about. If admission failed but publishing started anyway, a broadcaster who
// closed the prompt would be transmitting while believing they had not begun.
//
// Verified from four independent angles, because any one of them could pass for a bad reason:
//   1. no WebTransport session is opened at all
//   2. the <moq-publish> element is never given a url
//   3. no go-live request reaches the Worker
//   4. no broadcast row appears in D1 for this session
//
//   node scripts/e2e/no-key-no-publish.mjs [origin]
//
// Deliberately takes NO publish key: it runs in a fresh context with empty localStorage.

import puppeteer from "puppeteer";
import { execFileSync } from "node:child_process";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const STEP = (m) => console.log(`  ${m}`);

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

try {
  // Fresh context: no localStorage, so getPublishKey() finds nothing and no ?pk= is supplied.
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();

  const goLiveCalls = [];
  page.on("request", (r) => {
    if (/\/api\/stats\/broadcast/.test(r.url())) goLiveCalls.push(r.url());
  });

  await page.evaluateOnNewDocument(() => {
    window.__sessions = [];
    const Real = window.WebTransport;
    if (!Real) return;
    window.WebTransport = function (...args) {
      window.__sessions.push(String(args[0]));
      return new Real(...args);
    };
    window.WebTransport.prototype = Real.prototype;
  });

  await page.goto(`${ORIGIN}/broadcast`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await page.click('button.publish-btn[title="Camera"]');
  STEP("camera enabled with no publish key");

  // The prompt is the expected outcome; without it, admission is not being enforced here.
  await page.waitForFunction(
    () => !!document.getElementById("publish-key-entry"),
    { timeout: 20000 }
  ).catch(() => { throw new Error("no publish-key prompt appeared — admission is not gating go-live"); });
  check("a publish key is demanded", true, true);

  // Give it a generous window to misbehave. A race that only loses sometimes would otherwise
  // pass here and fail in front of a user.
  await new Promise((r) => setTimeout(r, 12000));

  const state = await page.evaluate(() => {
    const pub = document.querySelector("moq-publish");
    const localVideo = [...document.querySelectorAll("video,canvas")]
      .some((el) => (el.videoWidth || el.width || 0) >= 320);
    return {
      sessions: window.__sessions ?? [],
      publishUrl: pub?.getAttribute("url") ?? "",
      streamIdInUrl: new URLSearchParams(location.search).get("stream") ?? "",
      showsPreview: localVideo,
      promptStillUp: !!document.getElementById("publish-key-entry"),
    };
  });

  // The preview being visible is the whole premise — if it were absent this test would be
  // proving nothing was sent because nothing was captured.
  check("the local preview is showing", state.showsPreview, true);
  check("the prompt is still waiting", state.promptStillUp, true);

  check("no WebTransport session was opened", state.sessions.length, 0);
  check("the publisher element has no url", state.publishUrl, "");
  check("no go-live request was made", goLiveCalls.length, 0);

  // Fourth angle: the database. A row here would mean a relay was assigned and a token minted,
  // whatever the browser did afterwards.
  if (state.streamIdInUrl) {
    const out = execFileSync("npx", [
      "wrangler", "d1", "execute", "e2emoq-db", "--remote", "--json",
      "--command", `SELECT COUNT(*) AS n FROM broadcast_events WHERE stream_id = '${state.streamIdInUrl}'`,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const n = JSON.parse(out)[0]?.results?.[0]?.n ?? -1;
    check(`no broadcast row exists for ${state.streamIdInUrl}`, n, 0);
  } else {
    STEP("  (no stream id was even allocated in the URL)");
  }
} catch (e) {
  failures++;
  console.error(`\nERROR: ${e.message}`);
} finally {
  await browser.close();
}

console.log(failures ? `\nFAIL: ${failures} assertion(s)\n` : "\nPASS: no publish key means nothing is transmitted\n");
process.exit(failures ? 1 : 0);
