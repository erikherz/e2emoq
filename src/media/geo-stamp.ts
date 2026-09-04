// Location + time burn-in for the broadcaster.
//
// Produces the single line of text the compositor draws across the bottom of every frame:
//
//     Lat: 37.774929  Lon: -122.419418  ±12m  ·  2026-08-16 14:23:45.678 UTC    (device fix)
//     Lat: 37.7749    Lon: -122.4194    ~city ·  2026-08-16 14:23:45.678 UTC    (fallback)
//
// WHAT IT IS FOR
//
// Two things, and they pull in the opposite direction from the rest of this product, which is
// otherwise built to reveal as little as possible:
//
//  1. Provenance. A frame that carries where and when it was captured is harder to pass off
//     as something else. Burned into the picture rather than attached as metadata, so it
//     survives a screen recording, a re-encode and a screenshot.
//  2. Latency, visibly. A viewer compares the burned-in UTC clock to their own and reads
//     glass-to-glass delay straight off the screen. No instrumentation, no trust in us.
//
// TWO SOURCES, AND THE LINE ALWAYS SAYS WHICH
//
// Primary is the device: navigator.geolocation with enableHighAccuracy, which on a phone is
// GNSS and on a laptop is wifi trilateration. Metres to tens of metres, and it follows a
// broadcaster who is moving.
//
// Fallback is our own edge's IP geolocation, used when the browser has no fix — permission
// refused, no receiver, or a fix that has gone stale underneath us.
//
// The two differ by three orders of magnitude in precision, so THE LINE MUST NEVER RENDER THEM
// THE SAME WAY. A burn-in that silently swapped a 12-metre fix for a city centroid, with
// identical-looking text, would be manufacturing exactly the false confidence this feature
// exists to prevent. So the accuracy field carries the distinction and does double duty as the
// source marker: `±12m` is the device speaking, `~city` is a guess from the network path.
// Decimal places follow suit — six when the fix earns them, four when it does not.
//
// A stale fix is treated as no fix. GPS that stopped updating ten minutes ago, still burned in
// as if current, is a lie told to a moving camera; better to fall back and say `~city`.
//
// WHAT NONE OF IT IS
//
// Proof, and the UI must not imply otherwise. Geolocation is a number the browser hands us and
// the page has no way to attest to it; a determined faker overrides it from devtools, spoofs
// the platform location service, or just runs a VPN and settles for `~city`. This raises the
// cost of a casual lie. Real proof needs a signature over the frames from hardware that
// attests to its own position, which this is not.
//
// THE TIME
//
// The target is one specific instant: when the camera captured THIS frame. Not when the page
// got around to drawing it, and not when the viewer sees it — a viewer whose clock reads
// something different is the feature working, not a bug, because that difference IS the
// latency.
//
// Two independent errors stand between us and that instant, and both are handled:
//
//  1. Is the clock right? See edge-clock.ts — not the device's clock, but best-of-N samples
//     against our own edge, anchored to a monotonic timebase, corrections slewed rather than
//     stepped so the burned-in time never runs backwards.
//
//  2. Are we stamping the right MOMENT? The picture drawn to canvas was captured tens of
//     milliseconds earlier — camera pipeline plus delivery into the page — so the clock read
//     at draw time describes a moment the picture is not from. That error is the same order as
//     the latency being measured, which would make the stamp useless for measuring it. So the
//     compositor passes each frame's real capture time (requestVideoFrameCallback), in the
//     same performance.now() timebase the clock is anchored to, and we convert that instant
//     rather than the current one.
//
// When the browser will not say (no rVFC, or a source it has no capture time for), the line
// marks itself approximate with a leading `≈` rather than quietly presenting draw time as
// capture time.

import { createEdgeClock, type EdgeClock } from "./edge-clock";
import type { StampFrameInfo } from "./pip-compositor";

export type StampSource = "device" | "network";

export interface GeoStamp {
  /** The line to burn in, evaluated per frame and stamped with THAT frame's capture time. */
  line: (frame: StampFrameInfo) => string;
  /** Where the coordinates are coming from right now, for UI copy. */
  source: () => StampSource;
  /** How good the burned-in clock is, in ms. Meaningful for the latency reading. */
  clockUncertaintyMs: () => number;
  stop: () => void;
}

// How long a device fix stays believable without an update. Past it we fall back and the line
// says `~city`, which is the honest answer when we can no longer vouch for the coordinates.
const FIX_MAX_AGE_MS = 60_000;

// How often to actively re-acquire, independent of watchPosition.
//
// This exists because of a trap that looked exactly like a bug in the fallback logic:
// watchPosition fires when the position CHANGES, so a broadcaster sitting still gets one
// callback and then silence. The fix stays perfectly valid, we just stop hearing about it —
// and the staleness guard above would then downgrade an accurate ±43m fix to a ~city guess
// 25km away, about a minute into every stationary broadcast. Observed in testing on 2026-08-16.
//
// Raising FIX_MAX_AGE_MS would only have hidden it, and at the cost of the guarantee that
// matters for someone moving. So instead we re-poll: a stationary fix stays fresh, a moving one
// still updates instantly via the watch, and a genuinely lost signal stops refreshing and ages
// out honestly. Comfortably inside FIX_MAX_AGE_MS so one missed poll is not a downgrade.
const FIX_REFRESH_MS = 25_000;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

// UTC, always. A local time would be ambiguous to the viewer doing the latency comparison, and
// would leak the broadcaster's timezone into the picture on top of the location.
function formatUtc(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)} UTC`
  );
}

// Round the accuracy radius the way the reader will use it: metres while metres mean
// something, then kilometres. Never rounds down to a flattering number.
function formatAccuracy(metres: number): string {
  if (!Number.isFinite(metres) || metres <= 0) return "±?";
  if (metres < 1000) return `±${Math.ceil(metres)}m`;
  return `±${Math.ceil(metres / 100) / 10}km`;
}

export async function createGeoStamp(): Promise<GeoStamp> {
  // The edge sync is not optional even when the device fix works: it is where the clock comes
  // from, and the clock is half of what gets burned in. It also carries the network location,
  // so the fallback costs no extra request.
  const clock: EdgeClock = await createEdgeClock();
  const net = () => clock.latest();
  if (net().lat == null || net().lon == null) {
    console.warn("[stamp] the edge reported no coordinates; only a device fix can fill the location");
  }

  // ---- Device fix ----
  //
  // watchPosition rather than getCurrentPosition: one reading taken when the button was
  // pressed would be burned in unchanged for the rest of a broadcast, which is wrong for
  // anyone reporting from a vehicle or on foot — the exact case this feature is for.
  let fix: { lat: number; lon: number; accuracy: number; at: number } | null = null;
  let watchId: number | null = null;
  let refresh: ReturnType<typeof setInterval> | null = null;

  const GEO_OPTS: PositionOptions = {
    // A phone should use its receiver, not the coarse cached answer. Costs battery, which is
    // the right trade for a feature whose entire value is the coordinates being real.
    enableHighAccuracy: true,
    // Never hand back a cached position: we time-stamp what we are told, so a cached reading
    // would be recorded as current and defeat the staleness guard entirely.
    maximumAge: 0,
    timeout: 20_000,
  };

  const acceptPosition = (pos: GeolocationPosition) => {
    const first = !fix;
    fix = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      // Our own clock, not pos.timestamp: that is stamped by the device clock we have just
      // gone to some trouble not to trust, and this value is only ever used to age the fix out.
      at: clock.now(),
    };
    if (first) console.log(`[stamp] device fix acquired, ${formatAccuracy(fix.accuracy)}`);
  };

  const onGeoError = (err: GeolocationPositionError) => {
    // Denied, unavailable or timed out — all three mean the same thing to us. Not fatal: the
    // fix ages out and the line falls back to the network location and says so.
    console.warn(`[stamp] no device fix (${err.message}); falling back to network location`);
  };

  if ("geolocation" in navigator) {
    // The watch catches movement the instant it happens...
    watchId = navigator.geolocation.watchPosition(acceptPosition, onGeoError, GEO_OPTS);
    // ...and this keeps a stationary fix from aging out when the watch has nothing to report.
    refresh = setInterval(
      () => navigator.geolocation.getCurrentPosition(acceptPosition, onGeoError, GEO_OPTS),
      FIX_REFRESH_MS
    );
  } else {
    console.warn("[stamp] this browser has no geolocation; using the network location");
  }

  // Only trust a fix that is both present and recent (see FIX_MAX_AGE_MS).
  const liveFix = () => (fix && clock.now() - fix.at <= FIX_MAX_AGE_MS ? fix : null);

  return {
    source: () => (liveFix() ? "device" : "network"),
    clockUncertaintyMs: () => clock.quality().uncertaintyMs,

    line: (frame) => {
      const f = liveFix();
      // The instant this frame's picture was captured, converted to UTC. Falling back to "now"
      // means stamping the draw, which runs late by the camera pipeline — so it gets the `≈`.
      const exact = frame.source === "capture" && frame.captureTime != null;
      const time =
        (exact ? "" : "≈") +
        formatUtc(frame.captureTime != null ? clock.at(frame.captureTime) : clock.now());
      if (f) {
        // Six decimals is ~0.1 m — below the accuracy radius printed right next to it, so the
        // digits never claim more than the ± admits.
        return `Lat: ${f.lat.toFixed(6)}  Lon: ${f.lon.toFixed(6)}  ${formatAccuracy(f.accuracy)}  ·  ${time}`;
      }
      const n = net();
      const lat = n.lat == null ? "n/a" : n.lat.toFixed(4);
      const lon = n.lon == null ? "n/a" : n.lon.toFixed(4);
      return `Lat: ${lat}  Lon: ${lon}  ~city  ·  ${time}`;
    },

    stop: () => {
      clock.stop();
      if (refresh != null) clearInterval(refresh);
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
    },
  };
}
