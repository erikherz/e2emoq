// Negative control for the DATAGRAM audio path: prove `#k=` is what grants sound, not just video.
//
//   node scripts/e2e/encrypted-negative-audio.mjs [origin]
//
// WHY A SECOND NEGATIVE CONTROL. encrypted-negative.mjs measures lit pixels on a canvas, so it
// only ever covered video, which reaches the wire through `__mc.write` on a group. Audio over
// QUIC datagrams takes a completely different route: its own seam (`__mc.writeDatagram`), its own
// encrypt call, and a receive path that wraps each datagram as a single-frame group before it
// reaches the shared decrypt seam. A green video result says nothing about any of that. The one
// failure this whole module exists to prevent — a payload reaching the relay in the clear — could
// therefore ship on the audio path with every existing test passing.
//
// So this asserts the same property the video test asserts, on the path the video test cannot
// see: a viewer holding the full share link HEARS the broadcast, and a viewer with the fragment
// stripped — which is exactly the position of our Worker, our database and the CDN — hears
// nothing.
//
// WHAT "HEARS" MEANS HERE. Not decoded frames. lib/audible.mjs taps the node graph terminating at
// `context.destination`, because on 2026-09-10 a dual-publish change decoded and synced audio
// perfectly while producing no sound at all, and three deploys went out green. Counting decodes
// would let a silent build pass this test for the wrong reason, and a negative control that can
// pass for the wrong reason is worse than no negative control.
//
// THE THIRD ASSERTION. The run also proves datagrams actually flowed. Without that, a fallback to
// the group rendition would leave this file quietly re-testing what encrypted-negative.mjs
// already covers while still printing PASS — the exact shape of a test that cannot fail.
import puppeteer from "puppeteer";
import { AUDIBLE_PROBE, readAudible, formatAudible, audibleFailure } from "./lib/audible.mjs";

const ORIGIN = process.argv[2] || "https://e2emoq.com";
const PK = process.env.WF_PUBLISH_KEY || "";
const BROADCAST_URL = `${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`;
const WATCH_MS = 14000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

/** Read the diag panel, so "datagrams flowed" is observed rather than assumed. */
const readPanel = (page) =>
  page.evaluate(() => {
    const panel = [...document.querySelectorAll("pre,div")].find((n) => /TRANSPORT=/.test(n.textContent || ""));
    const t = panel?.textContent ?? "";
    const num = (re) => {
      const m = t.match(re);
      return m ? Number(m[1]) : -1;
    };
    return {
      found: !!panel,
      dgramIn: num(/dgram\s+max=\S+\s+in=(\d+)/),
      transport: (t.match(/TRANSPORT=(\S+)/) || [])[1] ?? "?",
    };
  });

const watch = async (url, label) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.evaluateOnNewDocument(AUDIBLE_PROBE);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

  // Unmute exactly as a listener would. A muted viewer is silent for reasons that have nothing
  // to do with encryption, and would make the deprived arm pass for free.
  await page.evaluate(() => {
    const el = document.querySelector("moq-watch");
    if (el) {
      el.muted = false;
      el.paused = false;
    }
    document.querySelectorAll("video").forEach((v) => {
      v.muted = false;
      void v.play?.().catch(() => {});
    });
  });

  await sleep(WATCH_MS);
  const audible = await readAudible(page);
  const panel = await readPanel(page);
  console.log(`  ${label}\n       ${formatAudible(audible)}\n       transport=${panel.transport} datagramsIn=${panel.dgramIn}`);
  await ctx.close();
  return { audible, panel };
};

let failed = false;
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  failed = true;
};

try {
  const bc = await browser.newPage();
  await bc.goto(BROADCAST_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');

  // Pace the second click. Zero-gap toggles raced the state reconciler and published 3-byte
  // Opus silence under a lit button — a broadcast that is silent for a reason unrelated to
  // encryption would make the deprived arm below pass without proving anything.
  await sleep(2500);
  const mic = await bc.$('button.publish-btn[title^="Audio"]');
  if (!mic) throw new Error("no Audio toggle — an audio test without audio proves nothing");
  await mic.click();
  await sleep(1000);

  const micLit = await bc.evaluate(
    () => !!document.querySelector('button.publish-btn[title^="Audio"]')?.classList.contains("toggle-on")
  );
  if (!micLit) throw new Error("the Audio toggle never lit, so no audio was ever published");

  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { polling: 500, timeout: 30000 });
  const share = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
  if (!/#k=/.test(share)) throw new Error(`share link carries no #k= secret: ${share}`);

  const [base, frag] = share.split("#");
  console.log(`  broadcasting ${base}\n`);
  await sleep(8000);

  // Control first. If this arm is silent the broadcast is dead and the deprived arm is
  // meaningless — silence proves nothing when everything is silent.
  const withKey = await watch(`${base}?diag=1#${frag}`, "WITH #k= (a real share link) ");
  const withoutKey = await watch(`${base}?diag=1`, "WITHOUT #k= (our own position)");

  // A viewer holding a CORRUPTED key. This started out as an attempt to show "real ciphertext
  // arrived and was useless", which is the claim the arm above cannot make: with no fragment at
  // all the page never arms and never receives a byte, so its silence shows only that the link is
  // needed to start.
  //
  // It does not show that, and the reason is worth keeping. The two gates are layered: the
  // `/route` tag is derived from the SAME link secret (deriveRouteTag), so a viewer with a
  // corrupted `#k=` computes a wrong tag, is refused a relay token, and never connects. The
  // content key is never reached, because the connection gate fires first.
  //
  // So this arm asserts what is actually true and is worth locking in — a bad key costs an
  // attacker not just the content but the connection, and therefore cannot be used to draw CDN
  // egress on our account. The "ciphertext arrived, wrong key, no plaintext" case is proved
  // deterministically offline instead, in sframe-rekey.mjs, where a viewer holding a superseded
  // key is handed genuine datagram frames and cannot open them.
  const k = frag.replace(/^k=/, "");
  const flipped = (k[0] === "A" ? "B" : "A") + k.slice(1);
  const wrongKey = await watch(`${base}?diag=1#k=${flipped}`, "WITH A CORRUPTED #k= (refused upstream)");

  const controlWhy = audibleFailure(withKey.audible);
  if (controlWhy) {
    console.error(
      `\nINCONCLUSIVE: the control viewer heard nothing — ${controlWhy}.\n` +
        `Nothing can be concluded about the deprived viewer from a run where the broadcast itself was silent.`
    );
    process.exitCode = 1;
  } else {
    if (!audibleFailure(withoutKey.audible)) {
      fail(
        "a viewer WITHOUT the fragment produced sound — audio is reaching the speakers without the key, " +
          "which means the datagram path is publishing something decodable without the link"
      );
    }

    if (!audibleFailure(wrongKey.audible)) {
      fail(
        "a viewer holding a corrupted key produced sound — the datagram payload is decodable without " +
          "the correct secret, so the audio crossing the relay is not protected by it"
      );
    }

    // It must be refused BEFORE any media moves. If this ever starts receiving datagrams, the
    // route tag has stopped gating the connection and a stranger with a bad key can bill us for
    // CDN egress — a different failure from a decryption one, and this is the only test watching
    // for it.
    if (wrongKey.panel.dgramIn > 0) {
      fail(
        `a viewer with a corrupted key still received ${wrongKey.panel.dgramIn} datagrams — the route ` +
          `tag is no longer gating the connection, so a bad key now costs us egress`
      );
    }

    // Prove the path under test was actually the path under test.
    if (!withKey.panel.found) {
      fail("the diag panel could not be read, so 'datagrams flowed' is unverified and this run tested an unknown path");
    } else if (!(withKey.panel.dgramIn > 0)) {
      fail(
        `the control viewer received ${withKey.panel.dgramIn} datagrams — audio fell back to the group ` +
          `rendition, so this run re-tested what encrypted-negative.mjs already covers and left the ` +
          `datagram seam untested`
      );
    }

    if (!failed) {
      console.log(
        `\nPASS: audible with the right fragment over ${withKey.panel.dgramIn} datagrams; silent with no ` +
          `fragment;\nand refused outright with a corrupted one, before any media moved.\n` +
          `\nSCOPE: this shows the deployed datagram path encrypts and that the link is the only way in.\n` +
          `The "real ciphertext, wrong content key, no plaintext" case is proved in sframe-rekey.mjs,\n` +
          `because the route tag refuses a bad key upstream and it cannot be reached from a browser.`
      );
    }
  }
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
}

if (failed) process.exitCode = 1;
