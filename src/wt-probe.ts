// Transport-layer probe for the iOS ~140s stall.
//
// Everything the ?diag=1 panel reports is read from the hang element's own signals, which
// all sit ABOVE the transport. In particular `connection.established` is set once when the
// session opens and is never cleared, so the panel's reassuring "conn up" during a stall is
// not evidence that QUIC is alive — it is evidence that nothing told the element otherwise.
// This module watches the WebTransport object itself, which can answer two questions the
// element cannot:
//
//   1. Did the QUIC session actually close?  `transport.closed` is ground truth. If it
//      settles at ~140s we get a WebTransportError with a close code and reason, and the
//      investigation is essentially over.
//
//   2. Are new unidirectional streams still ARRIVING?  MoQ delivers each group of media on
//      a fresh server-opened unidirectional stream. This is the discriminator that matters,
//      because it separates two failures that look identical from above:
//
//        streams stop arriving  -> the relay stopped sending, or the client stopped granting
//                                  stream credit. Note the count at the freeze: if it halts
//                                  on a round number (64, 100, 128) that is MAX_STREAMS_UNI
//                                  exhaustion — the peer has run out of credit to open more,
//                                  which produces exactly what we see: a healthy connection,
//                                  no error anywhere, and data that simply stops.
//        streams keep arriving  -> the transport is fine and the fault is above it, in
//                                  decode or render.
//
// Opt-in with ?diag=1 and wrapped in try/catch throughout: this sits directly in the media
// path and must never be the reason a stream fails to play.

interface WtProbe {
  installed: boolean;
  constructed: number;
  uni: number;
  lastUniAt: number;
  closedAt: number | null;
  closedHow: string | null;
  err: string | null;
  /** anticipatedConcurrentIncomingUnidirectionalStreams injected into the constructor, 0 = none */
  anticipated: number;
  // --- datagrams -----------------------------------------------------------------------
  //
  // Audio moved onto QUIC datagrams to escape the stream ceiling, which only helps if the
  // VIEWER's transport can actually carry them. A platform can implement WebTransport streams
  // and not usefully implement datagrams, and that failure is invisible from the sofa: video
  // keeps playing on the group path while audio never arrives at all, because nothing falls
  // back. These three fields are here to tell those apart in one glance on a real phone.
  /** What the transport says it can carry. null = never read; 0 = cannot carry datagrams. */
  maxDatagramSize: number | null;
  /** Incoming datagrams counted. Stays 0 on a transport that carries none. */
  datagrams: number;
  lastDatagramAt: number;
  /** Set if opening the incoming datagram reader threw: the field exists, the feature does not. */
  datagramErr: string | null;
  // --- bytes (task #59, open since August) --------------------------------------------------
  //
  // Upstream states the Safari ceiling as "roughly 7,600 streams or 16 MiB on one session,
  // WHICHEVER COMES FIRST". Datagram audio removes ~99% of the streams and does nothing about
  // the bytes, so the two halves now predict very different outcomes: ~4 hours if it is streams,
  // ~84 seconds at 200 KB/s of video if it is bytes. Every measurement so far has counted
  // streams and never bytes, which is exactly why this has stayed unresolved.
  //
  // Read from the transport's own getStats() rather than by tapping each incoming stream. That
  // is deliberate: wrapping the media streams to count them is how a probe earlier today
  // starved @moq and killed the connection it was measuring. This is read-only and cannot.
  /** bytesReceived from getStats(), or null where the platform has no getStats. */
  bytesIn: number | null;
  /** Set if getStats() is unavailable or threw — so "null" is never read as "zero". */
  statsErr: string | null;
}

export const wtProbe: WtProbe = {
  installed: false,
  constructed: 0,
  uni: 0,
  lastUniAt: 0,
  closedAt: null,
  closedHow: null,
  err: null,
  anticipated: 0,
  maxDatagramSize: null,
  datagrams: 0,
  lastDatagramAt: 0,
  datagramErr: null,
  bytesIn: null,
  statsErr: null,
};

type WtCtor = new (url: string, options?: unknown) => WebTransport;

/** Describe however the `closed` promise settled, including QUIC codes when present. */
function describeClose(reason: "resolved" | "rejected", value: unknown): string {
  if (reason === "resolved") {
    const info = value as { closeCode?: number; reason?: string } | undefined;
    return `clean code=${info?.closeCode ?? "?"} reason=${JSON.stringify(info?.reason ?? "")}`;
  }
  const e = value as { name?: string; message?: string; source?: string; streamErrorCode?: number };
  return `${e?.name ?? "Error"} src=${e?.source ?? "?"} code=${e?.streamErrorCode ?? "?"} ${e?.message ?? ""}`;
}

/**
 * Replace window.WebTransport with a counting subclass. Call AFTER any polyfill install so
 * that whichever implementation actually ends up in use is the one being measured.
 */
/**
 * Count datagrams by patching the PROTOTYPE, not by swapping the global constructor.
 *
 * The subclass below only sees sessions built through `globalThis.WebTransport` AFTER
 * installWtProbe ran. On Erik's iPhone that never happened: media flowed (decrypt ok 734) while
 * the panel read `sess=0`, so every counter fed by the subclass — including maxDatagramSize —
 * was reporting the probe's own absence, not the platform's. `dgram max=?` there was not
 * evidence that iOS lacks datagrams; it was no evidence at all, and would have condemned the
 * whole approach on a measurement of nothing.
 *
 * A prototype getter has no such window: it applies to every instance whoever constructed it and
 * whenever. main.ts already patches `createBidirectionalStream` this way and those [wt-stream]
 * logs DO appear on the phone, which is what says this route works where the other does not.
 *
 * Idempotent, and it never breaks playback: if anything here throws, the original getter is left
 * in place and the failure is recorded instead.
 */
function patchDatagramPrototype(): void {
  const WT = (globalThis as unknown as { WebTransport?: WtCtor }).WebTransport;
  if (typeof WT !== "function") return;
  const proto = (WT as unknown as { prototype: object }).prototype as {
    __dgProbed?: boolean;
  };
  if (proto.__dgProbed) return;
  const desc = Object.getOwnPropertyDescriptor(proto, "datagrams");
  if (!desc?.get) {
    // No `datagrams` on the prototype at all is itself the answer worth recording.
    wtProbe.datagramErr = "no datagrams accessor on WebTransport.prototype";
    return;
  }
  const origGet = desc.get;
  const cache = new WeakMap<object, WebTransportDatagramDuplexStream>();
  try {
    Object.defineProperty(proto, "datagrams", {
      configurable: true,
      get(this: object) {
        const src = origGet.call(this) as WebTransportDatagramDuplexStream;
        const hit = cache.get(this);
        if (hit) return hit;
        try {
          wtProbe.maxDatagramSize =
            typeof src?.maxDatagramSize === "number" ? src.maxDatagramSize : null;
          const reader = src.readable.getReader();
          const counted = new ReadableStream({
            async pull(ctrl) {
              const { done, value } = await reader.read();
              if (done) {
                ctrl.close();
                return;
              }
              wtProbe.datagrams++;
              wtProbe.lastDatagramAt = performance.now();
              ctrl.enqueue(value);
            },
            cancel(reason) {
              return reader.cancel(reason);
            },
          });
          const wrapped = new Proxy(src, {
            get: (t, k) => (k === "readable" ? counted : Reflect.get(t, k)),
          }) as WebTransportDatagramDuplexStream;
          cache.set(this, wrapped);
          return wrapped;
        } catch (e) {
          // The platform has the field but not a usable stream. Record it and hand back the
          // untouched object — a diagnostic must never be why datagrams stop working.
          wtProbe.datagramErr = String(e);
          return src;
        }
      },
    });
    proto.__dgProbed = true;
  } catch (e) {
    wtProbe.datagramErr = `prototype patch failed: ${String(e)}`;
  }
}

export function installWtProbe(anticipated = 0): void {
  // Runs first and unconditionally: it is the half that works when the constructor swap does not.
  patchDatagramPrototype();
  if (wtProbe.installed) return;
  const g = globalThis as unknown as { WebTransport?: WtCtor };
  const Orig = g.WebTransport;
  if (typeof Orig !== "function") return;
  wtProbe.anticipated = anticipated;

  class ProbedWebTransport extends (Orig as WtCtor) {
    private _uni?: ReadableStream;

    constructor(url: string, options?: unknown) {
      // Ask for a larger initial unidirectional stream budget.
      //
      // The measured ceiling is ~7200 CUMULATIVE incoming uni streams per session, after which
      // the peer can never open another one. WT_MAX_STREAMS credit is cumulative over closed
      // streams and has to be replenished by the receiver — us — and the browser is the only
      // thing that can send those capsules; there is no JS API for it. What JS CAN do is state
      // an expectation up front: `anticipatedConcurrentIncomingUnidirectionalStreams` is a
      // documented WebTransportOptions member, and the transport setting behind it
      // (SETTINGS_WT_INITIAL_MAX_STREAMS_UNI) defaults to 0, i.e. "I will grant credit one
      // capsule at a time".
      //
      // So if the defect is a fixed initial grant that is never topped up, a large value here
      // should move the ceiling proportionally — a real fix rather than a mitigation, costing
      // no latency and no loss-resilience. If the ceiling does not move, the grant is not what
      // is being exhausted and the finding stands as a WebKit bug.
      //
      // The name says CONCURRENT, and a UA is free to read it that way or to clamp it; this is
      // an experiment, not a documented lever for cumulative budget.
      const opts =
        anticipated > 0
          ? { ...(options as Record<string, unknown>), anticipatedConcurrentIncomingUnidirectionalStreams: anticipated }
          : options;
      super(url, opts);
      wtProbe.constructed++;

      // Poll bytesReceived. Read-only and out of the media path by design — the alternative,
      // tapping each incoming stream to sum its chunks, is what killed a probe earlier today.
      // Stops as soon as the session closes so a dead tab is not polling forever.
      try {
        const self = this as unknown as { getStats?: () => Promise<Record<string, unknown>> };
        if (typeof self.getStats !== "function") {
          wtProbe.statsErr = "getStats() unavailable on this platform";
        } else {
          let alive = true;
          void this.closed.catch(() => {}).finally(() => {
            alive = false;
          });
          const poll = async () => {
            if (!alive) return;
            try {
              const s = await self.getStats!();
              // Chrome exposes bytesReceived; other engines may name it differently, so fall
              // back rather than silently reporting null on a platform that does have a number.
              const n = (s?.bytesReceived ?? s?.bytesRead ?? null) as number | null;
              if (typeof n === "number") wtProbe.bytesIn = n;
              else wtProbe.statsErr = `getStats() had no byte field (keys: ${Object.keys(s ?? {}).slice(0, 6).join(",")})`;
            } catch (e) {
              wtProbe.statsErr = String(e).slice(0, 80);
              alive = false; // one clean failure is enough; do not spam a broken API
            }
            if (alive) setTimeout(poll, 1000);
          };
          void poll();
        }
      } catch (e) {
        wtProbe.statsErr = String(e).slice(0, 80);
      }

      this.closed.then(
        (info) => {
          wtProbe.closedAt = performance.now();
          wtProbe.closedHow = describeClose("resolved", info);
        },
        (err) => {
          wtProbe.closedAt = performance.now();
          wtProbe.closedHow = describeClose("rejected", err);
        },
      );
    }

    // The native getter returns the same ReadableStream on every access, and taking a reader
    // locks it — so the wrapper is built once and cached. @moq reads this twice: handshake.js
    // takes a reader for the SETUP stream and releases the lock, then stream.js takes another
    // for the media loop. Both must see one object, and both must be able to lock it in turn.
    //
    // Deliberately pull-driven rather than a pipeThrough. A TransformStream would insert its
    // own queue into the media path and change when streams are pulled from the transport;
    // this reads exactly one stream per downstream read, so the only thing that changes is
    // that a counter goes up.
    get incomingUnidirectionalStreams(): ReadableStream {
      if (this._uni) return this._uni;
      const src = super.incomingUnidirectionalStreams;
      try {
        const reader = src.getReader();
        this._uni = new ReadableStream({
          async pull(ctrl) {
            const { done, value } = await reader.read();
            if (done) {
              ctrl.close();
              return;
            }
            wtProbe.uni++;
            wtProbe.lastUniAt = performance.now();
            ctrl.enqueue(value);
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
      } catch (e) {
        // Counting is a diagnostic; playback is not. Fall back to the raw stream.
        wtProbe.err = String(e);
        this._uni = src;
      }
      return this._uni;
    }

    // NOTE: datagrams are counted by patchDatagramPrototype() above, not here. Wrapping them
    // in this subclass as well would double-count (super.datagrams already returns the patched,
    // counting object) and, worse, would only ever work on the sessions this subclass sees —
    // which on iOS is none of them.
  }

  g.WebTransport = ProbedWebTransport as unknown as WtCtor;
  wtProbe.installed = true;
}

// SELF-INSTALL AT IMPORT TIME. This is the fix for `sess=0`.
//
// installWtProbe() is called from init(), which runs on DOMContentLoaded. That was assumed to be
// "before anything connects", and on desktop Chrome it is — sess=1 there. On Erik's iPhone it is
// not: the panel reported sess=0 across three separate builds while media plainly flowed, so
// every session was being constructed outside the window the probe was watching, and every
// counter fed by it (including maxDatagramSize) was reporting the probe's own absence.
//
// Module evaluation happens strictly before DOMContentLoaded and before any of this app's
// connect calls, so installing here closes that window regardless of how the platform schedules
// things. The ?wtmax= experiment still needs the explicit call from init() to pass its value,
// and installWtProbe() is idempotent, so the later call is harmless.
//
// Deliberately unconditional, and deliberately not behind ?diag=1: the watch page rebuilds the
// player on wtProbe.uni (see STREAM_BUDGET), so an uninstalled probe is not merely a blind
// diagnostic — it silently disables the iOS stall mitigation too. That has been true this whole
// time on any device where the constructor swap missed.
//
// ?wtmax= is read HERE rather than left to init()'s call, because installWtProbe is idempotent:
// once this runs, the later call returns early and would drop the value on the floor. A test
// knob that is accepted and silently ignored is the failure mode carryTestParams() in main.ts
// exists to warn about — the experiment reports "no change" and the hypothesis looks disproved
// when it was never applied.
try {
  const q = new URLSearchParams(location.search);
  const wtmax = Number(q.get("wtmax") ?? 0);
  installWtProbe(Number.isFinite(wtmax) && wtmax > 0 ? wtmax : 0);
  // ?wtonly=1 — disable @moq's WebSocket fallback for this page load, so a session either runs
  // over WebTransport or fails outright. Set here, at import time, because connect() reads it
  // and the first connection can precede DOMContentLoaded. See vite.config.ts for why.
  if (q.get("wtonly") === "1") {
    (globalThis as unknown as { __VIVOH_WT_ONLY__?: boolean }).__VIVOH_WT_ONLY__ = true;
    console.log("[wtonly] WebSocket fallback DISABLED for this load — WebTransport or nothing");
  }
  // ?wsonly=1 — the mirror: never attempt the QUIC leg, so the session runs over qmux/WebSocket
  // while the WebTransport API is still present. That is the state Erik's iPhone is in, and it
  // could not be reproduced on a desktop before this, which is why every question about it cost
  // a remote round trip and a broadcast restart.
  if (q.get("wsonly") === "1") {
    (globalThis as unknown as { __VIVOH_WS_ONLY__?: boolean }).__VIVOH_WS_ONLY__ = true;
    console.log("[wsonly] WebTransport leg DISABLED for this load — reproducing the phone's transport");
  }
  // Safari and WebTransport: ON by default here, `?wtsafari=0` to restore upstream's ban.
  //
  // @moq/net 0.3.5 refuses WebTransport for every Safari (a `safari` range no version can
  // satisfy), citing OUR bug report. The premise is sound and specific: one QUIC stream per
  // audio frame is ~50 streams/s, and WebKit stops delivering at roughly 7,600 streams on a
  // session, which is about two minutes. That is the right default for a publisher sending
  // audio as groups.
  //
  // It is the wrong default for THIS deployment, because audio here goes over datagrams, which
  // consume no stream ids at all. Measured: 50.5 streams/s down to 0.5, and on a real iPhone
  // 13,000+ datagrams with good audio and video past four minutes and ~52 MB, through the ~140s
  // original failure and past the ~84s the 16 MiB theory predicted.
  //
  // The cost of the ban is not degraded audio, it is no path to datagrams at all: a WebSocket
  // session reports maxDatagramSize 0, so every Safari viewer is pinned to the group rendition
  // and lands back under the very ceiling the ban exists to avoid. Bypassing it is what makes
  // Safari a first-class viewer instead of one on a permanent fallback.
  //
  // The escape hatch stays, and it is a real one: if a WebKit release breaks WebTransport again,
  // `?wtsafari=0` puts that viewer back on WebSocket without a deploy.
  const wtSafari = q.get("wtsafari");
  if (wtSafari !== "0") {
    (globalThis as unknown as { __VIVOH_WT_SAFARI__?: boolean }).__VIVOH_WT_SAFARI__ = true;
    if (wtSafari === "1") console.log("[wtsafari] Safari WebTransport ban bypassed (explicit)");
  } else {
    console.log("[wtsafari] wtsafari=0 — honouring upstream's Safari WebTransport ban for this load");
  }
} catch {
  // Never let instrumentation be the reason the page fails to load.
}
