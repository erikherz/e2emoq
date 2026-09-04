// Front camera <-> back camera: where the control appears, and what must NOT happen when it
// is used.
//
//   node scripts/e2e/camera-flip.mjs [origin]
//
// WHAT THIS CANNOT TEST. Headless Chrome exposes one fake camera and reports no facingMode on
// it, so the thing a person actually cares about — that the picture changes to the other side
// of the phone — is not observable here and never will be. That was confirmed by hand on an
// iPhone on 2026-08-30, and any change to the switch has to be confirmed there again.
//
// What IS observable, and is where this would break silently:
//
//   1. PHONE ONLY, and inside More. A desktop must not grow a control that relabels itself
//      "front"/"back" for cameras pointing wherever they were put.
//   2. Shown on a phone reporting a SINGLE videoinput. This is the regression that shipped on
//      2026-08-30 and hid the control on every iPhone: it used to require enumerateDevices to
//      report two cameras, and iOS Safari reports one for a phone that has three, exposing
//      front and back through facingMode instead. Chrome's fake device is a single camera, so
//      running with no device stub at all is the faithful reproduction of an iPhone here.
//   3. The request actually changes: first getUserMedia asks for `user`, the second for
//      `environment`. Constraints are recorded rather than inferred from the picture.
//   4. NO capture-failure notice appears. switchCamera stops the live track deliberately, and
//      the camera-loss detection added for Windows listens for exactly that track ending. If
//      MediaStreamTrack.stop() ever started firing `ended`, every flip would tell the
//      broadcaster their camera had been taken away — a false alarm on a working camera.
//   5. The composite keeps painting across the switch. The published track is the canvas, so
//      a flip must be invisible to viewers; a frozen canvas would mean it is not.
//
// NEEDS WF_PUBLISH_KEY, AND A DEPLOYED ORIGIN. Every click here is a real one, and switching
// the camera on without a key raises the full-screen "A publish key is needed" modal — which
// correctly eats the next tap. Suites that click through page.evaluate() never notice that
// modal; this one must, because a control a person cannot reach is not a working control.
//
// VISIBILITY IS MEASURED, NOT ASKED FOR. An earlier version of this file read `el.hidden` and
// passed while the button was plainly on screen: .publish-btn sets display:inline-flex, which
// beats the UA stylesheet's [hidden] rule. Anything claiming a control is out of sight here
// goes through getClientRects().

import puppeteer from "puppeteer";
import { clearSeedGate } from "./lib/seed-gate.mjs";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
const URL = `${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`;

if (!PK) {
  console.error(
    "camera-flip needs WF_PUBLISH_KEY. Without it, switching the camera on raises the\n" +
    "publish-key modal, which covers the control bar — every real click below would be\n" +
    "swallowed and the failures would point anywhere but here."
  );
  process.exit(1);
}

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) {
    failures.push(name);
    process.exitCode = 1;
  }
};

// enumerateDevices is deliberately NOT stubbed. Chrome's fake device is a single camera, which
// is exactly what iOS Safari reports for a multi-camera iPhone — so the unmodified environment
// is the honest one, and a stub adding a second device would hide the bug this file now guards.
//
// getUserMedia is left alone too; every constraint it is asked for is recorded, which is what
// the facingMode assertions read.
const PREP = () => {
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__videoAsks = [];
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (c && c.video) window.__videoAsks.push(JSON.stringify(c.video));
    return gum(c);
  };
};

// A checksum of what is painted. A frozen composite is still a full frame of lit pixels; the
// whole failure mode is that it stops CHANGING.
const SAMPLE = () => {
  const cv = document.querySelector("canvas.pip-canvas");
  if (!cv) return null;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 36;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(cv, 0, 0, 64, 36);
  const d = x.getImageData(0, 0, 64, 36).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum = (sum + d[i] * (i + 1)) >>> 0;
  return sum;
};

const STATE = () => {
  const f = document.querySelector("#flip-camera-btn");
  const n = document.querySelector(".capture-notice");
  const cam = [...document.querySelectorAll("button.toggle-btn")].find((x) =>
    (x.title || "").toLowerCase().startsWith("camera")
  );
  return {
    exists: !!f,
    // Rendered, not merely un-flagged. See the header.
    shown: !!f && f.getClientRects().length > 0,
    inMenu: f?.parentElement?.id === "publish-more-panel",
    title: f?.title || "",
    aria: f?.getAttribute("aria-label") || "",
    cameraOn: !!cam?.classList.contains("toggle-on"),
    note: n && !n.classList.contains("hidden") ? (n.textContent || "").trim() : "",
    asks: window.__videoAsks || [],
  };
};

const clickCamera = () =>
  [...document.querySelectorAll("button.toggle-btn")]
    .find((x) => (x.title || "").toLowerCase().startsWith("camera"))
    ?.click();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Set only when the run reaches the end. Without it, anything that throws mid-run lands in
// `finally` with an empty failure list and prints PASS — which is how this file reported a
// clean pass while crashing on an unsupported media feature.
let completed = false;

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

/** A page with the fake second camera, the seed gate cleared, and the More panel open. */
const openPage = async (touch) => {
  const page = await browser.newPage();
  if (touch) {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    // Straight to CDP: puppeteer's emulateMediaFeatures whitelists a handful of features and
    // `hover`/`pointer` are not among them, but the protocol underneath accepts any of them.
    // These two are the whole of what .cap-mobile keys off, so nothing else stands in for it.
    const cdp = await page.createCDPSession();
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "hover", value: "none" },
        { name: "pointer", value: "coarse" },
      ],
    });
  } else {
    await page.setViewport({ width: 1280, height: 900 });
  }
  await page.evaluateOnNewDocument(PREP);
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#more-btn", { timeout: 30000 });
  await clearSeedGate(page, (m) => console.log("  ..  " + m));
  await page.click("#more-btn"); // the panel starts closed
  await page.waitForFunction(
    () => !document.querySelector("#publish-more-panel")?.classList.contains("hidden"),
    { timeout: 10000 }
  );
  return page;
};

try {
  // ══ PHONE ═══════════════════════════════════════════════════════════════════════════
  console.log("\nphone (hover:none, pointer:coarse)\n");
  const phone = await openPage(true);

  let s = await phone.evaluate(STATE);
  check("the control is built", s.exists);
  check("it lives in the More panel, not the row", s.inMenu);
  check("not shown while the camera is off", !s.shown);

  await phone.evaluate(clickCamera);
  await phone.waitForFunction(
    () => document.querySelector("#flip-camera-btn")?.getClientRects().length > 0,
    { timeout: 30000 }
  );

  s = await phone.evaluate(STATE);
  check("shown whenever the camera is live, on ONE reported videoinput", s.shown);
  check("offers the camera you are NOT on", /back/i.test(s.title), `title is "${s.title}"`);
  check("carries that name for a screen reader too", s.aria === s.title, s.aria);
  check(
    "first request asked for the front camera",
    /"user"/.test(s.asks[0] || ""),
    s.asks[0] || "(nothing recorded)"
  );

  // A real mouse/touch click, so an overlay eating it would show up here.
  await phone.click("#flip-camera-btn");
  await phone.waitForFunction(() => (window.__videoAsks || []).length >= 2, { timeout: 30000 });
  await wait(1500); // let the new camera settle and any notice appear

  s = await phone.evaluate(STATE);
  check(
    "second request asked for the back camera",
    /"environment"/.test(s.asks[1] || ""),
    s.asks[1] || "(nothing recorded)"
  );
  check("now offers the way back", /front/i.test(s.title), `title is "${s.title}"`);
  check("Camera stayed on", s.cameraOn);
  check(
    "a deliberate stop is NOT reported as the camera being taken away",
    s.note === "",
    s.note ? `notice says "${s.note}"` : ""
  );

  const after = await phone.evaluate(SAMPLE);
  await wait(700);
  const later = await phone.evaluate(SAMPLE);
  check(
    "the canvas is still painting after the flip",
    after !== null && after !== later,
    `${after} then ${later}`
  );

  await phone.evaluate(clickCamera);
  await wait(1200);
  s = await phone.evaluate(STATE);
  check("hidden again once the camera is switched off", !s.shown);

  // ══ DESKTOP ═════════════════════════════════════════════════════════════════════════
  //
  // Same two cameras, same open menu, camera running. It must still not be there.
  console.log("\ndesktop (pointer:fine)\n");
  const desk = await openPage(false);
  await desk.evaluate(clickCamera);
  await desk.waitForFunction(() => !!document.querySelector("canvas.pip-canvas"), {
    timeout: 30000,
  });
  await wait(1500);

  s = await desk.evaluate(STATE);
  check("camera is running", s.cameraOn);
  check("not offered on a pointer device", !s.shown);
  completed = true;
} finally {
  await browser.close();
  if (!completed) {
    process.exitCode = 1;
    console.log("\nFAIL: the run did not finish — see the error above.");
  }
  console.log(
    completed && failures.length === 0
      ? "\nPASS: phone-only, inside More, present on a single-videoinput phone, changes the " +
        "request, and raises no camera-loss " +
        "alarm.\nStill unverified off-device: that the picture changes sides. Confirmed by " +
        "hand on iPhone 2026-08-30; re-check there after any change."
      : failures.length
        ? `\nFAIL: ${failures.length} check(s) failed.`
        : ""
  );
}
