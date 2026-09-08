// Viewer-side recording: does it produce a file, is that file actually protected, and does
// the right link open it?
//
//   node scripts/e2e/recording.mjs [origin]        # default: https://e2emoq.com
//
// The assertion that carries the weight is the NEGATIVE one. "It recorded and replayed" only
// proves the feature works; a recording that also opens under the wrong key would mean we had
// shipped a plaintext archive of an end-to-end encrypted product. So this asserts, in order:
//
//   1. Record → Stop writes a file, and it is one of ours (magic bytes).
//   2. The file carries NO plaintext codec/config strings — the header is sealed, so a
//      recording does not even disclose its own resolution.
//   3. The correct link opens it and paints real pixels.
//   4. A DIFFERENT link does not open it, and says so without distinguishing "wrong key"
//      from "not our file".
//   5. /play opens the same file with a pasted key and no live stream — which is the case that
//      matters for an archive, since the broadcast is over by definition. And a wrong key
//      pasted there is refused too.
//
// Exit 0 = pass. Exit 1 = fail, with the reason on stderr.

import puppeteer from "puppeteer";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSeedGate } from "./lib/seed-gate.mjs";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
const STEP = (m) => console.log(`  ${m}`);
const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exitCode = 1;
};

const LAUNCH = {
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
};

const dlDir = mkdtempSync(join(tmpdir(), "e2emoq-rec-"));
const browser = await puppeteer.launch(LAUNCH);

try {
  // ── broadcaster ────────────────────────────────────────────────────────────────
  const bc = await browser.newPage();
  STEP(`opening ${ORIGIN}/broadcast`);
  await bc.goto(`${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await clearSeedGate(bc, STEP);
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  // The broadcaster's own URL bar carries a DECOY fragment on purpose, so that a broadcaster
  // who copies from the address bar cannot accidentally hand out a link that works. The real
  // one lives on the copy button.
  await bc.waitForFunction(
    () => document.querySelector("[data-share-url]")?.getAttribute("data-share-url")?.includes("#k="),
    { timeout: 30000 }
  );
  const shareUrl = await bc.$eval("[data-share-url]", (e) => e.getAttribute("data-share-url"));
  if (!/#k=/.test(shareUrl)) throw new Error(`broadcaster produced no #k= link: ${shareUrl}`);
  STEP(`share link ready (${shareUrl.split("#")[0]})`);

  // ── viewer records ─────────────────────────────────────────────────────────────
  const vw = await browser.newPage();
  const cdp = await vw.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir });

  await vw.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await vw.waitForSelector("#rec-toggle", { timeout: 30000 });

  // Record only once frames are actually arriving; starting earlier captures nothing and the
  // test then fails for a reason that has nothing to do with recording.
  await vw.waitForFunction(
    () => [...document.querySelectorAll("canvas")].some((c) => c.width >= 320),
    { timeout: 45000 }
  );
  STEP("viewer is decoding — starting recording");
  await vw.click("#rec-toggle");
  await new Promise((r) => setTimeout(r, 8000));
  await vw.click("#rec-toggle");

  await vw.waitForFunction(
    () => /Saved/.test(document.getElementById("rec-status")?.textContent || ""),
    { timeout: 20000 }
  );
  const saved = await vw.$eval("#rec-status", (e) => e.textContent);
  STEP(`stop reported: ${saved.trim()}`);

  // ── 1. a file exists, and it is ours ───────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 1500));
  const files = readdirSync(dlDir).filter((f) => f.endsWith(".e2emoq"));
  if (!files.length) throw new Error(`no .e2emoq file landed in ${dlDir}`);
  const buf = readFileSync(join(dlDir, files[0]));
  STEP(`file: ${files[0]} (${(buf.length / 1024).toFixed(0)} KB)`);

  if (buf.subarray(0, 8).toString("latin1") !== "E2MQREC1") {
    fail("file does not start with the E2MQREC1 magic");
  }
  if (buf.length < 4096) fail(`file is implausibly small (${buf.length} bytes) — captured nothing?`);

  // ── 2. nothing readable in it ──────────────────────────────────────────────────
  // A sealed header means the config words never appear. If any do, the header shipped in the
  // clear and a recording discloses its own codec and resolution to anyone holding the file.
  const asText = buf.toString("latin1");
  const leaked = ["codec", "avc1", "vp09", "opus", "codedWidth", "description"].filter((w) =>
    asText.includes(w)
  );
  if (leaked.length) fail(`plaintext config strings found in the file: ${leaked.join(", ")}`);
  else STEP("header is sealed — no plaintext config in the file");

  // ── 3. the right link opens it ─────────────────────────────────────────────────
  const rp = await browser.newPage();
  rp.on("console", (m) => {
    const t = m.text();
    if (/recording|decode|codec|config/i.test(t)) console.log(`     [replay] ${t}`);
  });
  rp.on("pageerror", (e) => console.log(`     [replay pageerror] ${e.message}`));
  await rp.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await rp.waitForSelector("#rec-open", { timeout: 30000 });
  const input = await rp.$("#rec-open");
  await input.uploadFile(join(dlDir, files[0]));

  await rp.waitForFunction(() => !document.getElementById("replay-panel")?.classList.contains("hidden"), {
    timeout: 20000,
  });
  // Real pixels, not a black canvas: a replay panel that opened but decoded nothing looks
  // identical to one that worked, right up until someone tries to watch it.
  const lit = await rp.waitForFunction(
    () => {
      const c = document.getElementById("replay-canvas");
      if (!c || c.width < 64) return false;
      const p = document.createElement("canvas");
      p.width = 32;
      p.height = 18;
      const x = p.getContext("2d", { willReadFrequently: true });
      try { x.drawImage(c, 0, 0, 32, 18); } catch { return false; }
      const d = x.getImageData(0, 0, 32, 18).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) n++;
      return n > 40 ? n : false;
    },
    { timeout: 30000 }
  ).catch(() => null);
  if (lit) STEP(`replay painted real pixels (${await lit.jsonValue()} lit of 576)`);
  else fail("replay panel opened but never painted a decoded frame");

  // ── 4. THE NEGATIVE: a different link must not open it ─────────────────────────
  const wrong = await browser.newPage();
  const wrongUrl = shareUrl.replace(/#k=[^&]*/, "#k=" + "A".repeat(43));
  await wrong.goto(wrongUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await wrong.waitForSelector("#rec-open", { timeout: 30000 });
  await (await wrong.$("#rec-open")).uploadFile(join(dlDir, files[0]));
  await new Promise((r) => setTimeout(r, 4000));

  const wrongStatus = await wrong.$eval("#rec-status", (e) => e.textContent || "");
  const replayOpen = await wrong.evaluate(
    () => !document.getElementById("replay-panel")?.classList.contains("hidden")
  );
  if (replayOpen) fail("a DIFFERENT key opened the recording — the file is not protected");
  else if (!/Could not open|needs its key/.test(wrongStatus)) {
    fail(`wrong key gave an unexpected message: ${JSON.stringify(wrongStatus)}`);
  } else STEP("wrong key refused, with the same message a non-file gets");

  // ── 5. /play — the archive door ────────────────────────────────────────────────
  // Deliberately with the broadcaster still up but never consulted: /play must work with no
  // stream, no route, and no network beyond loading the page itself.
  const key = shareUrl.split("#k=")[1].split("&")[0];
  const pp = await browser.newPage();
  pp.on("pageerror", (e) => console.log(`     [play pageerror] ${e.message}`));
  await pp.goto(`${ORIGIN}/play`, { waitUntil: "networkidle2", timeout: 60000 });
  await pp.waitForSelector("#play-file", { timeout: 20000 });

  await (await pp.$("#play-file")).uploadFile(join(dlDir, files[0]));
  // The stream id should fill itself in from the filename; a user who has to know what a
  // "stream id" is has already been failed by the page.
  const auto = await pp.$eval("#play-id", (e) => e.value);
  if (auto === files[0].replace(/\.e2emoq$/, "")) STEP(`/play filled the stream id from the filename (${auto})`);
  else fail(`/play did not fill the stream id from the filename (got ${JSON.stringify(auto)})`);

  await pp.evaluate((k) => {
    document.getElementById("play-key").value = k;
  }, key);
  await pp.click("#play-go");

  const playLit = await pp
    .waitForFunction(
      () => {
        const c = document.getElementById("play-canvas");
        if (!c || c.width < 64) return false;
        const p = document.createElement("canvas");
        p.width = 32; p.height = 18;
        const x = p.getContext("2d", { willReadFrequently: true });
        try { x.drawImage(c, 0, 0, 32, 18); } catch { return false; }
        const d = x.getImageData(0, 0, 32, 18).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) n++;
        return n > 40 ? n : false;
      },
      { timeout: 40000, polling: 500 }
    )
    .catch(() => null);
  if (playLit) STEP(`/play decoded the recording (${await playLit.jsonValue()} lit of 576)`);
  else {
    const why = await pp.$eval("#play-note", (e) => e.textContent || "");
    fail(`/play never painted a frame — note=${JSON.stringify(why)}`);
  }

  // Negative: a wrong key must be refused, with one message for every wrong input.
  const wrongPlay = await browser.newPage();
  await wrongPlay.goto(`${ORIGIN}/play`, { waitUntil: "networkidle2", timeout: 60000 });
  await wrongPlay.waitForSelector("#play-file", { timeout: 20000 });
  await (await wrongPlay.$("#play-file")).uploadFile(join(dlDir, files[0]));
  await wrongPlay.evaluate(() => {
    document.getElementById("play-key").value = "A".repeat(43);
  });
  await wrongPlay.click("#play-go");
  await wrongPlay.waitForFunction(
    () => /Could not open/.test(document.getElementById("play-note")?.textContent || ""),
    { timeout: 20000, polling: 500 }
  ).catch(() => null);
  const wrongNote = await wrongPlay.$eval("#play-note", (e) => e.textContent || "");
  // Count PIXELS, not width. An untouched canvas reports 300x150 by default, so a dimension
  // check passes on a player that decoded absolutely nothing — which is exactly the state a
  // wrong key should produce, and exactly what this assertion exists to catch.
  const painted = await wrongPlay.evaluate(() => {
    const c = document.getElementById("play-canvas");
    if (!c) return false;
    const p = document.createElement("canvas");
    p.width = 32;
    p.height = 18;
    const x = p.getContext("2d", { willReadFrequently: true });
    try { x.drawImage(c, 0, 0, 32, 18); } catch { return false; }
    const d = x.getImageData(0, 0, 32, 18).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) n++;
    return n > 40;
  });
  if (painted) fail("/play decoded a recording with the WRONG key");
  else if (!/Could not open/.test(wrongNote)) fail(`/play gave an unexpected message: ${JSON.stringify(wrongNote)}`);
  else STEP("/play refused a wrong key");

  await bc.close();
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
}

console.log(process.exitCode ? "\nrecording: FAILED" : "\nrecording: PASS");
