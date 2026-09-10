import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Force the MoQ stack to use WebTransport ONLY (no WebSocket, no race).
//
// @moq/net's connect() races a WebSocket fallback against WebTransport by
// default (500ms head start, Promise.any). tinymoq has no WebSocket endpoint
// (the relay is built without it), so the wss:// leg always fails and only adds
// latency + console noise. The web components expose no option to disable it, so
// we patch the dependency at build time: flip the WS gate from opt-out
// (`enabled !== false`) to opt-in (`enabled === true`). Since nothing enables
// WebSocket, connect() then only ever attempts WebTransport — no fallback, no race.
//
// Note: this drops the WS fallback for browsers without native WebTransport
// (old Safari, Firefox) — but those can't talk to tinymoq anyway (WT-only relay).
function moqWebTransportOnly(): Plugin {
  const WS_GATE = "props?.websocket?.enabled !== false";
  // The mirror of the WS gate. Erik's iPhone runs every session over WebSocket while still
  // HAVING the WebTransport API — it loses (or never completes) the race — and that combination
  // could not be reproduced locally, which is why this investigation cost eight remote round
  // trips at one broadcast restart each.
  //
  // ?wsonly=1 forces the same state on any machine: WebTransport is left present, so the app
  // takes the same branches it does on the phone, but connect() never attempts the QUIC leg and
  // the qmux/WebSocket path wins by default. That is a faithful reproduction, unlike deleting
  // globalThis.WebTransport, which would instead route through VE's own polyfill — a different
  // code path from the one the phone actually uses.
  // 0.3.5 factored this into isWebTransportSupported(); it used to be an inline
  // `globalThis.WebTransport && !isFirefox`. Guessing the old shape is what the buildEnd warning
  // caught — and had that warning not existed, ?wsonly=1 would have accepted the flag, quietly
  // run over WebTransport anyway, and "reproduced" the phone by proving the opposite.
  const WT_GATE = "isWebTransportSupported() ?";
  let patched = 0;
  let wtPatched = 0;
  return {
    name: "moq-webtransport-only",
    enforce: "pre",
    transform(code, id) {
      // Match @moq/net's connection/connect.js across all (possibly nested) copies.
      if (id.includes("@moq") && code.includes("connectWebSocket") && code.includes(WS_GATE)) {
        patched++;
        // RUNTIME gate rather than a build-time removal. Erik's iPhone runs its whole session
        // over WebSocket — the fallback wins the race even with QUIC's 500ms head start — and
        // qmux has no datagram surface, so audio published as datagrams never arrives there
        // while video keeps playing over groups.
        //
        // ?wtonly=1 disables the fallback for one page load, which separates the two causes that
        // need different fixes: if the session then connects over WebTransport, QUIC works and
        // the race is merely losing (bias it). If it fails to connect at all, QUIC is blocked on
        // that network and datagrams can never reach that viewer, making dual-publish the only
        // route.
        //
        // Left as opt-in: the WebSocket fallback is deliberately on here for iPhone and older
        // Safari, and removing it wholesale would strand exactly the viewers it exists for.
        let out = code.replace(
          WS_GATE,
          "(globalThis.__VIVOH_WT_ONLY__ ? false : props?.websocket?.enabled !== false)"
        );
        if (out.includes(WT_GATE)) {
          wtPatched++;
          // __VIVOH_WT_SAFARI__ bypasses upstream's UA ban. @moq/net 0.3.5 refuses WebTransport
          // for ALL Safari via `browser.satisfies({ safari: "<0" })` — a version range nothing
          // can match — citing webkit.org/show_bug.cgi?id=319818 and moq-dev/moq#2388, which is
          // OUR bug report: "roughly 7,600 of them or 16 MiB on one session, whichever comes
          // first". So Safari never lost a race here; it was never entered into one.
          //
          // The ban is a UA match, not a feature test, so it also catches macOS/Windows Safari,
          // and it MISSES iOS Chrome (Bowser reads CriOS as "chrome") which is WebKit underneath
          // and has the same defect.
          //
          // Re-enabling is worth testing precisely because the ban's premise is the stream
          // ceiling, and datagram audio removes ~99% of the streams. When bypassed we still
          // require the API to exist — this overrides upstream's judgement, not physics.
          out = out.replace(
            WT_GATE,
            "(!globalThis.__VIVOH_WS_ONLY__ && (globalThis.__VIVOH_WT_SAFARI__ ? typeof globalThis.WebTransport !== \"undefined\" : isWebTransportSupported())) ?"
          );
        }
        return { code: out, map: null };
      }
      return null;
    },
    buildEnd() {
      if (patched === 0) {
        this.warn(
          "moq-transport-gates: did not patch the WS gate in any @moq/net connect.js — the string may have changed upstream; ?wtonly=1 will silently do nothing."
        );
      }
      if (wtPatched === 0) {
        this.warn(
          "moq-transport-gates: did not patch the WT gate — ?wsonly=1 will silently do nothing, which means a WebSocket reproduction would quietly run over WebTransport and 'prove' the wrong thing."
        );
      }
      // eslint-disable-next-line no-console
      console.log(`moq-transport-gates: ws-gate=${patched} wt-gate=${wtPatched} (runtime ?wtonly=1 / ?wsonly=1)`);
    },
  };
}

// Relay-blind end-to-end media encryption: patch the @moq media-frame seams.
//
// There is no public hook in @moq/publish or @moq/watch to touch the encoded
// chunk bytes, so — exactly like moqWebTransportOnly above — we patch the
// dependency at build time. Three seams, all in readable (non-minified) source:
//
//   1. ENCRYPT video — @moq/hang/container/legacy.js `Producer.encode`
//      (video publishes through Legacy.Producer → group.writeFrame).
//   2. ENCRYPT audio — @moq/net/.../track.js `Track.writeFrame`
//      (audio publishes one group per frame via Track.writeFrame).
//   3. DECRYPT both  — @moq/hang/container/consumer.js, before Format.decode
//      (the single media read site for both audio and video).
//
// Each seam routes through globalThis.__VIVOH_MEDIA_CRYPTO__ (installed by
// src/crypto/media-crypto.ts only when a key is armed). With nothing armed the
// global is absent and every seam is byte-for-byte upstream behavior. The
// catalog uses writeJson (a different path) so codec config stays in the clear.
//
// FAIL-CLOSED: buildEnd throws if any seam did not patch — we never ship a
// build that could leave a media payload path unencrypted while the feature is
// believed active. (A future @moq upgrade that changes these strings will fail
// the build loudly rather than silently publish plaintext.)
// The @moq versions these seams were read against and re-derived for. A string match proves
// only that a string matched — @moq/net's writeFrame body was byte-identical across 0.1.5 and
// 0.3.5 while its argument changed from bytes to an object, so the audio seam patched happily
// into a shape it no longer understood. Pinning the versions turns that class of silent drift
// into a build failure with an instruction attached.
//
// Bumping a version here is a deliberate act: re-read all three seams in the new sources first,
// then change these, then run scripts/e2e/encrypted-negative.mjs against a deploy.
const SEAMS_DERIVED_FOR: Record<string, string> = {
  "@moq/net": "0.3.5",
  "@moq/hang": "0.4.3",
};

function mediaCryptoPatch(): Plugin {
  // --- seam 1: video encrypt (Producer.encode in legacy.js) ---
  // Re-derived for @moq/hang 0.4.3. Two things changed from 0.2.11: the group is now indexed
  // into a timeline the moment it opens, and writeFrame takes a {payload, timestamp} object
  // rather than bare bytes. The timeline call is preserved verbatim — it is not ours to drop,
  // and losing it would break seeking while leaving playback looking fine.
  const VIDEO_FIND = `    encode(data, timestamp, keyframe) {
        if (keyframe) {
            this.#group?.close();
            this.#group = this.#track.appendGroup();
            // Index the group the moment it opens: its start is this keyframe's timestamp.
            this.#timeline?.record(this.#group.sequence, timestamp);
        }
        else if (!this.#group) {
            throw new Error("must start with a keyframe");
        }
        this.#group?.writeFrame({
            payload: encodeFrame(data, timestamp),
            timestamp: Time.Timestamp.fromMicros(timestamp),
        });
    }`;
  const VIDEO_REPLACE = `    encode(data, timestamp, keyframe) {
        const __mc = globalThis.__VIVOH_MEDIA_CRYPTO__;
        const __enc = !!(__mc && __mc.shouldEncrypt(this.#track?.name));
        if (keyframe) {
            const __old = this.#group;
            if (__old) { __enc ? __mc.closeGroup(__old) : __old.close(); }
            this.#group = this.#track.appendGroup();
            this.#timeline?.record(this.#group.sequence, timestamp);
        }
        else if (!this.#group) {
            throw new Error("must start with a keyframe");
        }
        const __g = this.#group;
        if (!__g) return;
        const __frame = {
            payload: encodeFrame(data, timestamp),
            timestamp: Time.Timestamp.fromMicros(timestamp),
        };
        if (__enc) __mc.write(__g, __frame);
        else __g.writeFrame(__frame);
    }`;

  // --- seam 2: audio encrypt (Track.writeFrame in track.js) ---
  //
  // READ THIS BEFORE TRUSTING THIS SEAM. Its FIND string is character-identical in @moq/net
  // 0.1.5 and 0.3.5, so it kept patching cleanly across the upgrade and buildEnd reported
  // audio=1 — while `frame` silently changed from a bare Uint8Array to a {payload, timestamp}
  // object. The other two seams broke loudly and were fixed; this one would have shipped,
  // handing the encryptor an object it cannot encrypt.
  //
  // The lesson is that "the string was replaced" is not the same claim as "the path is
  // correct", and only the first one was ever being checked. Two things now cover it: the
  // version assertion in buildEnd below, and requireFrame() in media-crypto.ts, which throws
  // on the first frame if the shape is not what these seams assume.
  //
  // The replacement itself needs no change for 0.3.5: `frame` is passed through opaquely to
  // the hooks (which now take the object) and to group.writeFrame on the unencrypted path.
  const AUDIO_FIND = `    writeFrame(frame) {
        const group = this.appendGroup();
        group.writeFrame(frame);
        group.close();
    }`;
  // Also where AUDIO GROUP BATCHING lives, because this is the one place a frame becomes a
  // group and a group becomes a QUIC stream.
  //
  // Upstream opens a group per audio frame, so 20ms Opus = ~50 unidirectional streams/sec.
  // iOS Safari stops delivering after ~7600 cumulative streams on a session (measured across
  // four runs at two rates), which is ~2.5 minutes of audio. Batching N frames into one group
  // divides the stream rate by N.
  //
  // It costs no latency. A group is a live open stream, not a buffer: the publisher writes
  // each frame the instant it is encoded (lite/publisher.js #runGroup loops on readFrame) and
  // the consumer decodes each as it arrives. Frame duration, catalog jitter and the client's
  // AV-sync target are all untouched. What it costs is loss independence — the N frames share
  // a stream, so a lost packet delays the rest of that group by about one RTT instead of
  // damaging a single 20ms frame.
  //
  // Batching is a PUBLISHER decision and reaches every viewer: one set of groups goes to the
  // relay and there is no per-subscriber regrouping. It cannot be limited to mobile viewers.
  //
  // Gated on the audio track by name — writeFrame is generic and nothing else should batch.
  // globalThis.__VIVOH_AUDIO_GROUP__ <= 1 restores upstream behaviour byte for byte.
  // AND where AUDIO-OVER-DATAGRAMS lives, for the same reason: this is the one place a frame
  // becomes a group and a group becomes a QUIC stream, so it is the one place to stop doing
  // that. Upstream has no datagram media path at all — @moq/net carries appendDatagram and
  // recvDatagram, but @moq/hang, @moq/publish and @moq/watch contain zero references to
  // datagrams between them, so both ends of this are ours to write.
  //
  // WHY: iOS Safari stops delivering after ~7000 cumulative incoming unidirectional streams,
  // and 20ms Opus burns that in ~135 seconds. QUIC datagrams (RFC 9221) consume no stream ids
  // and are exempt from connection-level flow control, so they sidestep both candidate
  // mechanisms. Audio is ~99% of our streams; video is ~0.5/s and is NOT moved (a 720p frame
  // does not fit the ~1200 byte limit, and a lost video frame corrupts until the next keyframe
  // where a lost audio frame is a concealable 20ms gap).
  //
  // BEST-EFFORT, WITH NO FALLBACK. A datagram that does not fit, or that the transport cannot
  // carry, is simply not delivered — the relay has no group fallback either (moq-lite.md: "There
  // is no stream fallback"). So this is gated OFF by default and opt-in per broadcast via
  // ?adg=1, because a publisher on the WebSocket transport (Firefox is forced onto it, and this
  // deployment deliberately keeps that fallback) reports maxDatagramSize 0 and would publish
  // audio into a void, silently.
  const AUDIO_REPLACE = `    writeFrame(frame) {
        const __mc = globalThis.__VIVOH_MEDIA_CRYPTO__;
        const __enc = !!(__mc && __mc.shouldEncrypt(this.name));
        const __dgName = globalThis.__VIVOH_DG_TRACK__;
        if (__dgName && this.name === __dgName && typeof this.appendDatagram === "function") {
            if (__enc) { __mc.writeDatagram(this, frame); }
            else { try { this.appendDatagram(frame.timestamp, frame.payload); } catch (e) { console.warn("[adg] datagram dropped", e); } }
            return;
        }
        const __n = globalThis.__VIVOH_AUDIO_GROUP__ | 0;
        if (__n > 1 && String(this.name || "").indexOf("audio") === 0) {
            if (!this.__vbGroup || this.__vbCount >= __n) {
                if (this.__vbGroup) { __enc ? __mc.closeGroup(this.__vbGroup) : this.__vbGroup.close(); }
                this.__vbGroup = this.appendGroup();
                this.__vbCount = 0;
            }
            if (__enc) __mc.write(this.__vbGroup, frame);
            else this.__vbGroup.writeFrame(frame);
            this.__vbCount++;
            return;
        }
        const group = this.appendGroup();
        if (__enc) {
            __mc.writeAndClose(group, frame);
        }
        else {
            group.writeFrame(frame);
            group.close();
        }
    }`;

  // --- seam 4: RECEIVE audio datagrams (consumer.js #run) ---
  //
  // The other half of audio-over-datagrams. @moq/net's Track.Subscriber has recvDatagram(), but
  // nothing in @moq/hang or @moq/watch ever calls it, so a datagram published by seam 2 would
  // arrive at the relay, cross it, reach the browser, and be dropped on the floor.
  //
  // WHY IT LOOKS LIKE THIS. A datagram is definitionally "a single-frame group": lite-05 gives
  // it the same sequence namespace as groups, and the payload is exactly what one frame of a
  // one-frame group would carry. So rather than synthesise entries into #groups and re-implement
  // this file's reset / rewind / latency-skip / PTS-contiguity machinery (and get some of it
  // subtly wrong, which shows up as stutter rather than as an error), we adapt the datagram into
  // the shape #run already consumes and change exactly one line: where a group comes from.
  //
  // Everything downstream is then untouched and free: ordering by sequence, the stale/reset
  // classification, the latency budget — and seam 3, which sits inside #runGroup and therefore
  // DECRYPTS datagram payloads with no extra code. That is the main reason to adapt rather than
  // duplicate: the encryption path stays single.
  //
  // The two pending promises are held across iterations on purpose. A naive
  // `Promise.race([recvGroup(), recvDatagram()])` per loop would discard the loser's pending
  // read every time, silently dropping whichever arrived second.
  //
  // Always on, and safe to be: on a publisher that sends no datagrams the datagram promise
  // simply never settles, and on a transport without them recvDatagram is absent or throws,
  // which the guard treats as "groups only" for the life of the subscription.
  const RX_FIND = `    async #run() {
        // Start fetching groups in the background
        for (;;) {
            const consumer = await this.#track.recvGroup();
            if (!consumer)
                break;`;
  const RX_REPLACE = `    async #run() {
        // Start fetching groups in the background
        const __wrapDatagram = (dg) => {
            let __taken = false;
            return {
                sequence: dg.sequence,
                readFrame: async () => {
                    if (__taken) return undefined;
                    __taken = true;
                    // #runGroup reads the presentation time out of the decoded sample, not from
                    // here, so this timestamp is carried only for shape.
                    return { payload: dg.payload, timestamp: dg.timestamp };
                },
                close: () => {},
            };
        };
        const __nextSource = async () => {
            for (;;) {
                if (!this.__dgPendingGroup) {
                    this.__dgPendingGroup = this.#track.recvGroup().then((v) => ({ k: "g", v }));
                }
                let __wantDg = this.__dgOff !== true && typeof this.#track.recvDatagram === "function";
                if (__wantDg && !this.__dgPendingDatagram) {
                    try {
                        this.__dgPendingDatagram = this.#track.recvDatagram().then((v) => ({ k: "d", v }));
                    } catch (e) {
                        this.__dgOff = true;
                        __wantDg = false;
                    }
                }
                const __r = await Promise.race(
                    __wantDg && this.__dgPendingDatagram
                        ? [this.__dgPendingGroup, this.__dgPendingDatagram]
                        : [this.__dgPendingGroup]
                );
                if (__r.k === "g") {
                    this.__dgPendingGroup = undefined;
                    return __r.v;
                }
                this.__dgPendingDatagram = undefined;
                // The datagram side finishing does NOT end the track: groups may still arrive.
                if (!__r.v) { this.__dgOff = true; continue; }
                return __wrapDatagram(__r.v);
            }
        };
        for (;;) {
            const consumer = await __nextSource();
            if (!consumer)
                break;`;

  // --- seam 3: decrypt both (consumer.js, before Format.decode) ---
  // Re-derived for @moq/hang 0.4.3: the read side now yields a frame OBJECT, so the decode site
  // reads `next.payload` where it used to take `next` whole. We decrypt the payload only —
  // the timestamp was never encrypted.
  const DECRYPT_FIND = `const decoded = this.#format.decode(next.payload);`;
  // NOTE the three arguments. vivoh.earth's copy of this seam passes only the payload, because
  // vivoh has no frame tap. e2eMoQ DOES: decryptFrame() forwards `trackName` and `firstInGroup`
  // to the tap that backs viewer video messages, and it taps BEFORE the key check so a recording
  // captures frames that arrive while the key is still in flight.
  //
  // Dropping them would not break decryption — nothing below the tap reads them — so this is
  // exactly the kind of port that looks correct, builds clean, decrypts fine, and quietly
  // degrades a feature the source repo does not have. Both are still in scope at this seam in
  // @moq/hang 0.4.3: `this.#track` survives (consumer.js:84) and `#runGroup` still declares
  // `let index = 0` immediately above the decode.
  const DECRYPT_REPLACE = `const __mc = globalThis.__VIVOH_MEDIA_CRYPTO__; let __raw = next.payload; if (__mc && __mc.shouldDecrypt()) { try { __raw = await __mc.beforeDecode(next.payload, this.#track?.name, index === 0); } catch (e) { console.error("[media-crypto] decrypt failed; dropping frame", e); continue; } } const decoded = this.#format.decode(__raw);`;

  let video = 0;
  let audio = 0;
  let decrypt = 0;
  let datagramRx = 0;
  return {
    name: "vivoh-media-crypto-patch",
    enforce: "pre",
    buildStart() {
      // Fail before doing any work if the library moved underneath the seams. Checked here
      // rather than in buildEnd so the message arrives before a wall of transform output.
      for (const [pkg, expected] of Object.entries(SEAMS_DERIVED_FOR)) {
        let actual: string;
        try {
          actual = JSON.parse(
            readFileSync(resolvePath(`node_modules/${pkg}/package.json`), "utf8")
          ).version;
        } catch {
          throw new Error(`vivoh-media-crypto-patch: cannot read ${pkg}'s version to verify the seams.`);
        }
        if (actual !== expected) {
          throw new Error(
            `vivoh-media-crypto-patch: ${pkg} is ${actual} but the media-crypto seams were ` +
              `derived against ${expected}. A seam can keep matching while the data flowing ` +
              `through it changes shape — @moq/net's writeFrame body was identical across ` +
              `0.1.5 and 0.3.5 while its argument became an object — so a clean patch is NOT ` +
              `evidence the encryption still works. Re-read all three seams in the new ` +
              `sources, update them, then update SEAMS_DERIVED_FOR.`
          );
        }
      }
    },
    transform(code, id) {
      if (!id.includes("@moq")) return null;
      if (id.includes("/container/legacy.js") && code.includes(VIDEO_FIND)) {
        video++;
        return { code: code.replace(VIDEO_FIND, VIDEO_REPLACE), map: null };
      }
      if (id.includes("/@moq/net/track.js") && code.includes(AUDIO_FIND)) {
        audio++;
        return { code: code.replace(AUDIO_FIND, AUDIO_REPLACE), map: null };
      }
      // Both consumer.js seams in one pass. They live in the same file, and returning after the
      // first would leave the second unapplied while still reporting a clean build — the exact
      // shape of failure this plugin exists to prevent.
      if (id.includes("/container/consumer.js")) {
        let out = code;
        if (out.includes(DECRYPT_FIND)) {
          decrypt++;
          out = out.replace(DECRYPT_FIND, DECRYPT_REPLACE);
        }
        if (out.includes(RX_FIND)) {
          datagramRx++;
          out = out.replace(RX_FIND, RX_REPLACE);
        }
        return out === code ? null : { code: out, map: null };
      }
      return null;
    },
    buildEnd() {
      const missing: string[] = [];
      if (video < 1) missing.push("video-encrypt (legacy.js Producer.encode)");
      if (audio < 1) missing.push("audio-encrypt (track.js Track.writeFrame)");
      if (decrypt < 1) missing.push("decrypt (consumer.js Format.decode)");
      // Not a crypto seam, but it fails the build for the same reason the others do: with the
      // send side live, an unpatched receive side means a viewer on a datagram broadcast gets
      // silence, and there is no group fallback anywhere to cover it.
      if (datagramRx < 1) missing.push("datagram-rx (consumer.js #run recvGroup)");
      if (missing.length > 0) {
        throw new Error(
          `vivoh-media-crypto-patch: failed to patch ${missing.join(", ")} — the @moq source strings ` +
            `may have changed upstream. Refusing to build to avoid shipping an unencrypted media path. ` +
            `Update the FIND strings in vite.config.ts to match the new @moq version.`
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `vivoh-media-crypto-patch: patched video=${video} audio=${audio} decrypt=${decrypt} datagram-rx=${datagramRx} seam(s)`
      );
    },
  };
}

export default defineConfig({
  // moq.pro (Mode A): the media-crypto seams are patched back IN, so media is encrypted in
  // the browser and cdn.moq.pro carries ciphertext it cannot read.
  //
  // moqWebTransportOnly() stays OFF, deliberately. The two patches are independent: that one
  // disabled @moq's WebSocket-vs-WebTransport race because the old tinymoq fleet had no WS
  // endpoint. moq.pro does, so leaving it off keeps the WebSocket fallback working for
  // iPhone and older Safari. Encryption does not conflict with it — the seams encrypt the
  // frame payload beneath MoQ's framing, so whatever carries the session moves opaque bytes.
  // moqWebTransportOnly() is back in the list, but it no longer removes the WebSocket fallback —
  // it converts the gate into a RUNTIME one so ?wtonly=1 can disable the fallback for a single
  // page load. Default behaviour is unchanged: without the flag the race runs exactly as before.
  plugins: [moqWebTransportOnly(), mediaCryptoPatch()],
  // A build stamp in the diag panel, because "is the phone on the new bundle?" has now cost
  // several round trips of remote testing. The asset filename is content-hashed, but nobody
  // reading a panel on a phone can see it, and two builds whose panels look alike are
  // indistinguishable from a stale cache. This makes the answer visible on the device.
  define: {
    __VE_BUILD__: JSON.stringify(new Date().toISOString().slice(5, 16).replace("T", " ")),
  },
  // The `buffer: "buffer/"` alias that used to live here existed only for pkarr's DHT record
  // encoder. Nothing in the browser bundle touches node builtins now.
  build: {
    outDir: "dist",
    emptyDirBeforeWrite: true,
  },
  server: {
    port: 3000,
  },
});
