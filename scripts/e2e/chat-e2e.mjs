// Prove chat is end-to-end encrypted: it reaches the other participant, and what crosses
// the wire is not readable.
//
// The strong check is the second one. Rendering correctly only shows the round trip works;
// it says nothing about what the Durable Object could read. So the sender's WebSocket.send
// is wrapped to capture the exact frames leaving the page, and the test asserts the message
// text and the display name appear in NONE of them.

import puppeteer from "puppeteer";

const ORIGIN = process.argv[2] || "https://e2emoq.com";
const PK = process.env.WF_PUBLISH_KEY || "";
const BROADCAST_URL = `${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`;

// Distinctive enough that a substring match is meaningful.
const SECRET_TEXT = `zebra-quartz-${Math.random().toString(36).slice(2, 8)}`;
const SENDER_NAME = `wombat-${Math.random().toString(36).slice(2, 6)}`;

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

try {
  // ── Broadcaster, with chat switched on ────────────────────────────────────────
  const bc = await browser.newPage();
  await bc.goto(BROADCAST_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  // The chat control is a button in the capture bar now, not a checkbox in the header. Assert
  // it actually latched: a click that silently did nothing would leave the viewer with no chat
  // to join, and every check below would fail somewhere far away from the cause.
  await bc.waitForSelector("#chat-btn", { timeout: 30000 });
  await bc.click("#chat-btn");
  await bc.waitForFunction(
    () => document.getElementById("chat-btn")?.classList.contains("toggle-on"),
    { timeout: 15000 }
  );
  const shareUrl = await bc.evaluate(
    () => document.getElementById("copy-btn")?.getAttribute("data-share-url") || ""
  );
  console.log(`  broadcasting ${shareUrl.split("#")[0]} with chat enabled`);

  // Every broadcast carries a mandatory passcode, so the viewer below has to enter one. Read
  // it from the broadcaster's own header — without this the viewer sits on the passcode prompt
  // and never joins the room, which this test would have reported as an encryption failure.
  await bc.waitForFunction(
    () => (document.getElementById("passcode-value")?.textContent || "").length === 8,
    { timeout: 30000 }
  );
  const passcode = await bc.evaluate(
    () => document.getElementById("passcode-value")?.textContent || ""
  );
  await new Promise((r) => setTimeout(r, 8000));
  await bc.waitForSelector(".chat-msgs", { timeout: 30000 });

  // ── Viewer, holding the real link ─────────────────────────────────────────────
  const ctx = await browser.createBrowserContext();
  const vw = await ctx.newPage();

  // Capture every frame this page sends BEFORE any socket is created.
  await vw.evaluateOnNewDocument(() => {
    window.__sent = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { window.__sent.push(String(data)); } catch { /* ignore */ }
      return orig.call(this, data);
    };
  });

  // The passcode is not remembered between loads, by design, so every arrival at the share
  // link has to answer the prompt — including the reload below.
  const enterPasscode = async () => {
    await vw.waitForSelector("#passcode-entry", { timeout: 30000 });
    await vw.type("#passcode-entry", passcode);
    await vw.click("#passcode-go");
  };

  await vw.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await enterPasscode();
  await vw.waitForSelector(".chat-text", { timeout: 45000 });
  await new Promise((r) => setTimeout(r, 4000));

  // Set a distinctive display name, then send.
  await vw.evaluate((n) => localStorage.setItem("earthseed-chat-name", n), SENDER_NAME);
  await vw.reload({ waitUntil: "networkidle2", timeout: 60000 });
  await enterPasscode();
  await vw.waitForSelector(".chat-text", { timeout: 45000 });
  await new Promise((r) => setTimeout(r, 4000));

  await vw.type(".chat-text", SECRET_TEXT);
  await vw.click(".chat-send");
  await new Promise((r) => setTimeout(r, 5000));

  // ── 1. Did it arrive, decrypted, for the broadcaster? ─────────────────────────
  const seenByBroadcaster = await bc.evaluate(
    (t) => [...document.querySelectorAll(".chat-msg-text")].some((e) => e.textContent?.includes(t)),
    SECRET_TEXT
  );
  check("the broadcaster reads the message", seenByBroadcaster);

  // ── 2. Was any of it readable on the wire? ────────────────────────────────────
  const frames = await vw.evaluate(() => window.__sent || []);
  const leakedText = frames.some((f) => f.includes(SECRET_TEXT));
  const leakedName = frames.some((f) => f.includes(SENDER_NAME));
  check("message text never appears in a sent frame", !leakedText, `${frames.length} frame(s) captured`);
  check("display name never appears in a sent frame", !leakedName);
  check("a frame was actually sent", frames.some((f) => f.includes('"type":"msg"')));

  console.log(
    failures === 0
      ? "\nPASS: chat round-trips between participants while the relay carries only ciphertext."
      : `\nFAIL: ${failures} check(s) failed.`
  );
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
