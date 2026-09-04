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
export function installWtProbe(anticipated = 0): void {
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
  }

  g.WebTransport = ProbedWebTransport as unknown as WtCtor;
  wtProbe.installed = true;
}
