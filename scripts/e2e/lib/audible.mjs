// Measure whether a page is actually PRODUCING SOUND, not whether it decoded frames.
//
// WHY THIS EXISTS. The transport matrix counted `AudioDecoder` outputs and called that "audio".
// Media goes decode -> sync -> emit, and only the first of the three was ever measured. On
// 2026-09-10 dual-publish shipped on a green four-cell run and was silent on every device:
// frames decoded, frames synced, no AudioContext, nothing audible. Three deploys to a live site,
// each caught by a human saying "still no audio", because the suite could not fail.
//
// So this probe taps the LAST stage: the node graph that terminates at `context.destination`.
// Everything a listener would hear passes through there and nothing else does.
//
// HOW. Two patches, installed before any page script runs:
//
//   1. `AudioContext` is subclassed so every context built by the page gets an AnalyserNode of
//      ours and a sampler reading it. A context we never saw is a context we cannot measure, and
//      the count is reported so "0 contexts" never masquerades as "silence".
//   2. `AudioNode.prototype.connect` is wrapped: anything connecting to `destination` is also
//      connected to that context's analyser. This is the load-bearing half. A pipeline that
//      decodes perfectly but never wires its output to the speakers reports
//      `connectedToDestination: 0` — which is exactly the failure that shipped.
//
// The probe is READ-ONLY on the audio path: it adds a second edge out of a node that is already
// connected to the destination, and never intercepts, consumes, or replaces anything. See the
// probe that killed the connection it was measuring (`getReader()` on the incoming stream) for
// why that distinction is worth stating.
//
// LIMITS, stated so a green run does not imply more than it measured:
//   - It proves samples are non-silent, not that they are the RIGHT samples. A tone at the wrong
//     pitch, the wrong rendition, or 400ms late all read as audible here.
//   - `AudioContext` only. An `<audio>`/`<video>` element playing directly to the speakers
//     bypasses WebAudio entirely and would read as silent. `<moq-watch>` uses WebAudio.

/** Source for `page.evaluateOnNewDocument` — install BEFORE navigating. */
export const AUDIBLE_PROBE = () => {
  const state = {
    contexts: 0,
    connectedToDestination: 0,
    ticks: 0,
    runningTicks: 0,
    nonSilentTicks: 0,
    peak: 0,
    rms: 0,
    lastState: null,
    err: null,
  };
  window.__audible = state;

  const Base = window.AudioContext || window.webkitAudioContext;
  if (!Base) {
    state.err = "no AudioContext constructor in this browser";
    return;
  }

  const SAMPLE_MS = 100;
  // Floor for "this tick carried sound". Chrome's fake capture device is a loud periodic beep and
  // real speech sits far above this; dither and denormals sit far below it.
  const SILENCE_FLOOR = 1e-4;

  const attach = (ctx) => {
    state.contexts++;
    let analyser;
    try {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
    } catch (e) {
      state.err = `createAnalyser failed: ${e}`;
      return;
    }
    // Stash it where the connect() patch below can find it from any node in this context.
    Object.defineProperty(ctx, "__audibleAnalyser", { value: analyser, enumerable: false });

    const buf = new Float32Array(analyser.fftSize);
    setInterval(() => {
      state.ticks++;
      state.lastState = ctx.state;
      if (ctx.state === "running") state.runningTicks++;
      try {
        analyser.getFloatTimeDomainData(buf);
      } catch {
        return;
      }
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        sum += v * v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / buf.length);
      if (rms > state.rms) state.rms = rms;
      if (peak > state.peak) state.peak = peak;
      if (rms > SILENCE_FLOOR) state.nonSilentTicks++;
    }, SAMPLE_MS);
  };

  class ProbedAudioContext extends Base {
    constructor(...args) {
      super(...args);
      try {
        attach(this);
      } catch (e) {
        state.err = `attach failed: ${e}`;
      }
    }
  }
  window.AudioContext = ProbedAudioContext;
  if (window.webkitAudioContext) window.webkitAudioContext = ProbedAudioContext;

  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const result = origConnect.call(this, dest, ...rest);
    try {
      const ctx = this.context;
      if (ctx && dest === ctx.destination && ctx.__audibleAnalyser) {
        origConnect.call(this, ctx.__audibleAnalyser);
        state.connectedToDestination++;
      }
    } catch {
      // A tap that fails must never break the graph it is measuring.
    }
    return result;
  };
};

/** Read the probe. Returns `{ measured: false }` when the probe never installed. */
export const readAudible = (page) =>
  page.evaluate(() => {
    const s = window.__audible;
    if (!s) return { measured: false };
    return { measured: true, ...s };
  });

/**
 * Render one line of evidence — never a verdict. `contexts=0` and `rms=0` are different
 * failures and the line says which.
 */
export const formatAudible = (a) => {
  if (!a?.measured) return "audible: NOT MEASURED (probe never installed)";
  if (a.err) return `audible: ERROR ${a.err}`;
  if (a.contexts === 0) return "audible: no AudioContext was ever constructed";
  if (a.connectedToDestination === 0) {
    return `audible: NOTHING CONNECTED TO SPEAKERS (${a.contexts} ctx, state=${a.lastState})`;
  }
  return (
    `audible: peak=${a.peak.toFixed(4)} rms=${a.rms.toFixed(4)} ` +
    `nonSilent=${a.nonSilentTicks}/${a.ticks} running=${a.runningTicks}/${a.ticks} ` +
    `ctx=${a.contexts} toSpeakers=${a.connectedToDestination} state=${a.lastState}`
  );
};

/**
 * Why this page is not audible, or null if it is. Split into distinct causes on purpose: the
 * whole failure of the old suite was collapsing "decoded" into "heard", and collapsing
 * "never wired up" into "silent" would be the same mistake one layer down.
 *
 * `minTicks` guards against declaring silence from too few samples.
 */
export const audibleFailure = (a, { minTicks = 20, minNonSilent = 5 } = {}) => {
  if (!a?.measured) return "the audible probe never installed, so nothing about sound was measured";
  if (a.err) return `the audible probe errored: ${a.err}`;
  if (a.contexts === 0) return "no AudioContext was ever constructed — the audio pipeline never started";
  if (a.ticks < minTicks) return `only ${a.ticks} audio samples taken; too few to call it either way`;
  if (a.connectedToDestination === 0) {
    return `an AudioContext exists (state=${a.lastState}) but nothing was ever connected to its destination — decoded audio that reaches no speaker`;
  }
  if (a.runningTicks === 0) return `the AudioContext never left state=${a.lastState}`;
  if (a.nonSilentTicks < minNonSilent) {
    return `the graph is wired and running but silent: peak=${a.peak.toFixed(6)} over ${a.ticks} samples`;
  }
  return null;
};
