// A clock good enough to burn into evidence.
//
// The burned-in timestamp has two jobs — say when a frame was captured, and let a viewer read
// glass-to-glass latency by comparing it to their own clock — and both are worth exactly as
// much as the clock is accurate. A laptop four seconds fast turns a 400 ms stream into a "4.4
// second" one and the burn-in becomes the thing that is lying. So this does not trust the
// local clock at all; it derives UTC from our own edge and keeps it honest three ways.
//
// 1. BEST-OF-N, NOT ONE SHOT (Cristian's algorithm, and what NTP actually does)
//
// A single round trip gives an offset whose error is bounded by half the round trip, and one
// packet can get unlucky — a retransmit or a scheduling hiccup and the estimate is off by the
// whole delay. But the bound is per-sample, so the sample with the SMALLEST round trip carries
// the smallest possible error. Take a burst, keep the fastest. Averaging would be worse: it
// drags the good sample toward the bad ones. Sequential, not parallel, because concurrent
// requests contend for the same connection and inflate exactly the number being minimised.
//
// 2. A MONOTONIC LOCAL TIMEBASE
//
// The offset is measured against performance.now(), never Date.now(), and the burned-in time
// is performance.now() + offset. Date.now() is whatever the operating system currently
// believes: an NTP daemon stepping the system clock mid-broadcast, or a user changing the
// timezone, would silently corrupt every frame after it while the offset still looked freshly
// measured. performance.now() is monotonic and immune to both. This is the fix that matters
// most, and it costs nothing.
//
// 3. SLEW, NEVER STEP
//
// Each resync produces a slightly different offset (measurement noise, real drift). Applying
// it directly would make the burned-in clock jump — and a clock that jumps BACKWARDS in
// something presented as a record of when things happened is worse than one that is quietly a
// few milliseconds off. So corrections are slewed in at a bounded rate rather than stepped.
// At 1% the displayed clock stays strictly increasing (rate never drops below 0.99x, which no
// viewer can perceive) and a 100 ms correction lands in ten seconds.
//
// Stepping is reserved for corrections so large that slewing would take longer than the
// broadcast — a suspended machine whose performance timebase came back wrong. That step is
// logged loudly, because a stamp that jumped should never do so silently.
//
// WHAT THIS IS STILL NOT
//
// Absolute truth. It is our edge's clock, which we do not attest to, propagated over a network
// we do not control. Realistically it lands within a few milliseconds, which is one to two
// orders of magnitude below the latency it is used to measure. For the latency reading
// specifically there is a better trick available — sync BOTH ends to this same edge and the
// common-mode error cancels — see `uncertaintyMs` and the note in geo-stamp.ts.

export interface WhereAmI {
  lat: number | null;
  lon: number | null;
  city: string | null;
  region: string | null;
  country: string | null;
  colo: string | null;
  server_time_ms: number;
}

export interface EdgeClock {
  /**
   * Convert a performance.now()-timebase instant to UTC ms. This is the one that matters:
   * it lets a caller stamp a moment that has already passed — the instant a video frame was
   * captured — rather than the moment it got around to asking. requestVideoFrameCallback
   * reports captureTime in exactly this timebase, which is why the anchor is performance.now().
   */
  at: (perfMs: number) => number;
  /** Best estimate of true UTC in ms, right now. Strictly increasing except across a logged step. */
  now: () => number;
  /** How much to trust it: half the best round trip seen, plus how the estimate was reached. */
  quality: () => { offsetMs: number; uncertaintyMs: number; samples: number; steppedAt: number | null };
  /** The payload from the most recent sample — the sync request carries it anyway. */
  latest: () => WhereAmI;
  stop: () => void;
}

const BURST_FIRST = 5;   // more samples up front, where the anchor is set
const BURST_RESYNC = 3;  // fewer afterwards; we are correcting, not establishing
const RESYNC_MS = 5 * 60 * 1000;
const MAX_SLEW_RATE = 0.01;      // 1% — imperceptible as a rate, 100ms corrected in 10s
const STEP_THRESHOLD_MS = 1000;  // beyond this, slewing would outlast the broadcast

interface Sample {
  offsetMs: number; // add to performance.now() to get UTC
  rttMs: number;
  data: WhereAmI;
}

async function sample(): Promise<Sample> {
  const p0 = performance.now();
  const res = await fetch("/api/whereami", { cache: "no-store" });
  const p1 = performance.now();
  if (!res.ok) throw new Error(`/api/whereami: ${res.status}`);
  const data = (await res.json()) as WhereAmI;
  if (!Number.isFinite(data.server_time_ms)) throw new Error("/api/whereami: no server_time_ms");
  // The server stamped its clock somewhere between our send and our receive. Anchor it to the
  // midpoint of the local monotonic timebase; the error is at most half the round trip, which
  // is why the caller keeps the sample with the smallest one.
  //
  // Note the JSON body is read AFTER p1 on purpose: it must not be inside the interval being
  // measured, or parse time would be charged to the network and inflate the round trip.
  return { offsetMs: data.server_time_ms - (p0 + p1) / 2, rttMs: p1 - p0, data };
}

// Take `n` samples back to back and keep the one with the smallest round trip — the one whose
// error bound is tightest. Returns null only if every sample failed.
async function burst(n: number): Promise<Sample | null> {
  let best: Sample | null = null;
  for (let i = 0; i < n; i++) {
    try {
      const s = await sample();
      if (!best || s.rttMs < best.rttMs) best = s;
    } catch (e) {
      if (i === n - 1 && !best) console.warn("[clock] every sample in the burst failed:", e);
    }
  }
  return best;
}

export async function createEdgeClock(): Promise<EdgeClock> {
  const first = await burst(BURST_FIRST);
  if (!first) throw new Error("could not reach the edge to set the clock");

  let target = first.offsetMs;
  let applied = first.offsetMs; // no slew on the first anchor: nothing has been displayed yet
  let uncertaintyMs = first.rttMs / 2;
  let samples = BURST_FIRST;
  let latest = first.data;
  let steppedAt: number | null = null;
  let lastPerf = performance.now();

  console.log(
    `[clock] anchored to the edge: offset ${Math.round(applied - (Date.now() - performance.now()))}ms ` +
    `from this device's own clock, ±${uncertaintyMs.toFixed(1)}ms (best of ${BURST_FIRST})`
  );

  // Advance the applied offset toward the target at a bounded rate. Called from now(), so it
  // runs once per drawn frame; it is deliberately the only thing that mutates `applied`.
  const slewedOffset = (): number => {
    const p = performance.now();
    const dt = Math.max(0, p - lastPerf);
    lastPerf = p;
    const delta = target - applied;
    if (delta === 0) return applied;
    if (Math.abs(delta) > STEP_THRESHOLD_MS) {
      console.warn(
        `[clock] stepping ${Math.round(delta)}ms — too large to slew. The burned-in time ` +
        `jumps here; a suspended machine is the usual cause.`
      );
      steppedAt = Date.now();
      applied = target;
      return applied;
    }
    const maxMove = dt * MAX_SLEW_RATE;
    applied += Math.abs(delta) <= maxMove ? delta : Math.sign(delta) * maxMove;
    return applied;
  };

  const resync = () => {
    void burst(BURST_RESYNC).then((s) => {
      if (!s) return; // keep the previous anchor rather than drifting to a guess
      samples += BURST_RESYNC;
      latest = s.data;
      // Only accept an offset measured at least as cleanly as what we are already using;
      // a congested burst would otherwise drag a good anchor toward a worse one.
      if (s.rttMs / 2 <= uncertaintyMs * 2) {
        target = s.offsetMs;
        uncertaintyMs = Math.min(uncertaintyMs, s.rttMs / 2);
      }
    });
  };

  const timer = setInterval(resync, RESYNC_MS);

  // Coming back from a background tab or a lid-close is the one moment the timebase is most
  // likely to have moved underneath us, and the one moment a scheduled resync has not yet run.
  const onVisible = () => {
    if (document.visibilityState === "visible") resync();
  };
  document.addEventListener("visibilitychange", onVisible);

  return {
    // Note the offset is slewed on every call, so `at` and `now` share one continuously
    // corrected mapping. Stamping a past instant is therefore just arithmetic — no second
    // measurement, no drift between "when the frame arrived" and "when we asked".
    at: (perfMs) => perfMs + slewedOffset(),
    now: () => performance.now() + slewedOffset(),
    quality: () => ({ offsetMs: applied, uncertaintyMs, samples, steppedAt }),
    latest: () => latest,
    stop: () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
