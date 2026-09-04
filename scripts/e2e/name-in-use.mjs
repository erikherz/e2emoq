// A broadcaster locked out of their own link, and the three things that stop it.
//
// Reported as "No relay assigned" in the Server Status card, on one machine, persistently.
// The chain, all of it in this repo:
//
//   1. /broadcast rewrites the URL to /?stream=<id>, deliberately, so a refresh resumes the
//      same broadcast. The id therefore OUTLIVES the page.
//   2. The publisher claim keypair does not — publisher-claim.ts: "Never persisted: a reload
//      deliberately loses it."
//   3. logBroadcastEnd fired only on beforeunload, as a plain fetch, which is routinely
//      cancelled as the document goes away. auth.ts says exactly this about the VIEWER path,
//      where it was fixed; the broadcast path never was. So the row stays open.
//   4. nameIsAvailable() sees a row with ended_at IS NULL and a different publisher_pubkey and
//      answers 409 "that broadcast name is in use".
//   5. The client threw that away and showed "(no relay assigned)" — one phrase for eight
//      unrelated refusals — so nothing on screen or in the panel named a cause or a way out.
//
// Nothing reaped those rows, so the lockout was permanent. Production held 131 of them,
// blocking 131 ids, the oldest 16 days old.
//
//   node --env-file=/tmp/wf.env scripts/e2e/name-in-use.mjs [origin]
//
// Needs a publish key and a deployed origin: the 409 comes from the Worker and D1, so there is
// nothing to assert against a local preview. Cleans up the row it opens.

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY;
if (!PK) throw new Error("WF_PUBLISH_KEY not set — see scripts/e2e/README or /tmp/wf.env");

const failures = [];
const fail = (m) => {
  failures.push(m);
  process.exitCode = 1;
};
const check = (label, got, want) => {
  const ok = want instanceof RegExp ? want.test(String(got)) : got === want;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${want})`}`);
  if (!ok) fail(label);
};

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

// What POST /api/stats/broadcast actually answered, and what the page says about it.
const watchStart = (page, sink) => {
  page.on("response", async (r) => {
    if (!r.url().includes("/api/stats/broadcast") || /\/end$/.test(r.url())) return;
    let body = "";
    try { body = await r.text(); } catch { /* already consumed */ }
    sink.push({ status: r.status(), body });
  });
};

const state = (page) =>
  page.evaluate(() => {
    const n = document.querySelector(".capture-notice");
    return {
      notice: n && !n.classList.contains("hidden") ? (n.textContent || "").trim() : "",
      action: n?.querySelector(".notice-action")?.textContent?.trim() || "",
      // #server-panel, not the bare class: the browser-support card uses the same class
      // name and comes first in the document, so a loose selector reads the wrong card.
      relayPanel: (document.querySelector("#server-panel .server-status-summary")?.textContent || "")
        .replace(/\s+/g, " ").trim(),
      streamId: new URLSearchParams(location.search).get("stream"),
    };
  });

const cameraOn = async (page) => {
  await page.waitForSelector("button.toggle-btn", { timeout: 30000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button.toggle-btn")]
      .find((x) => (x.title || "").toLowerCase().startsWith("camera"))
      ?.click();
  });
};

// Every broadcast row this test opens, so none is left behind locking an id.
const opened = [];
const remember = (calls) => {
  for (const c of calls) {
    try {
      const id = JSON.parse(c.body || "{}").id;
      if (id) opened.push(id);
    } catch { /* a refusal, not a row */ }
  }
};

try {
  // ── 1. A broadcast whose /end never arrives. ──────────────────────────────────────
  console.log("\n  a broadcast that ends the way a crashed tab ends it");
  const a = await browser.newPage();
  const started1 = [];
  watchStart(a, started1);
  // A crash, a killed tab or a dead battery: the browser never delivers the end, by EITHER
  // route. Both have to be defeated — an earlier version of this test only aborted the fetch,
  // and the new sendBeacon path quietly delivered it, so the test failed by being fixed. That
  // is worth keeping in mind when reading a green: this scenario now takes deliberate effort
  // to produce, which is the point of the change.
  await a.evaluateOnNewDocument(() => {
    navigator.sendBeacon = () => true; // claims success, sends nothing
  });
  await a.setRequestInterception(true);
  a.on("request", (req) => {
    if (/\/api\/stats\/broadcast\/\d+\/end/.test(req.url())) return req.abort();
    req.continue();
  });
  await a.goto(`${ORIGIN}/broadcast?pk=${encodeURIComponent(PK)}`, { waitUntil: "networkidle2", timeout: 60000 });
  await cameraOn(a);
  await new Promise((r) => setTimeout(r, 9000));
  const first = await state(a);
  const streamId = first.streamId;
  check("the first go-live succeeded", started1[0]?.status, 200);
  console.log(`    stream id: ${streamId}`);
  remember(started1);
  await a.close({ runBeforeUnload: false });

  // ── 2. The same id again — which is what a bookmark or a reopened tab is. ─────────
  console.log("\n  reopening the same link, with the keypair gone");
  const b = await browser.newPage();
  const started2 = [];
  watchStart(b, started2);
  await b.goto(`${ORIGIN}/?stream=${streamId}&pk=${encodeURIComponent(PK)}`, { waitUntil: "networkidle2", timeout: 60000 });
  await cameraOn(b);
  await new Promise((r) => setTimeout(r, 9000));
  const stuck = await state(b);
  check("the Worker refuses with 409", started2[0]?.status, 409);
  console.log(`    notice: "${stuck.notice}"`);
  console.log(`    panel:  "${stuck.relayPanel}"`);

  // FIX 1 — the reason reaches the person, instead of "(no relay assigned)" alone.
  check("something on screen explains it", stuck.notice.length > 0, true);
  check("and it names THIS cause, not a generic failure", stuck.notice, /still marked as live|already/i);
  // FIX 3 — and offers the way out, because this one is recoverable in a click.
  check("a recovery control is offered", stuck.action, /new link/i);

  // ── 3. Taking it. ─────────────────────────────────────────────────────────────────
  //
  // No confirm() dialog is expected: capture is on, but the broadcast never started, so there
  // is nobody to cut off. A dialog here would block headless and hang this test — which is
  // itself the assertion.
  console.log("\n  taking the offered way out");
  const started3 = [];
  watchStart(b, started3);
  await b.evaluate(() => document.querySelector(".capture-notice .notice-action")?.click());
  await new Promise((r) => setTimeout(r, 12000));
  const recovered = await state(b);
  console.log(`    new stream id: ${recovered.streamId}`);
  console.log(`    panel:  "${recovered.relayPanel}"`);
  check("the id actually rotated", recovered.streamId !== streamId, true);
  check("the new id goes live", started3.some((r) => r.status === 200), true);
  check("the notice is cleared once it works", recovered.notice, "");
  check("and the panel names a real relay", recovered.relayPanel, /connected/i);

  remember(started3);

  // ── 4. And the abandoned id STAYS taken. ──────────────────────────────────────────
  //
  // Rotating does not free it, and must not: the go-live that failed never got an event id
  // back, so this page never learned which row is in the way — and a page that could close a
  // row it cannot identify is a page that could close someone else's broadcast. The stranded
  // row is the reaper's job (within PUBLISHER_TOKEN_TTL), or the original tab's beacon.
  //
  // Asserted rather than assumed, because "recovery frees the old name" is the tempting wrong
  // model, and a change that made it true would be a real regression in who may end whose
  // broadcast. The cost to a person is nil: they walk away with a working new link, and the
  // old one is one they were about to stop using anyway.
  console.log("\n  the abandoned id is still taken, and that is correct");
  const reuse = await browser.newPage();
  const started4 = [];
  watchStart(reuse, started4);
  await reuse.goto(`${ORIGIN}/?stream=${streamId}&pk=${encodeURIComponent(PK)}`, { waitUntil: "networkidle2", timeout: 60000 });
  await cameraOn(reuse);
  await new Promise((r) => setTimeout(r, 9000));
  check("rotating did not free the old name", started4[0]?.status, 409);
  check("and that page is told the same thing", (await state(reuse)).action, /new link/i);
  remember(started4);
  await reuse.close({ runBeforeUnload: false });
  await b.close({ runBeforeUnload: false });

  if (!failures.length) console.log("\nPASS: a stuck name explains itself and can be escaped");
} catch (e) {
  fail(e.message);
} finally {
  // Close every row opened here, including the deliberately stranded one — otherwise this
  // test leaves behind exactly the bug it is testing for, on a real stream id.
  for (const id of opened) {
    const r = await fetch(`${ORIGIN}/api/stats/broadcast/${id}/end`, { method: "POST" });
    console.log(`  cleanup: ended event ${id} -> HTTP ${r.status}`);
  }
  await browser.close();
  for (const f of failures) console.error(`\nFAIL: ${f}`);
}
