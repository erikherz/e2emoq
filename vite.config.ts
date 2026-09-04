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
  let patched = 0;
  return {
    name: "moq-webtransport-only",
    enforce: "pre",
    transform(code, id) {
      // Match @moq/net's connection/connect.js across all (possibly nested) copies.
      if (id.includes("@moq") && code.includes("connectWebSocket") && code.includes(WS_GATE)) {
        patched++;
        return { code: code.replace(WS_GATE, "props?.websocket?.enabled === true"), map: null };
      }
      return null;
    },
    buildEnd() {
      if (patched === 0) {
        this.warn(
          "moq-webtransport-only: did not patch any @moq/net connect.js — the WS gate string may have changed upstream; WebSocket race may still be active."
        );
      } else {
        // eslint-disable-next-line no-console
        console.log(`moq-webtransport-only: patched ${patched} @moq/net connect module(s) to WebTransport-only`);
      }
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
function mediaCryptoPatch(): Plugin {
  // --- seam 1: video encrypt (Producer.encode in legacy.js) ---
  const VIDEO_FIND = `    encode(data, timestamp, keyframe) {
        if (keyframe) {
            this.#group?.close();
            this.#group = this.#track.appendGroup();
        }
        else if (!this.#group) {
            throw new Error("must start with a keyframe");
        }
        this.#group?.writeFrame(encodeFrame(data, timestamp));
    }`;
  const VIDEO_REPLACE = `    encode(data, timestamp, keyframe) {
        const __mc = globalThis.__VIVOH_MEDIA_CRYPTO__;
        const __enc = !!(__mc && __mc.shouldEncrypt(this.#track?.name));
        if (keyframe) {
            const __old = this.#group;
            if (__old) { __enc ? __mc.closeGroup(__old) : __old.close(); }
            this.#group = this.#track.appendGroup();
        }
        else if (!this.#group) {
            throw new Error("must start with a keyframe");
        }
        const __g = this.#group;
        if (!__g) return;
        const __frame = encodeFrame(data, timestamp);
        if (__enc) __mc.write(__g, __frame);
        else __g.writeFrame(__frame);
    }`;

  // --- seam 2: audio encrypt (Track.writeFrame in track.js) ---
  const AUDIO_FIND = `    writeFrame(frame) {
        const group = this.appendGroup();
        group.writeFrame(frame);
        group.close();
    }`;
  const AUDIO_REPLACE = `    writeFrame(frame) {
        const __mc = globalThis.__VIVOH_MEDIA_CRYPTO__;
        const group = this.appendGroup();
        if (__mc && __mc.shouldEncrypt(this.name)) {
            __mc.writeAndClose(group, frame);
        }
        else {
            group.writeFrame(frame);
            group.close();
        }
    }`;

  // --- seam 3: decrypt both (consumer.js, before Format.decode) ---
  const DECRYPT_FIND = `const decoded = this.#format.decode(next);`;
  const DECRYPT_REPLACE = `const __mc = globalThis.__VIVOH_MEDIA_CRYPTO__; let __raw = next; if (__mc && __mc.shouldDecrypt()) { try { __raw = await __mc.beforeDecode(next); } catch (e) { console.error("[media-crypto] decrypt failed; dropping frame", e); continue; } } const decoded = this.#format.decode(__raw);`;

  let video = 0;
  let audio = 0;
  let decrypt = 0;
  return {
    name: "vivoh-media-crypto-patch",
    enforce: "pre",
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
      if (id.includes("/container/consumer.js") && code.includes(DECRYPT_FIND)) {
        decrypt++;
        return { code: code.replace(DECRYPT_FIND, DECRYPT_REPLACE), map: null };
      }
      return null;
    },
    buildEnd() {
      const missing: string[] = [];
      if (video < 1) missing.push("video-encrypt (legacy.js Producer.encode)");
      if (audio < 1) missing.push("audio-encrypt (track.js Track.writeFrame)");
      if (decrypt < 1) missing.push("decrypt (consumer.js Format.decode)");
      if (missing.length > 0) {
        throw new Error(
          `vivoh-media-crypto-patch: failed to patch ${missing.join(", ")} — the @moq source strings ` +
            `may have changed upstream. Refusing to build to avoid shipping an unencrypted media path. ` +
            `Update the FIND strings in vite.config.ts to match the new @moq version.`
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `vivoh-media-crypto-patch: patched video=${video} audio=${audio} decrypt=${decrypt} media-crypto seam(s)`
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
  plugins: [mediaCryptoPatch()],
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
