// Safari WebSocket fallback - MUST install before hang components load
// Using our patched version that handles requireUnreliable gracefully
import { install as installWebTransportPolyfill } from "./webtransport-polyfill";
// WebCodecs polyfill for Opus audio encoding on Safari
import { install as installWebCodecsPolyfill } from "./webcodecs-polyfill";
import { installWtProbe, wtProbe } from "./wt-probe";

// Detect Safari - even Safari 17+ with WebTransport has compatibility issues with some relays
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// Check if we need the polyfill: only when WebTransport is not available
// Safari now uses native WebTransport with Cloudflare relay (fallback relays disabled)
const needsPolyfill = typeof WebTransport === "undefined";
if (needsPolyfill) {
  const reason = typeof WebTransport === "undefined"
    ? "WebTransport not supported"
    : "Safari detected (using WebSocket for better compatibility)";
  console.log(`${reason}, installing WebSocket polyfill`);
  // Install polyfill - use force=true for Safari since it has native WebTransport
  // but with compatibility issues that require using WebSocket instead
  installWebTransportPolyfill(isSafari);
}

// Safari audio track fix - Safari doesn't return channelCount in getSettings()
// which causes the hang library to fail with "expected number" error
if (isSafari) {
  const originalGetSettings = MediaStreamTrack.prototype.getSettings;
  MediaStreamTrack.prototype.getSettings = function () {
    const settings = originalGetSettings.call(this);
    // Add default channelCount for audio tracks if missing
    if (this.kind === "audio" && settings.channelCount === undefined) {
      settings.channelCount = 1; // Mono default, Safari typically captures mono
    }
    return settings;
  };
  console.log("Safari: Patched MediaStreamTrack.getSettings for channelCount");
}

// Theme initialization - must run early to prevent flash
function initTheme() {
  const savedTheme = localStorage.getItem("theme");

  // Dark is the default look (OS preference is ignored on first visit). Only an explicit
  // saved choice of "light" opts in; anything else — including no saved preference — is dark.
  if (savedTheme === "light") {
    document.documentElement.classList.add("light");
  }

  document.addEventListener("DOMContentLoaded", () => {
    const themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
      themeToggle.addEventListener("click", () => {
        document.documentElement.classList.toggle("light");
        const isLight = document.documentElement.classList.contains("light");
        localStorage.setItem("theme", isLight ? "light" : "dark");
      });
    }
  });
}
initTheme();

// --- Minimal typings for the headless @moq/publish + @moq/watch core elements ---
// The core elements render no controls of their own; we drive them programmatically.
// @moq/signals Signals expose peek()/set()/subscribe() (subscribe returns an unsubscribe fn).
interface MoqSignal<T> {
  peek(): T;
  set(value: T): void;
  subscribe(fn: (value: T) => void): () => void;
}
type ConnStatus = "disconnected" | "connecting" | "connected";
type PublishSource = "camera" | "screen" | "file" | null | undefined;

interface MoqPublishElement extends HTMLElement {
  source: PublishSource;
  invisible: boolean;
  muted: boolean;
  connection: { status: MoqSignal<ConnStatus> };
  state: { source: MoqSignal<PublishSource> };
}

interface MoqWatchElement extends HTMLElement {
  muted: boolean;
}

// Safari fallback relay servers (WebSocket-enabled)
// Pinned to the single test box for the full end-to-end test (no prod traffic).
const FALLBACK_RELAYS = [
  "cdn.gpcmoq.com",
];

// Server status tracking
interface RelayResult {
  domain: string;
  latency: number | null; // null if failed
  error?: string;
}

interface ServerStatus {
  mode: "websocket" | "webtransport";
  selectedServer: string;
  connected: boolean;
  raceResults: RelayResult[];
  // Display-only: the confirmed origin<->edge transport for a cross-cluster (viewer-cdn=)
  // stream, probed from the edge's /edge_xport. A ready-to-render string, or null = hide.
  originLink: string | null;
}

const serverStatus: ServerStatus = {
  mode: needsPolyfill ? "websocket" : "webtransport",
  // Not a hostname. This is the value shown before any connection exists, and it used to name
  // a self-hosted fleet box that is not in the media path at all — so the panel confidently
  // reported a server this client had never contacted and would never use. Anything real is
  // written by setActiveRelay() once a relay is actually assigned.
  selectedServer: "(not connected)",
  connected: false,
  raceResults: [],
  originLink: null,
};

// Browser support tracking
interface CodecSupport {
  software: boolean;
  hardware?: boolean; // undefined means unknown (Firefox)
}

interface BrowserSupport {
  browser: string;
  isFirefox: boolean;
  isSafari: boolean;
  supported: boolean;
  features: {
    webTransport: boolean;
    mediaDevices: boolean;
    audio: {
      capture: boolean;
      render: boolean;
      encoding?: { aac: boolean; opus: boolean };
      decoding?: { aac: boolean; opus: boolean };
    };
    video: {
      capture: "full" | "partial" | "none";
      render: boolean;
      encoding?: { h264: CodecSupport; h265: CodecSupport; vp8: CodecSupport; vp9: CodecSupport; av1: CodecSupport };
      decoding?: { h264: CodecSupport; h265: CodecSupport; vp8: CodecSupport; vp9: CodecSupport; av1: CodecSupport };
    };
  };
}

const CODECS: Record<string, string> = {
  aac: "mp4a.40.2",
  opus: "opus",
  av1: "av01.0.08M.08",
  h264: "avc1.640028",
  h265: "hev1.1.6.L93.B0",
  vp9: "vp09.00.10.08",
  vp8: "vp8",
};

async function checkAudioEncoder(codec: string): Promise<boolean> {
  try {
    const res = await AudioEncoder.isConfigSupported({
      codec: CODECS[codec],
      numberOfChannels: 2,
      sampleRate: 48000,
    });
    return res.supported === true;
  } catch { return false; }
}

async function checkAudioDecoder(codec: string): Promise<boolean> {
  try {
    const res = await AudioDecoder.isConfigSupported({
      codec: CODECS[codec],
      numberOfChannels: 2,
      sampleRate: 48000,
    });
    return res.supported === true;
  } catch { return false; }
}

async function checkVideoEncoder(codec: string, isFirefox: boolean): Promise<CodecSupport> {
  try {
    const software = await VideoEncoder.isConfigSupported({
      codec: CODECS[codec],
      width: 1280,
      height: 720,
      hardwareAcceleration: "prefer-software",
    });
    const hardware = await VideoEncoder.isConfigSupported({
      codec: CODECS[codec],
      width: 1280,
      height: 720,
      hardwareAcceleration: "prefer-hardware",
    });
    const unknownHw = isFirefox || hardware.config?.hardwareAcceleration !== "prefer-hardware";
    return {
      software: software.supported === true,
      hardware: unknownHw ? undefined : hardware.supported === true,
    };
  } catch { return { software: false }; }
}

async function checkVideoDecoder(codec: string, isFirefox: boolean): Promise<CodecSupport> {
  try {
    const software = await VideoDecoder.isConfigSupported({
      codec: CODECS[codec],
      hardwareAcceleration: "prefer-software",
    });
    const hardware = await VideoDecoder.isConfigSupported({
      codec: CODECS[codec],
      hardwareAcceleration: "prefer-hardware",
    });
    const unknownHw = isFirefox || hardware.config?.hardwareAcceleration !== "prefer-hardware";
    return {
      software: software.supported === true,
      hardware: unknownHw ? undefined : hardware.supported === true,
    };
  } catch { return { software: false }; }
}

async function detectBrowserSupport(): Promise<BrowserSupport> {
  // Detect browser - use consistent detection with global isSafari
  const ua = navigator.userAgent;
  let browser = "Unknown";
  const isFirefox = /firefox/i.test(ua);
  if (isFirefox) {
    browser = "Firefox";
  } else if (/edg/i.test(ua)) {
    browser = "Edge";
  } else if (/chrome/i.test(ua)) {
    browser = "Chrome";
  } else if (isSafari) {
    // Use global isSafari which has proper negative lookahead for Chrome/Android
    browser = "Safari";
  }

  const webTransport = typeof WebTransport !== "undefined";
  const mediaDevices = typeof navigator.mediaDevices?.getUserMedia === "function";

  // Audio features
  const audioCapture = typeof AudioWorkletNode !== "undefined";
  const audioRender = typeof AudioContext !== "undefined" && typeof AudioBufferSourceNode !== "undefined";

  let audioEncoding: { aac: boolean; opus: boolean } | undefined;
  let audioDecoding: { aac: boolean; opus: boolean } | undefined;

  if (typeof AudioEncoder !== "undefined") {
    audioEncoding = {
      aac: await checkAudioEncoder("aac"),
      opus: await checkAudioEncoder("opus"),
    };
  }
  if (typeof AudioDecoder !== "undefined") {
    audioDecoding = {
      aac: await checkAudioDecoder("aac"),
      opus: await checkAudioDecoder("opus"),
    };
  }

  // Video features
  // @ts-expect-error MediaStreamTrackProcessor not in all TS libs
  const hasMediaStreamTrackProcessor = typeof MediaStreamTrackProcessor !== "undefined";
  const hasOffscreenCanvas = typeof OffscreenCanvas !== "undefined";
  const videoCapture: "full" | "partial" | "none" = hasMediaStreamTrackProcessor
    ? "full"
    : hasOffscreenCanvas
      ? "partial"
      : "none";
  const videoRender = hasOffscreenCanvas && typeof CanvasRenderingContext2D !== "undefined";

  let videoEncoding: BrowserSupport["features"]["video"]["encoding"];
  let videoDecoding: BrowserSupport["features"]["video"]["decoding"];

  if (typeof VideoEncoder !== "undefined") {
    videoEncoding = {
      h264: await checkVideoEncoder("h264", isFirefox),
      h265: await checkVideoEncoder("h265", isFirefox),
      vp8: await checkVideoEncoder("vp8", isFirefox),
      vp9: await checkVideoEncoder("vp9", isFirefox),
      av1: await checkVideoEncoder("av1", isFirefox),
    };
  }
  if (typeof VideoDecoder !== "undefined") {
    videoDecoding = {
      h264: await checkVideoDecoder("h264", isFirefox),
      h265: await checkVideoDecoder("h265", isFirefox),
      vp8: await checkVideoDecoder("vp8", isFirefox),
      vp9: await checkVideoDecoder("vp9", isFirefox),
      av1: await checkVideoDecoder("av1", isFirefox),
    };
  }

  // Supported if we have WebTransport OR Safari (which uses WebSocket fallback)
  const supported = webTransport || isSafari;

  return {
    browser,
    isFirefox,
    isSafari,
    supported,
    features: {
      webTransport,
      mediaDevices,
      audio: {
        capture: audioCapture,
        render: audioRender,
        encoding: audioEncoding,
        decoding: audioDecoding,
      },
      video: {
        capture: videoCapture,
        render: videoRender,
        encoding: videoEncoding,
        decoding: videoDecoding,
      },
    },
  };
}

let browserSupport: BrowserSupport;

// Update the browser support panel UI
function updateBrowserSupportPanel() {
  const supportPanel = document.getElementById("support-panel");
  if (!supportPanel || !browserSupport) return;

  // Determine overall status - "Partial" if using polyfill, "Full" if native WebTransport
  const isPartial = needsPolyfill;
  const statusClass = browserSupport.supported ? (isPartial ? "partial" : "connected") : "disconnected";
  const statusText = browserSupport.supported ? (isPartial ? "Partial Support" : "Full Support") : "Not Supported";

  // Build details HTML
  const green = '<span class="status-dot green"></span>';
  const red = '<span class="status-dot red"></span>';
  const yellow = '<span class="status-dot yellow"></span>';

  const bool = (v: boolean) => v ? `${green} Yes` : `${red} No`;

  // WebTransport status - show "Polyfill" if we're using the fallback
  const webTransportStatus = () => {
    if (needsPolyfill) {
      return `${yellow} Polyfill`;
    }
    return browserSupport.features.webTransport ? `${green} Full` : `${red} No`;
  };

  const captureStatus = (v: "full" | "partial" | "none") => {
    if (v === "full") return `${green} Full`;
    if (v === "partial") return `${yellow} Partial`;
    return `${red} No`;
  };

  const codecStatus = (c: CodecSupport | undefined, isFirefox: boolean) => {
    if (!c || (!c.software && !c.hardware)) return `${red} No`;
    if (c.hardware === true) return `${green} Hardware`;
    if (c.hardware === undefined && isFirefox) return `${yellow} Software*`;
    if (c.software) return `${yellow} Software`;
    return `${red} No`;
  };

  const audioCodecStatus = (supported: boolean | undefined) => {
    if (supported === undefined) return `${red} No`;
    return supported ? `${green} Yes` : `${red} No`;
  };

  const f = browserSupport.features;
  const isFirefox = browserSupport.isFirefox;

  // Note for polyfill or Firefox
  let footerNote = "";
  if (needsPolyfill) {
    footerNote = `<p class="support-note">Using WebSocket polyfill for Safari compatibility.</p>`;
  }
  if (isFirefox) {
    footerNote += `<p class="support-note">*Hardware acceleration is <a href="https://github.com/nickeltin/browser-support" target="_blank">undetectable</a> on Firefox.</p>`;
  }

  const detailsContent = `
    <table class="latency-results">
      <tbody>
        <tr><td><strong>WebTransport</strong></td><td>${webTransportStatus()}</td></tr>
        <tr><td><strong>Rendering</strong></td><td>Audio</td><td>${bool(f.audio.render)}</td></tr>
        <tr><td></td><td>Video</td><td>${bool(f.video.render)}</td></tr>
        <tr><td><strong>Decoding</strong></td><td>Opus</td><td>${f.audio.decoding ? audioCodecStatus(f.audio.decoding.opus) : `${red} No`}</td></tr>
        <tr><td></td><td>AAC</td><td>${f.audio.decoding ? audioCodecStatus(f.audio.decoding.aac) : `${red} No`}</td></tr>
        <tr><td></td><td>AV1</td><td>${f.video.decoding ? codecStatus(f.video.decoding.av1, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>H.265</td><td>${f.video.decoding ? codecStatus(f.video.decoding.h265, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>H.264</td><td>${f.video.decoding ? codecStatus(f.video.decoding.h264, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>VP9</td><td>${f.video.decoding ? codecStatus(f.video.decoding.vp9, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>VP8</td><td>${f.video.decoding ? codecStatus(f.video.decoding.vp8, isFirefox) : `${red} No`}</td></tr>
      </tbody>
    </table>
    ${footerNote}
  `;

  supportPanel.innerHTML = `
    <div class="server-status-summary">
      <span class="status-indicator ${statusClass}"></span>
      <span>${statusText}: ${browserSupport.browser}</span>
      <button class="details-btn" id="support-details-btn">Details</button>
    </div>
    <div class="server-details hidden" id="support-details-content">
      ${detailsContent}
    </div>
  `;

  // Add details toggle handler
  document.getElementById("support-details-btn")?.addEventListener("click", () => {
    const details = document.getElementById("support-details-content");
    const btn = document.getElementById("support-details-btn");
    if (details && btn) {
      const isHidden = details.classList.contains("hidden");
      details.classList.toggle("hidden");
      btn.textContent = isHidden ? "Hide" : "Details";
    }
  });
}

// Race requests to find the lowest-latency relay server
async function selectBestFallbackRelay(): Promise<string> {
  const testPath = "/fingerprint";
  const timeout = 5000; // 5 second timeout per server

  // Track all results for the status panel
  const results: RelayResult[] = FALLBACK_RELAYS.map(domain => ({
    domain,
    latency: null,
  }));

  // Create a promise for each server that resolves with result
  const racePromises = FALLBACK_RELAYS.map(async (domain, index) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const startTime = performance.now();

    try {
      const response = await fetch(`https://${domain}:8888${testPath}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const latency = performance.now() - startTime;
        results[index].latency = latency;
        console.log(`Relay ${domain} responded in ${latency.toFixed(0)}ms`);
        return { domain, latency };
      }
      const error = `HTTP ${response.status}`;
      results[index].error = error;
      throw new Error(error);
    } catch (error) {
      clearTimeout(timeoutId);
      if (!results[index].error) {
        results[index].error = error instanceof Error ? error.message : "Failed";
      }
      console.warn(`Relay ${domain} failed:`, error);
      throw error;
    }
  });

  // Wait a bit for all results to come in (for display purposes)
  // but use Promise.any to select the winner quickly
  const winnerPromise = Promise.any(racePromises);

  // Also wait for all to settle (with a shorter timeout for UI)
  const allSettledPromise = Promise.allSettled(racePromises);

  try {
    const winner = await winnerPromise;
    console.log(`Selected relay: ${winner.domain} (${winner.latency.toFixed(0)}ms)`);

    // Wait briefly for other results to populate (for status panel)
    await Promise.race([
      allSettledPromise,
      new Promise(resolve => setTimeout(resolve, 1000)),
    ]);

    serverStatus.raceResults = results;
    serverStatus.selectedServer = winner.domain;
    serverStatus.connected = true;

    return winner.domain;
  } catch {
    console.warn("All relay servers failed latency test, using default");
    serverStatus.raceResults = results;
    serverStatus.selectedServer = FALLBACK_RELAYS[0];
    serverStatus.connected = false;
    return FALLBACK_RELAYS[0];
  }
}

/**
 * Three states, all of them real — an amber invented for symmetry would be worse than a
 * binary light.
 *
 * The subtlety is Safari. WebSocket is the ONLY transport it has, so there it is the healthy
 * path and not a fallback at all; painting every Safari viewer amber would report a fault that
 * does not exist. Amber therefore means what it should: this browser could have used
 * WebTransport and something pushed it onto WebSocket anyway. Working, but not on the fast
 * path, and worth being able to see.
 */
type LinkHealth = "connected" | "partial" | "disconnected";

function linkHealth(): LinkHealth {
  if (!serverStatus.connected) return "disconnected";
  if (serverStatus.mode !== "websocket") return "connected";
  return "WebTransport" in globalThis ? "partial" : "connected";
}

const HEALTH_LABEL: Record<LinkHealth, string> = {
  connected: "Server status: connected",
  partial: "Server status: connected, on the WebSocket fallback",
  disconnected: "Server status: not connected",
};

/**
 * Paint the footer ball. Colour is never the only channel: the same words go into `title` and
 * `aria-label`, so hovering, or listening, tells you what green meant.
 */
function updateStatusBall(health: LinkHealth) {
  const dot = document.getElementById("status-ball-dot");
  if (dot) dot.className = `status-indicator ${health}`;
  const ball = document.getElementById("server-link");
  if (ball) {
    ball.setAttribute("title", HEALTH_LABEL[health]);
    ball.setAttribute("aria-label", HEALTH_LABEL[health]);
  }
}

// Update the server status panel UI
function updateServerStatusPanel() {
  const serverPanel = document.getElementById("server-panel");
  if (!serverPanel) return;

  const health = linkHealth();
  updateStatusBall(health);
  const statusClass = health;
  const statusText = health === "connected" ? "Connected"
    : health === "partial" ? "Connected on the WebSocket fallback"
    : "Disconnected";
  const modeLabel = serverStatus.mode === "websocket" ? "WebSocket (Safari fallback)" : "WebTransport (native)";

  // Build details HTML
  let detailsContent = `
    <p><strong>Mode:</strong> ${modeLabel}</p>
    <p><strong>Server:</strong> ${serverStatus.selectedServer}</p>
  `;

  if (serverStatus.mode === "websocket" && serverStatus.raceResults.length > 0) {
    detailsContent += `
      <p><strong>Latency Test Results:</strong></p>
      <table class="latency-results">
        <thead><tr><th>Server</th><th>Latency</th></tr></thead>
        <tbody>
    `;

    // Sort by latency (successful first, then failed)
    const sorted = [...serverStatus.raceResults].sort((a, b) => {
      if (a.latency === null && b.latency === null) return 0;
      if (a.latency === null) return 1;
      if (b.latency === null) return -1;
      return a.latency - b.latency;
    });

    for (const result of sorted) {
      const isSelected = result.domain === serverStatus.selectedServer;
      const latencyText = result.latency !== null
        ? `${result.latency.toFixed(0)}ms`
        : `Failed: ${result.error || "timeout"}`;
      const rowClass = isSelected ? "selected" : (result.latency === null ? "failed" : "");
      detailsContent += `<tr class="${rowClass}"><td>${result.domain}</td><td>${latencyText}</td></tr>`;
    }

    detailsContent += `</tbody></table>`;
  }

  serverPanel.innerHTML = `
    <div class="server-status-summary">
      <span class="status-indicator ${statusClass}"></span>
      <span>${statusText}: ${serverStatus.selectedServer}</span>
      <button class="details-btn" id="server-details-btn">Details</button>
    </div>
    ${serverStatus.originLink ? `<div class="origin-link-line" style="font-size:0.8rem;color:var(--text-muted,#737373);margin-top:2px;">${serverStatus.originLink}</div>` : ""}
    <div class="server-details hidden" id="server-details-content">
      ${detailsContent}
    </div>
  `;

  // Add details toggle handler
  document.getElementById("server-details-btn")?.addEventListener("click", () => {
    const details = document.getElementById("server-details-content");
    const btn = document.getElementById("server-details-btn");
    if (details && btn) {
      const isHidden = details.classList.contains("hidden");
      details.classList.toggle("hidden");
      btn.textContent = isHidden ? "Hide" : "Details";
    }
  });
}

// Record the relay this client actually connected to (assigned/routed, possibly a
// CDN override or cross-cluster edge) and refresh the footer Server Status panel.
function setActiveRelay(relay: string | null) {
  serverStatus.selectedServer = relay ?? "(no relay assigned)";
  serverStatus.connected = !!relay;
  serverStatus.originLink = null; // stale on any relay change; the edge_xport probe refills it
  updateServerStatusPanel();
}

// Display-only origin<->edge transport probe for cross-cluster (viewer-cdn=) streams. The
// edge autoscaler exposes GET https://<edge-host>/edge_xport?broadcast=<rawId> ->
// {xport:"iroh"|"quic"|"unknown", origin:"host:port"} (public, no auth, :443). We fetch it
// ~1.5s after connect and re-poll a few times, rendering a stats line next to "Connected".
// unknown / any error => hide the line (never surface a scary state).
function startOriginLinkProbe(edgeRelay: string, rawBroadcastId: string): void {
  const host = edgeRelay.split(":")[0];
  if (!host) return;
  let stopped = false;
  window.addEventListener("beforeunload", () => { stopped = true; });
  const probe = async (): Promise<void> => {
    if (stopped) return;
    try {
      const res = await fetch(
        `https://${host}/edge_xport?broadcast=${encodeURIComponent(rawBroadcastId)}`,
        { signal: AbortSignal.timeout(3000) }
      );
      if (!res.ok) { serverStatus.originLink = null; updateServerStatusPanel(); return; }
      const data = (await res.json()) as { xport?: string; origin?: string };
      if (data.xport === "iroh") {
        serverStatus.originLink = "Origin link: iroh / DHT";
      } else if (data.xport === "quic") {
        serverStatus.originLink = `Origin link: ${data.origin ?? "host:port"} (QUIC)`;
      } else {
        serverStatus.originLink = null; // "unknown" => hide
      }
      updateServerStatusPanel();
    } catch {
      serverStatus.originLink = null; // fetch error => hide
      updateServerStatusPanel();
    }
  };
  window.setTimeout(() => {
    void probe();
    const id = window.setInterval(() => {
      if (stopped) { window.clearInterval(id); return; }
      void probe();
    }, 5000);
  }, 1500);
}

// Status pills shown in the publisher header and on the player. We make a claim at each
// layer and nothing more: "Relay-blind" is an INFRASTRUCTURE property (encryption is
// mandatory, so it shows on every stream and says nothing about who may watch); the
// audience pill carries the ACCESS claim (Public vs Invite-only); and "Security details"
// hangs the honest caveats (static key, metadata, not-DRM) off the access affordance.
// 15px rather than the pills' 13px: this one carries no label beside it, so it has to hold
// the line on its own next to a 1rem monospace stream id.
const SHIELD_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>`;
const GLOBE_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
const LOCK_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const PILL_CSS =
  "display:inline-flex;align-items:center;gap:4px;font-size:0.72rem;font-weight:600;" +
  "border:1px solid;border-radius:999px;padding:2px 8px;line-height:1;white-space:nowrap;";

// "Relay-blind" — shown on EVERY stream (encryption is mandatory). States that the relay
// and server only ever move ciphertext they can't read. Deliberately NOT a privacy claim
// about who may watch — that is the audience pill's job.
//
// A bare shield rather than a bordered "Encrypted" pill. The claim is true of every stream
// and can never be switched off, so a badge announcing it on every screen is a permanent
// banner for a constant — it reads as something to be reckoned with rather than something
// already handled. The icon marks the state; the hover carries the sentence for anyone who
// wants it. The audience pill keeps its label because that one VARIES, and a varying claim
// has to be readable at a glance rather than hovered.
function createRelayBlindBadge(): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "relay-blind-badge";
  badge.title = "Encrypted — your browser encrypts every frame and viewers' browsers decrypt it. The relay and server only move ciphertext they can't read.";
  badge.innerHTML = SHIELD_SVG;
  // No border, no padding, no text. Icon-only, so it needs a name of its own: a title
  // attribute is a mouse affordance and says nothing to a screen reader or a touch device.
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", "Encrypted");
  badge.style.cssText = "display:inline-flex;align-items:center;color:#22c55e;flex-shrink:0;";
  return badge;
}

// Audience pill — carries the ACCESS claim, driven by require_auth. Public = anyone with
// the link; Invite-only = viewers must sign in to receive the key. Mutated in place so a
// single element can track the live toggle.
function setAudienceBadge(badge: HTMLSpanElement, inviteOnly: boolean): void {
  const color = inviteOnly ? "#f59e0b" : "#9ca3af";
  badge.title = inviteOnly
    ? "Invite-only — viewers must sign in to receive the key and watch."
    : "Public — anyone with the link can watch.";
  badge.innerHTML = (inviteOnly ? LOCK_SVG : GLOBE_SVG) + `<span>${inviteOnly ? "Invite-only" : "Public"}</span>`;
  badge.style.color = color;
  badge.style.borderColor = color;
}

function createAudienceBadge(inviteOnly: boolean): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "audience-badge";
  badge.style.cssText = PILL_CSS;
  setAudienceBadge(badge, inviteOnly);
  return badge;
}

// "Security details" disclosure — the honest caveats that attach to the access claim,
// surfaced at the moment a user reasons about privacy. Click toggles a small popover;
// an outside click closes it.
// The disclosure itself, without any affordance for revealing it. Split out so it can be
// dropped into the passcode info panel (where it now lives) as well as behind the legacy
// "Security details" link below.
function createSecurityBody(): HTMLDivElement {
  const body = document.createElement("div");
  body.className = "security-body";
  body.innerHTML =
    `<strong style="color:#f3f4f6;display:block;margin-bottom:6px;">What encryption does and doesn't cover</strong>` +
    `<ul style="margin:0;padding-left:16px;display:flex;flex-direction:column;gap:6px;">` +
    `<li><strong>It takes both halves.</strong> The link carries a secret after the <code>#</code>, and the passcode is the other half — set by default, so a link on its own will not play unless you switch it off before going live. Send them by different routes; whoever ends up holding both can watch, and neither can be recalled. We cannot decrypt your stream, and equally cannot lock anyone out of it for you.</li>` +
    `<li><strong>Revoking mid-stream.</strong> A passcode re-keys within a second or two and viewers holding the old one stop decrypting, without your link changing. (The change lands on the next keyframe, so the picture they already have finishes first.) <strong>New link</strong> is the blunter option: it starts a fresh broadcast, so every copy of the old link dies and everyone watching drops.</li>` +
    `<li><strong>Metadata in the clear.</strong> Codec, resolution, frame timing and sizes, and track names are visible to the relay.</li>` +
    `<li><strong>Not DRM.</strong> Anyone allowed to watch can screen-capture the decoded video.</li>` +
    `</ul>`;
  return body;
}

function createSecurityDetails(): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = "security-details";
  wrap.style.cssText = "position:relative;display:inline-flex;align-items:center;";
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = "Security details";
  link.style.cssText = "font-size:0.72rem;color:#9ca3af;text-decoration:underline;cursor:pointer;white-space:nowrap;";
  const pop = document.createElement("div");
  pop.style.cssText =
    "display:none;position:absolute;z-index:60;top:calc(100% + 6px);left:0;width:290px;" +
    "background:#1a1a1a;border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:10px 12px;" +
    "font-size:0.72rem;line-height:1.45;color:#d1d5db;box-shadow:0 8px 28px rgba(0,0,0,0.55);text-align:left;";
  pop.appendChild(createSecurityBody());
  link.addEventListener("click", (e) => {
    e.preventDefault();
    pop.style.display = pop.style.display === "none" ? "block" : "none";
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target as Node)) pop.style.display = "none";
  });
  wrap.append(link, pop);
  return wrap;
}

// Per-broadcast relay tokens are minted server-side (BYOK) and returned by the Worker:
// publishers get one from POST /api/stats/broadcast, viewers from GET /route. There is no
// static client token — the browser never holds a long-lived, all-paths credential.
const NAMESPACE_PREFIX = "moqplay.com";

// Build the cdn.moq.pro connect URL from the Worker's {relay, path, jwt} (moq.pro Mode A).
// The element points at the FULL url and uses an empty name (the broadcast path lives in the
// url). When the Worker returns no `path`, the caller falls back to the fleet host:port form.
const moqUrl = (relay: string, path: string, jwt: string) =>
  `https://${relay}/${path.replace(/^\/+/, "")}?jwt=${jwt}`;

// Dynamic imports for the MoQ web components - MUST happen after polyfills are installed.
// These register the headless light-DOM core elements <moq-publish> and <moq-watch>
// from @moq/publish + @moq/watch (which use @moq/net, negotiating moq-lite-04).
// ES module static imports are hoisted and execute before any code runs.
const loadHangComponents = async () => {
  // Install WebCodecs polyfill for Opus audio encoding (Safari)
  // This must complete before the components try to use AudioEncoder
  await installWebCodecsPolyfill();

  await import("@moq/publish/element");
  await import("@moq/watch/element");
};

import {
  getCurrentUser,
  countryToFlag,
  loginWithGoogle,
  logout,
  logBroadcastStart,
  logBroadcastEnd,
  type BroadcastStart,
  logWatchStart,
  logWatchHeartbeat,
  logWatchEnd,
  type WatchSession,
  getStreamRoute,
  checkStreamExists,
  getStreamSettings,
  updateStreamSettings,
  getLiveStats,
  getStreamViewers,
  type User,
  type Geo,
  type StreamSettings,
  type LiveBroadcast,
  type LiveViewer,
  type StreamRoute
} from "./auth";
import { renderOverlay } from "./overlay-sanitize";
import { buildPublisherClaim, getPublishKey, setPublishKey } from "./publisher-claim";
import {
  armPublisher,
  armViewer,
  deriveChatKey,
  deriveLinkKey,
  deriveMediaKey,
  deriveRouteTag,
  generateLinkSecret,
  generatePasscode,
  decryptStats,
  resetMediaKey,
  sealText,
  openText,
} from "./crypto/media-crypto";
import { initChat, type ChatHandle } from "./chat/chat-client";
import { describeLocation } from "./geo/nearest-city";
import { createCompositor, type CameraFacing, type Compositor } from "./media/pip-compositor";
import { createGeoStamp, type GeoStamp } from "./media/geo-stamp";
import { encodeQr, type QrMatrix } from "./media/qr";

// /stats, /<id>/stats and /cleardata were removed: they existed to show who was broadcasting
// and watching, which is exactly the identity this app no longer holds. Rather than keep pages
// that could only render blanks, the surface is gone. The kill switch was never part of them
// and survives at /api/admin/kill and friends.
type View = "landing" | "broadcast" | "watch";

// Generate a random stream ID (5 lowercase alphanumeric characters)
function generateRandomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Generate a unique stream ID, checking for collisions
async function generateStreamId(): Promise<string> {
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    const id = generateRandomId();
    const exists = await checkStreamExists(id);
    if (!exists) {
      return id;
    }
    console.log(`Stream ID ${id} already in use, generating new one...`);
  }
  // Fallback: return a random ID even if we couldn't verify uniqueness
  return generateRandomId();
}

// Check if a string is a valid stream ID (5 lowercase alphanumeric)
function isValidStreamId(str: string): boolean {
  return /^[a-z0-9]{5}$/.test(str);
}

/**
 * The broadcaster's own address bar, which is NOT a share link and must not read like one.
 *
 * `/?stream=<id>` exists so a refresh resumes the same broadcast. The trap is that it looks
 * exactly like something you would send someone: it names the stream, it is in the address
 * bar the moment you go live, and it carries neither the `#k=` secret nor the passcode — so
 * a recipient cannot decrypt anything. Worse than a black player, `?stream=` routes to the
 * BROADCAST view, so whoever opens it lands on a publishing page for a stream they do not
 * own rather than on anything that explains itself.
 *
 * The marker rides in the fragment for two reasons: the server never sees it, and it survives
 * copy/paste — so if a broadcaster does send this URL, the warning travels with it and shows
 * up in the recipient's address bar too. The share link comes from the copy button, and only
 * from there.
 */
const DONT_SHARE_MARKER = "NOT-THE-SHARE-LINK--USE-THE-COPY-BUTTON";

const broadcastUrl = (streamId: string, suffix = ""): string =>
  `/?stream=${streamId}${suffix}#${DONT_SHARE_MARKER}`;

// Determine current view and stream ID from URL
async function getRouteInfo(): Promise<{ view: View; streamId: string }> {
  const path = window.location.pathname;

  // Watch page: /watch accepts an id directly and jumps straight to the stream —
  // /watch/<id>, /watch?stream=<id>, or /watch?id=<id>. Served by the fleet watch, same as
  // the bare /<id> path.
  if (path === "/watch" || path.startsWith("/watch/")) {
    const params = new URLSearchParams(window.location.search);
    const fromPath = path.startsWith("/watch/") ? decodeURIComponent(path.slice("/watch/".length)) : "";
    const id = (fromPath || params.get("stream") || params.get("id") || "").trim().toLowerCase();
    if (isValidStreamId(id)) {
      return { view: "watch", streamId: id };
    }
    // No id: there is nothing to dial. The old entry form is gone — a bare stream id has no
    // key and no longer even yields a token, and the form rejected a pasted share link. Land
    // on the landing page rather than on a form that cannot succeed.
    return { view: "landing", streamId: "" };
  }

  // Broadcast page: /broadcast — mint a fresh stream id and go live via the fleet. Rewrites
  // the URL to /?stream=<id> so a refresh keeps the same broadcast identity.
  if (path === "/broadcast") {
    // A 5-char stream id (collision-checked). It is only a NAME: it carries no authority and
    // is not the secret. Watching needs the key in the share link's #k= fragment, and
    // publishing under it needs the signed claim in publisher-claim.ts.
    const streamId = await generateStreamId();
    // Preserve a ?geo= test override through the URL rewrite (it drives origin placement
    // on the broadcaster's broker assign).
    const geo = new URLSearchParams(location.search).get("geo");
    const suffix = geo ? `&geo=${encodeURIComponent(geo)}` : "";
    window.history.replaceState({}, "", broadcastUrl(streamId, suffix));
    return { view: "broadcast", streamId };
  }

  // Watch view: /{streamId} — served by the fleet watch path (initWatchView pulls the relay
  // and token from the Worker; the content key comes from the link fragment).
  const potentialStreamId = path.slice(1); // Remove leading /
  if (isValidStreamId(potentialStreamId)) {
    return { view: "watch", streamId: potentialStreamId };
  }

  // Resume an in-progress broadcast: /?stream=<id> (set by /broadcast; survives refresh).
  // The id is a short 5-char stream id served through the fleet (broker-assigned).
  const params = new URLSearchParams(window.location.search);
  const streamId = params.get("stream");
  if (streamId) {
    // Re-apply the warning marker for anyone who arrived here without it — a hand-typed or
    // trimmed URL should still say what it is.
    if (!location.hash.includes(DONT_SHARE_MARKER)) {
      const geo = params.get("geo");
      window.history.replaceState({}, "", broadcastUrl(streamId, geo ? `&geo=${encodeURIComponent(geo)}` : ""));
    }
    return { view: "broadcast", streamId };
  }

  // Bare "/" — the promotional landing page (Broadcast / Watch entry points + info).
  return { view: "landing", streamId: "" };
}

// Update the auth UI based on login state
function updateAuthUI(user: User | null, geo: Geo | null) {
  const authContainer = document.getElementById("auth-container");
  const newStreamBtn = document.getElementById("new-stream-btn");

  // OAUTH-DISABLED: no sign-in chrome. Expose the New Stream button and render no
  // user/avatar/sign-out UI. Remove this block to restore the sign-in-aware header below.
  if (authContainer) authContainer.innerHTML = "";
  if (newStreamBtn) newStreamBtn.classList.remove("hidden");
  return;

  // Hide header buttons when not logged in (login overlay will show instead)
  if (!user) {
    if (authContainer) authContainer.innerHTML = "";
    if (newStreamBtn) newStreamBtn.classList.add("hidden");
    return;
  }

  // Show New Stream button for logged in users
  if (newStreamBtn) newStreamBtn.classList.remove("hidden");

  if (!authContainer) return;

  // Show logged-in user info
  const avatarHtml = user.avatar_url
    ? `<img src="${user.avatar_url}" alt="${user.name}" class="avatar">`
    : `<div class="avatar avatar-placeholder">${user.name.charAt(0).toUpperCase()}</div>`;

  const flag = countryToFlag(geo?.country ?? null);
  const hasCoords = geo?.latitude && geo?.longitude;

  // Build location tooltip content
  const locationParts: string[] = [];
  if (geo?.city) locationParts.push(geo.city);
  if (geo?.region) locationParts.push(geo.region);
  if (geo?.postalCode) locationParts.push(geo.postalCode);
  if (geo?.country) locationParts.push(geo.country);

  let flagHtml = "";
  if (flag) {
    const clickable = hasCoords ? "clickable" : "";
    flagHtml = `<span class="user-flag ${clickable}" id="user-flag">${flag}</span>`;
  }

  authContainer.innerHTML = `
    <div class="user-info">
      ${avatarHtml}
      <span class="user-name">${user.name}</span>${flagHtml}
      <button id="logout-btn" class="btn btn-icon" title="Sign Out">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
      </button>
    </div>
    ${flag ? `<div class="geo-tooltip" id="geo-tooltip">
      <div class="geo-tooltip-content">
        ${geo?.city ? `<div class="geo-row"><span class="geo-label">City</span><span class="geo-value">${geo.city}</span></div>` : ""}
        ${geo?.region ? `<div class="geo-row"><span class="geo-label">Region</span><span class="geo-value">${geo.region}</span></div>` : ""}
        ${geo?.postalCode ? `<div class="geo-row"><span class="geo-label">Postal</span><span class="geo-value">${geo.postalCode}</span></div>` : ""}
        ${geo?.country ? `<div class="geo-row"><span class="geo-label">Country</span><span class="geo-value">${geo.country}</span></div>` : ""}
        ${geo?.continent ? `<div class="geo-row"><span class="geo-label">Continent</span><span class="geo-value">${geo.continent}</span></div>` : ""}
        ${geo?.timezone ? `<div class="geo-row"><span class="geo-label">Timezone</span><span class="geo-value">${geo.timezone}</span></div>` : ""}
        ${hasCoords ? `<div class="geo-row"><span class="geo-label">Coords</span><span class="geo-value">${geo.latitude}, ${geo.longitude}</span></div>` : ""}
        ${hasCoords ? `<div class="geo-action">Click flag to open in Google Maps</div>` : ""}
      </div>
    </div>` : ""}
  `;

  document.getElementById("logout-btn")?.addEventListener("click", logout);

  // Flag hover and click handlers
  const flagEl = document.getElementById("user-flag");
  const tooltipEl = document.getElementById("geo-tooltip");

  if (flagEl && tooltipEl) {
    flagEl.addEventListener("mouseenter", () => {
      tooltipEl.classList.add("visible");
    });
    flagEl.addEventListener("mouseleave", () => {
      tooltipEl.classList.remove("visible");
    });

    if (hasCoords) {
      flagEl.addEventListener("click", () => {
        const mapsUrl = `https://www.google.com/maps/place/${geo.latitude},${geo.longitude}/@${geo.latitude},${geo.longitude},3z`;
        window.open(mapsUrl, "_blank");
      });
    }
  }
}

// Show login required overlay for broadcast
function showLoginRequired() {
  const broadcastView = document.getElementById("broadcast-view");
  if (!broadcastView) return;

  const overlay = document.createElement("div");
  overlay.id = "login-overlay";
  overlay.innerHTML = `
    <div class="login-required">
      <div class="watch-stream-section">
        <h2>Enter Stream ID to Watch</h2>
        <div class="watch-stream-input-row">
          <input type="text" id="watch-stream-id-input" maxlength="5" placeholder="xxxxx" autocomplete="off" spellcheck="false">
          <button id="watch-stream-go-btn" type="button" title="Go to stream">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 16 16 12 12 8"/>
              <line x1="8" y1="12" x2="16" y2="12"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="login-divider"><span>or</span></div>
      <h2>Sign in to Broadcast</h2>
      <p>Please sign in with one of the following to start broadcasting:</p>
      <div class="auth-buttons">
        <button id="overlay-login-google" class="btn btn-google">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Google
        </button>
      </div>
    </div>
  `;

  broadcastView.appendChild(overlay);
  document.getElementById("overlay-login-google")?.addEventListener("click", loginWithGoogle);

  // Watch stream functionality
  const watchInput = document.getElementById("watch-stream-id-input") as HTMLInputElement;
  const watchGoBtn = document.getElementById("watch-stream-go-btn");

  const goToStream = () => {
    const streamId = watchInput.value.trim().toLowerCase();
    if (streamId.length !== 5) {
      alert("Stream IDs are five characters long");
      watchInput.focus();
      return;
    }
    window.open(`/${streamId}`, "_blank");
  };

  watchGoBtn?.addEventListener("click", goToStream);
  watchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      goToStream();
    }
  });
  // Auto-lowercase input
  watchInput?.addEventListener("input", () => {
    watchInput.value = watchInput.value.toLowerCase();
  });
}

// Initialize broadcast view
// Optional per-request CDN override for testing individual tinymoq destinations
// (e.g. ?publisher-cdn=cdn-01.tinymoq.com, &viewer-cdn=cdn-02.tinymoq.com).
function getCdnOverride(param: "publisher-cdn" | "viewer-cdn"): string | undefined {
  const v = new URLSearchParams(window.location.search).get(param)?.trim();
  return v || undefined;
}

// One turn of a rotate icon, so a control that replaces a value confirms it acted even when
// the replacement looks much like what it replaced. Re-triggerable: the class has to come off
// and go back on, and reading offsetWidth forces the reflow that makes the restart stick.
function spin(btn: Element): void {
  btn.classList.remove("spun");
  void (btn as HTMLElement).offsetWidth;
  btn.classList.add("spun");
  window.setTimeout(() => btn.classList.remove("spun"), 500);
}

function initBroadcastView(initialStreamId: string, user: User | null) {
  // The broadcast's identity is MUTABLE: the "new link" control (rotateIdentity, below)
  // replaces the id and the link secret together without a page reload. Everything derived
  // from them is therefore read at use rather than captured once — that is why these are
  // `let` and why streamName is recomputed rather than being a const.
  let streamId = initialStreamId;

  // The ".hang" suffix makes the catalog format explicit so the watcher can parse
  // the catalog and subscribe to video/audio tracks (otherwise detectFormat() is
  // undefined and the viewer only fetches catalog.json, never video/hd).
  let streamName = `${NAMESPACE_PREFIX}/${streamId}.hang`;

  // The content key's secret is minted HERE, in the browser, and travels only in the share
  // link's `#…` fragment. Browsers never send a fragment to a server, so this value cannot
  // reach our Worker, our database, our logs, or the CDN. That is what makes the guarantee
  // structural rather than a promise: there is no code path by which we could decrypt a
  // broadcast, because we never receive what would be required to.
  //
  // The corollary is that the link IS the access control. Anyone holding it can watch, and
  // we cannot revoke that or recover it if the broadcaster loses it.
  let linkSecret = generateLinkSecret();

  // The second secret. Set from the moment this page loads and ON by default, but optional
  // again — see passcodeEnabled below for why the choice freezes at go-live. It is
  // deliberately NOT in the link: the link travels by one channel and this by another, so
  // intercepting either alone is insufficient. It is never sent to or checked by
  // any server — it is mixed into the key derivation, so a wrong passcode simply produces a
  // wrong key and the video fails to decrypt. Nothing anywhere can confirm a guess.
  //
  // It used to be a checkbox, off by default. Two things were wrong with that. A protection
  // nobody switches on protects nobody, and worse, turning it on AFTER sharing left every
  // already-distributed link without `&p=1` — so those viewers were never asked, derived the
  // wrong key, and saw a black player with no explanation. Minting it up front means the flag
  // is in the link from the first copy, and there is no "after" for it to be missed in.
  let passcode: string = generatePasscode();

  // Optional again as of 2026-08-20, but ON by default and FROZEN at go-live.
  //
  // The history matters. This was a checkbox once, off by default, and it was removed because
  // turning it on after sharing left every already-copied link without `&p=1`: those viewers
  // were never asked, derived the wrong key, and saw black with no explanation. Two things
  // changed since. The stuck-viewer watchdog now re-prompts on EVIDENCE (all frames failing to
  // decrypt) rather than on the marker, so that direction self-heals; and the viewer prompt is
  // now dismissible, so the opposite direction — a `p=1` link on a stream that no longer has a
  // passcode — is recoverable instead of a dead end.
  //
  // Freezing it at go-live is still the rule. Both recoveries cost the viewer a black frame and
  // a dialog, and there is no reason to spend that mid-broadcast when the choice can simply be
  // made first. Cycling the passcode stays available while live: that re-keys within the SAME
  // mode and is the revocation mechanism.
  // OFF by default as of 2026-08-28, reversing the 2026-08-20 default.
  //
  // The reason it was ON was "a protection nobody switches on protects nobody", and that is
  // still true — but it was being paid for by everyone, including the broadcaster sending a
  // link to five people in a group chat who then have to be sent a second thing as well. The
  // passcode row sat in front of every first-time broadcaster as a decision they had not asked
  // to make. It is now behind Protect, opt-in, and the trust page says so.
  //
  // What makes this safe NOW and did not before: the two failures that killed off-by-default
  // the first time are both fixed. Turning it on after sharing used to strand viewers holding
  // links without `&p=1` — the stuck-viewer watchdog now re-prompts on EVIDENCE (every frame
  // failing to decrypt) rather than on the marker, so that self-heals; and a `p=1` link on a
  // stream with no passcode used to be a dead end, but the viewer prompt is dismissible now.
  // The choice still freezes at go-live, so neither recovery is normally reached at all.
  let passcodeEnabled = false;
  let passcodeLocked = false;
  const activePasscode = (): string | undefined => (passcodeEnabled ? passcode : undefined);

  // Called the moment go-live is committed to. From here the answer is baked into every link
  // that has been or will be copied, so the choice stops being free.
  const lockPasscodeChoice = (): void => {
    if (passcodeLocked) return;
    passcodeLocked = true;
    const el = document.getElementById("passcode-enabled") as HTMLInputElement | null;
    if (el) {
      el.disabled = true;
      el.title = "Locked while live — the links you have already sent depend on this";
    }
  };

  // Public HKDF salt, handed to us at go-live and to viewers by /route. Held here so a
  // passcode change re-derives with the SAME salt — deriving with a different one would
  // silently break the stream for everyone.
  let activeSalt: string | undefined;

  /**
   * Re-seal the Link watermark under the current key material. Installed by the Link button;
   * a no-op until then, and whenever no link is set.
   *
   * The sealed copy is bound to the salt and passcode exactly as the video is, so anything
   * that re-keys the stream also invalidates it — and the salt in particular does not exist
   * until go-live. Without this, a link armed before going live would be sealed against the
   * fallback salt, and every viewer would get an undecipherable blob while the QR on screen
   * carried on working perfectly: a failure visible only to the audience.
   */
  let resealLink: () => void = () => {};

  // `&p=1` tells a viewer to ask for the passcode. Not a secret, and carrying it in the
  // fragment keeps the server entirely uninvolved in the question. Unconditional now.
  const shareUrl = () =>
    `${window.location.origin}/${streamId}#k=${linkSecret}` + (passcodeEnabled ? "&p=1" : "");

  console.log(`MoQplay Broadcast - Stream: ${streamId}`);

  // Show broadcast view, hide watch view
  document.getElementById("broadcast-view")?.classList.remove("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // The header's Broadcast button is a link to this page, so on this page it is a button that
  // does nothing. It stays everywhere else and is not being deleted: on the landing page it is
  // the ONLY call to action, and on the watch page it is how someone watching a stream starts
  // one of their own.
  //
  // Hidden here rather than in CSS because the header sits outside the view containers, so no
  // selector reaches it from the state that changes. Before the early return below, so it
  // applies to the signed-out case too.
  document.getElementById("nav-broadcast")?.classList.add("hidden");

  // If not logged in, show login required overlay
  if (!user) {
    showLoginRequired();
    return;
  }

  // Day/night moves into the stream card here, immediately left of Protect.
  //
  // MOVED, not duplicated. The same element carries the click listener initTheme() attached by
  // id, and moving a node does not disturb its listeners — so there is one theme control on the
  // page, in one of two places, and no second copy to keep in step. It leaves the header by the
  // act of arriving here, which is why nothing hides it.
  //
  // Deliberately AFTER the sign-in return above, unlike the nav-broadcast line: a visitor who
  // cannot broadcast gets the login overlay over this card, and relocating the theme control
  // into something they cannot see would take it away from them entirely. They keep the header
  // one, which is the right answer for every page that is not a broadcaster's own.
  const protectBtn = document.getElementById("protect-btn");
  const themeBtn = document.getElementById("theme-toggle");
  if (protectBtn && themeBtn) protectBtn.insertAdjacentElement("beforebegin", themeBtn);

  // Update the page with stream info
  const streamDisplay = document.getElementById("stream-id");
  const copyBtn = document.getElementById("copy-btn");

  if (streamDisplay) streamDisplay.textContent = streamId;

  // Copy button functionality
  if (copyBtn) {
    // Mirror the link onto the element that owns it. The clipboard is the user-facing path,
    // but it is unreadable to anything that is not a focused browser window, so the share
    // link would otherwise be unavailable to tests and to the broadcaster's own devtools.
    copyBtn.setAttribute("data-share-url", shareUrl());
    const copyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    const checkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

    // The checkmark must mean "it is on your clipboard", not "you clicked me". This used to
    // fire and forget the write and show the tick unconditionally, so a refused clipboard —
    // an unfocused window, a denied permission, an insecure context — looked identical to
    // success. The broadcaster would then paste whatever was previously on their clipboard
    // into the channel they meant to send the link through, and only find out when nobody
    // could watch.
    //
    // The fallback deliberately reveals the WHOLE link. Selecting the visible stream id
    // instead would be worse than nothing: it omits the `#k=` fragment, so it looks like a
    // share link, copies cleanly, and produces a stream the recipient can never decrypt.
    const shareFallback = document.createElement("input");
    shareFallback.readOnly = true;
    shareFallback.className = "share-fallback hidden";
    shareFallback.setAttribute("aria-label", "Share link — copy this");
    // Appended to the header, NOT inserted after the button: Copy and New-link have to stay
    // adjacent, and slipping an element between them would separate a deliberate pair.
    (copyBtn.closest(".stream-header") ?? copyBtn.parentElement)?.appendChild(shareFallback);

    let copyReset: number | undefined;
    copyBtn.addEventListener("click", async () => {
      window.clearTimeout(copyReset);
      const url = shareUrl();
      let ok = false;
      try {
        await navigator.clipboard.writeText(url);
        ok = true;
      } catch {
        ok = false;
      }

      if (ok) {
        shareFallback.classList.add("hidden");
        copyBtn.innerHTML = checkIcon;
        copyBtn.classList.add("copied");
        copyBtn.setAttribute("title", "Copied");
      } else {
        // Hand them the link in something they can copy by hand, and say so.
        shareFallback.value = url;
        shareFallback.classList.remove("hidden");
        shareFallback.focus();
        shareFallback.select();
        copyBtn.classList.add("copy-failed");
        copyBtn.setAttribute("title", "Couldn't reach the clipboard — the link is selected, copy it manually");
      }

      copyReset = window.setTimeout(() => {
        copyBtn.innerHTML = copyIcon;
        copyBtn.classList.remove("copied", "copy-failed");
        copyBtn.setAttribute("title", "Copy share link");
      }, ok ? 2000 : 6000);
    });
  }

  // Relay-blind E2E media encryption is MANDATORY for every stream — there is no opt-out.
  // Arm the publisher at page load, BEFORE any frame is encoded, so nothing is ever
  // published in the clear; the content key arrives at go-live and releases the queued
  // frames. `streamEncrypted` is always true so goLive requires + installs the key.
  const streamEncrypted = true;
  armPublisher();

  // Passcode control. Re-deriving on every change is intentional and needs no knowledge of
  // whether we are live yet: before go-live it is redundant (go-live derives again with the
  // same inputs), and after go-live it re-keys the stream in place — which IS the revocation
  // mechanism. Viewers holding the old passcode keep their connection and stop being able to
  // decrypt, without the link changing.
  {
    const value = document.getElementById("passcode-value");
    const regen = document.getElementById("passcode-new");

    // The honest caveats belong beside the access affordance. They used to hang off the
    // require-auth toggle, which no longer exists in the markup — so this disclosure has been
    // silently absent. The passcode control is now the thing a broadcaster reasons about
    // privacy with, so it goes here.
    // Both the guidance and the security disclosure live inside ONE panel behind the ⓘ
    // button. They were a permanently visible sentence and a separate "Security details"
    // link; together they made a control bar look like a document, and the disclosure is
    // read-once material rather than something to keep on screen while broadcasting.
    const info = document.getElementById("passcode-info");
    const panel = document.getElementById("passcode-hint");
    panel?.appendChild(createSecurityBody());
    const setPanel = (open: boolean) => {
      panel?.classList.toggle("hidden", !open);
      info?.setAttribute("aria-expanded", String(open));
    };
    info?.addEventListener("click", (e) => {
      e.preventDefault();
      setPanel(panel?.classList.contains("hidden") ?? false);
    });

    const box = document.getElementById("passcode-box");
    const enabled = document.getElementById("passcode-enabled") as HTMLInputElement | null;

    // Protect: the disclosure in front of all of the above.
    //
    // It carries state as well as opening the panel. With the passcode off it is a quiet
    // button; with one armed it lights, because the failure it prevents is a broadcaster who
    // does not know a passcode is set, sends the link alone, and leaves everyone staring at a
    // black player. Same rule as the More menu: hidden may mean off, never means running.
    const protectBtn = document.getElementById("protect-btn");
    const protectPanel = document.getElementById("protect-panel");
    protectBtn?.addEventListener("click", () => {
      const open = !protectPanel?.classList.toggle("hidden");
      protectBtn.setAttribute("aria-expanded", String(open));
      protectBtn.classList.toggle("protect-open", open);
    });
    // Open shackle vs closed. The label used to say "Protect" / "Protected", but on an iPhone
    // in portrait the three words in this card ("Stream:", "watching", "Protect") were most of
    // its width and the card wrapped. The state still has to be visible with no text and no
    // panel open, so it moved into the icon's SHAPE rather than relying on the teal tint —
    // colour alone would hide the one state a broadcaster cannot afford to miss.
    const LOCK_OPEN =
      "M7 9V6a5 5 0 0 1 9.9-1 1 1 0 1 1-2 .4A3 3 0 0 0 9 6v3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1z";
    const LOCK_SHUT =
      "M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5zm0 2a3 3 0 0 1 3 3v3H9V6a3 3 0 0 1 3-3z";

    const syncProtect = () => {
      protectBtn?.classList.toggle("protect-armed", passcodeEnabled);
      document
        .getElementById("protect-icon-path")
        ?.setAttribute("d", passcodeEnabled ? LOCK_SHUT : LOCK_OPEN);
      // The button is icon-only, so this IS its name — not a decoration on top of one.
      const name = passcodeEnabled
        ? "Protected — viewers need the passcode as well as the link. Send it separately."
        : "Protect — no passcode set. The link alone lets people watch.";
      protectBtn?.setAttribute("aria-label", name);
      protectBtn?.setAttribute("title", name);
    };

    const apply = async () => {
      if (value) value.textContent = passcode;
      syncProtect();
      // The passcode itself is meaningless while the toggle is off, so stop showing something
      // copyable that does nothing. It is hidden rather than removed: switching back on before
      // go-live must not mint a different one.
      box?.classList.toggle("hidden", !passcodeEnabled);
      copyBtn?.setAttribute("data-share-url", shareUrl());
      await deriveMediaKey(linkSecret, { streamId, salt: activeSalt, passcode: activePasscode() });
      resealLink();   // the passcode is mixed into the link key too
    };

    enabled?.addEventListener("change", () => {
      if (passcodeLocked) {           // belt and braces; the input is disabled below
        enabled.checked = passcodeEnabled;
        return;
      }
      passcodeEnabled = enabled.checked;
      void apply();
    });

    // Paint the passcode minted above, so the row is populated before anything is shared.
    void apply();

    regen?.addEventListener("click", () => {
      passcode = generatePasscode();
      spin(regen);
      void apply();
    });

    // Copy. The passcode is deliberately sent through a different channel than the link, and
    // retyping eight characters into that other channel is where a broadcaster gets it wrong.
    const copyPass = document.getElementById("passcode-copy");
    copyPass?.addEventListener("click", () => {
      // Report through `title` and a class, NOT textContent: this button's content is an
      // <svg>, and writing text into it would delete the icon permanently.
      const original = copyPass.getAttribute("title") ?? "Copy passcode";
      const done = (label: string) => {
        copyPass.setAttribute("title", label);
        copyPass.classList.add("copied");
        window.setTimeout(() => {
          copyPass.setAttribute("title", original);
          copyPass.classList.remove("copied");
        }, 1500);
      };
      // The clipboard API rejects when the document is not focused or permission is refused.
      // Failing silently would leave the button looking broken, so fall back to selecting the
      // passcode — the user can then copy it themselves, which is the thing they wanted.
      navigator.clipboard?.writeText(passcode).then(
        () => done("Copied"),
        () => {
          const range = document.createRange();
          if (value) {
            range.selectNodeContents(value);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
          done("Select & copy");
        }
      );
    });
  }

  // "Encrypted" is shown unconditionally again: media is encrypted in this browser and
  // cdn.moq.pro carries ciphertext it cannot read. It states an INFRASTRUCTURE property, not
  // who may watch — that distinction is why it is safe to show on every stream.
  //
  // It was removed when the moq.pro migration dropped end-to-end encryption. That is no
  // longer true, so the claim is accurate again.
  const audienceBadge: HTMLSpanElement | null = null;
  // The shield used to be prepended here. It said something true of EVERY stream — encryption
  // is mandatory and cannot be switched off — so as a permanent fixture it was a banner for a
  // constant, and it was the first thing in the row a broadcaster had to look past to reach the
  // two controls they came for. The claim now lives where it is actually load-bearing: on the
  // WATCH page, where a viewer has no other way to know, and on /trust. createRelayBlindBadge()
  // is still used there.

  // Require auth toggle (Public vs Invite-only). Toggling re-keys the audience pill and
  // the viewer-facing access policy; the security-details disclosure (key/metadata
  // caveats) is attached next to this control.
  const requireAuthCheckbox = document.getElementById("require-auth-checkbox") as HTMLInputElement;
  if (requireAuthCheckbox) {
    // The honest caveats live right next to the access affordance.
    requireAuthCheckbox.closest("label")?.after(createSecurityDetails());

    // Load current setting
    getStreamSettings(streamId).then(settings => {
      requireAuthCheckbox.checked = settings.require_auth;
      if (audienceBadge) setAudienceBadge(audienceBadge, settings.require_auth);
    });

    // Save on change - with confirmation for anonymous viewers
    requireAuthCheckbox.addEventListener("change", async () => {
      if (requireAuthCheckbox.checked) {
        // Check for anonymous viewers before enabling auth requirement
        const data = await getStreamViewers(streamId, await deriveRouteTag(linkSecret, streamId));
        const anonymousCount = data?.viewers.filter(v => !v.user_id).length ?? 0;

        if (anonymousCount > 0) {
          const plural = anonymousCount === 1 ? "viewer is" : "viewers are";
          const confirmed = confirm(
            `${anonymousCount} anonymous ${plural} currently watching.\n\nForce them to sign in now?`
          );

          if (!confirmed) {
            // Revert checkbox if not confirmed
            requireAuthCheckbox.checked = false;
            return;
          }
        }
      }

      if (audienceBadge) setAudienceBadge(audienceBadge, requireAuthCheckbox.checked);
      updateStreamSettings(streamId, { require_auth: requireAuthCheckbox.checked });
    });
  }

  // Live chat toggle. When on, reveal the chat panel (right column on desktop, bottom
  // overlay on mobile) and connect the broadcaster to the per-stream ChatRoom; persist
  // the setting so viewers' getStreamSettings() reflects it.
  //
  // The control that drives this is a button in the capture bar under the video, built much
  // further down with the rest of that bar. So the state lives here, in a plain boolean, and
  // the button
  // registers itself when it exists — that way the settings load, the id-rotation path and
  // the button are all driving one source of truth rather than reading each other's DOM.
  const broadcastChatPanel = document.getElementById("broadcast-chat") as HTMLElement | null;
  let chatHandle: ChatHandle | null = null;
  let chatEnabled = false;
  let chatBtn: HTMLButtonElement | null = null;
  const openChat = () => {
    if (!broadcastChatPanel || chatHandle) return;
    broadcastChatPanel.classList.remove("hidden");
    chatHandle = initChat({
      streamId,
      container: broadcastChatPanel,
      user,
      // Same secret and salt as the video, different HKDF context. Derived per use so a
      // passcode change or a go-live salt arriving late is picked up automatically.
      chatKey: () => deriveChatKey(linkSecret, { streamId, salt: activeSalt, passcode: activePasscode() }),
    });
  };
  const closeChat = () => {
    chatHandle?.destroy();
    chatHandle = null;
    broadcastChatPanel?.classList.add("hidden");
  };
  // `persist` is false when we are only catching up with what the server already says, so
  // reloading a broadcast doesn't write the setting back unchanged.
  //
  // ORDER MATTERS, and getting it wrong is what produced a chat stuck on "reconnecting…".
  // The Worker refuses the WebSocket with 403 until this stream's row says chat_enabled = 1
  // (see the /api/streams/:id/chat handler), and the client answers a refused socket with
  // exponential backoff — so opening before the write landed meant the FIRST connect always
  // failed. updateStreamSettings is not a quick call either: it builds a signed publisher
  // claim before it POSTs. The backoff then doubles from 500ms, so an unlucky run sat there
  // saying "reconnecting" for seconds with nothing wrong except the order of two lines.
  //
  // Switching chat OFF keeps the old order: close the socket first, then persist. There is
  // nothing to race — the server refusing a connection we are not making costs nothing.
  const setChatEnabled = async (on: boolean, persist = true): Promise<void> => {
    chatEnabled = on;
    // The button lights immediately either way. It is also what promotes Chat out of the
    // More menu, and a control that waits on a round trip before acknowledging a tap reads
    // as broken.
    chatBtn?.classList.toggle("toggle-on", on);
    if (!on) {
      closeChat();
      if (persist) await updateStreamSettings(streamId, { chat_enabled: false });
      return;
    }
    if (persist && !(await updateStreamSettings(streamId, { chat_enabled: true }))) {
      // The write was refused — almost always no publish key on this device yet. Opening the
      // socket anyway would 403 and then retry on a backoff forever, which is how this
      // presented: a chat that said "reconnecting…" and never would. Say the true thing and
      // put the button back, so the state matches what actually happened.
      chatEnabled = false;
      chatBtn?.classList.toggle("toggle-on", false);
      window.alert(
        "Chat needs a publish key first.\n\n" +
        "Paste or scan your key, then switch chat on again. Everything else on this page " +
        "works without one — only saving settings and going live need it."
      );
      return;
    }
    openChat();
  };
  getStreamSettings(streamId).then((settings) => {
    // persist=false, so this opens immediately — correct, because the server has just told
    // us it already considers chat enabled.
    if (settings.chat_enabled) void setChatEnabled(true, false);
  });

  // Stop publishing if this broadcast is terminated.
  //
  // Its own poll, deliberately not folded into the viewer-stats refresh below: that one is
  // inside `if (vsToggle && vsCount && vsPanel)`, so hanging this off it would mean a missing
  // stats badge silently disables the broadcaster's half of the kill switch. A safety
  // mechanism should not depend on a UI element being present.
  //
  // This side matters more than the viewer side. A terminated stream whose publisher keeps
  // sending is still reaching everyone already connected; stopping the source is what ends
  // the broadcast for people we cannot otherwise reach.
  const killWatch = window.setInterval(async () => {
    const settings = await getStreamSettings(streamId);
    if (!settings.killed) return;
    window.clearInterval(killWatch);
    stopForKill("broadcaster");
  }, 5000);
  window.addEventListener("beforeunload", () => window.clearInterval(killWatch));

  // Live viewer stats: a "👁 N watching" badge in the header that expands to a
  // per-viewer list (location flag + watch duration). Polls the public viewers
  // endpoint every 5s; mirrors the /{stream}/stats renderer, inline for the broadcaster.
  const vsToggle = document.getElementById("viewer-stats-toggle");
  const vsCount = document.getElementById("viewer-count");
  const vsPanel = document.getElementById("viewer-stats-panel");
  if (vsToggle && vsCount && vsPanel) {
    let vsViewers: LiveViewer[] = [];

    const fmtDuration = (dateStr: string) => {
      const secs = Math.max(0, Math.floor((Date.now() - new Date(dateStr + "Z").getTime()) / 1000));
      if (secs < 60) return `${secs}s`;
      const mins = Math.floor(secs / 60);
      if (mins < 60) return `${mins}m ${secs % 60}s`;
      return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    };

    const renderPanel = () => {
      if (vsPanel.classList.contains("hidden")) return; // only build DOM when open
      const rows = vsViewers.length === 0
        ? `<tr><td colspan="2" class="empty">No active viewers</td></tr>`
        : vsViewers.map((v) => {
            // Viewer locations are no longer collected, so there is nothing to place here
            // beyond the fact that someone is watching. See renderGeoFlag below.
            return `<tr><td>Viewer</td><td>${fmtDuration(v.started_at)}</td></tr>`;
          }).join("");
      vsPanel.innerHTML = `<table class="stats-table"><tbody>${rows}</tbody></table>`;
    };

    const refreshViewers = async () => {
      // Derived per call rather than cached: New link rotates linkSecret mid-broadcast, and a
      // stale tag would silently 404 the badge into "no viewers" for the rest of the stream.
      const data = await getStreamViewers(streamId, await deriveRouteTag(linkSecret, streamId));
      if (!data) return; // transient failure — keep the last known count
      vsViewers = data.viewers;
      vsCount.textContent = String(vsViewers.length);
      renderPanel();
    };

    vsToggle.addEventListener("click", () => {
      const open = !vsPanel.classList.toggle("hidden");
      vsToggle.setAttribute("aria-expanded", String(open));
      if (open) renderPanel();
    });

    refreshViewers();
    const vsInterval = window.setInterval(refreshViewers, 5000);
    window.addEventListener("beforeunload", () => window.clearInterval(vsInterval));
  }

  // What to tell a broadcaster when capture would not start.
  //
  // getUserMedia/getDisplayMedia report failures as DOMException *names*, and the name is the
  // only part that is stable across engines — the messages differ ("Could not start video
  // source" on Chromium, "The request is not allowed by the user agent" on WebKit), so match
  // on the name and write the sentence ourselves. NotReadableError is the one that prompted
  // this: Windows lets a single app hold the camera, so a camera already open in Teams or the
  // Camera app fails here and on no other platform.
  const captureFailureText = (e: unknown): string => {
    const name = e instanceof Error ? e.name : "";
    const detail = e instanceof Error && e.message ? ` (${e.message})` : "";
    switch (name) {
      case "NotAllowedError":
      case "SecurityError":
        return "The browser did not allow the camera or microphone. If you dismissed the prompt, " +
          "reload and allow it; if you blocked it, clear this site's camera permission first.";
      case "NotReadableError":
      case "AbortError":
        return "The camera could not be started — on Windows only one app can use it at a time. " +
          "Close anything else that has it open (Teams, Zoom, the Camera app) and try again." + detail;
      case "NotFoundError":
      case "OverconstrainedError":
        return "No camera or microphone was found. Check that one is connected, and that this " +
          "browser is allowed to use it in the system's privacy settings.";
      default:
        return `Capture could not start${detail || "."}`;
    }
  };

  // What to tell a broadcaster when going live did not.
  //
  // The Worker already writes its refusals for a person ("that broadcast name is in use",
  // "This stream has been terminated."), so those are passed through rather than re-worded —
  // re-wording them here would mean two places to keep in step, and the second one always
  // drifts. What is added is the part the Worker cannot know: what to do about it.
  //
  // `null` means go-live never got as far as asking, because no publisher claim could be
  // built: either no publish key on this device, or /api/publish/challenge declined.
  const goLiveFailureText = (res: BroadcastStart | null): string => {
    if (!res) {
      return "Could not prove this broadcast is yours. Check the publish key for this device, " +
        "then switch a camera or microphone back on to try again.";
    }
    const said = res.error ? ` ${res.error}` : "";
    if (res.status === 0) {
      return `Could not reach ${location.host} to start the broadcast — this looks like a ` +
        `network problem at this end. Check the connection and try again.${said}`;
    }
    switch (res.status) {
      case 401:
      case 403:
        return `The server would not start this broadcast:${said || " permission was refused."} ` +
          "If this is about the publish key, a new one can be requested; if the stream was " +
          "terminated, starting a new link is the way on.";
      case 503:
        return "Broadcasting is not available right now — the server is not configured to " +
          `issue publish tokens.${said} This is at our end, not yours.`;
      default:
        // Includes the case this branch always used to claim: a 200 with no relay, which is
        // the broker being down. Everything else lands here with its own status attached.
        return "Could not start the broadcast." +
          (said || ` The server answered ${res.status ?? "nothing"}.`) +
          " Switch a camera or microphone back on to try again.";
    }
  };

  // Drive the headless <moq-publish> core element with our own control bar.
  const publisher = document.querySelector("moq-publish") as MoqPublishElement | null;
  if (publisher) {
    // The relay URL is NOT static: on go-live the Worker calls tinymoq /assign and
    // returns the relay hosting this broadcast; we point the publisher at it then.
    publisher.setAttribute("name", streamName);

    // A line under the control bar for things that happen TO a broadcast rather than because
    // someone clicked. Everything here used to be a console.error, which is to say invisible:
    // reported from Edge on Windows as "the camera does not stay open — I see it for a second
    // and then it goes away", and from another broadcaster as a Server Status card reading
    // "(no relay assigned)" with nothing anywhere to say why.
    //
    // Declared up here rather than beside the control bar because goLive() below reports
    // through it, and goLive is defined first.
    const notice = document.createElement("div");
    notice.className = "capture-notice hidden";
    notice.setAttribute("role", "status"); // announced, but does not steal focus
    /**
     * Show one sentence, or null to clear.
     *
     * `action` adds a button to it. Reserved for failures the broadcaster can actually undo
     * from here — a message that explains and then leaves you stuck is only half an answer.
     */
    const say = (msg: string | null, action?: { label: string; run: () => void }) => {
      notice.textContent = msg ?? ""; // also drops any button from a previous message
      notice.classList.toggle("hidden", !msg);
      if (!msg || !action) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "notice-action";
      btn.textContent = action.label;
      btn.addEventListener("click", action.run);
      notice.appendChild(btn);
    };

    let broadcastEventId: number | null = null;
    let goLivePromise: Promise<void> | null = null;

    // First device selection = go live: get the assigned relay, then connect to it.
    // logBroadcastStart hits POST /api/stats/broadcast which calls /assign and stores
    // the relay on the broadcast row (so viewers can co-locate). Idempotent/sticky.
    const goLive = (): Promise<void> => {
      if (goLivePromise) return goLivePromise;
      lockPasscodeChoice();
      // Prove admission + name ownership before asking for a publish token. buildPublisherClaim
      // mints a fresh Ed25519 keypair for THIS broadcast (non-extractable, never leaves the
      // page) and signs a Worker-issued challenge with it.
      goLivePromise = (async () => {
        const claim = await buildPublisherClaim(streamId);
        if (claim) return claim;

        // No code on this device yet. MINT ONE SILENTLY rather than asking.
        //
        // The dialog was the first thing a new broadcaster met, and everything it offered was
        // one button they had no basis to decline: the code is not an account, costs a second
        // of proof-of-work, identifies nobody, and is remembered per device. Making someone
        // read three paragraphs to press "Get a code" is asking them to consent to something
        // that was never a choice.
        //
        // What the code actually gates is unchanged — bandwidth billed to our moq.pro tenant
        // and the Extras HTML surface that runs in viewers' browsers. Admission still happens;
        // it just stops being a form.
        try {
          say("Setting up this device to broadcast…");
          const minted = await fetchPublishCode();
          // activeImmediately is false when PUBLISH_CODE_DELAY_HOURS is raised above zero. A
          // code that exists but will not admit anyone yet must NOT be stored silently — the
          // broadcaster would then fail admission with no explanation. Fall through to the
          // dialog, which is the only thing that says so.
          if (minted.activeImmediately) {
            setPublishKey(minted.code);
            const retried = await buildPublisherClaim(streamId);
            if (retried) {
              say(null);
              return retried;
            }
          }
        } catch (e) {
          // Issuance off, offline, work rejected. Not fatal and not silent: the dialog below
          // carries the paste box and the server's own message.
          console.warn("[publish] could not mint a publish code automatically:", e);
        }
        say(null);

        const entered = await promptPublishKey();
        if (!entered) {
          console.error("[publish] no publish key; not going live");
          goLivePromise = null;
          return null;
        }
        setPublishKey(entered);
        return buildPublisherClaim(streamId);
      })().then(async (claim) => {
        if (!claim) return null;
        // Register the proof-of-link tag for this broadcast, so the Worker can require viewers
        // to demonstrate they hold the share link before it mints them a token. Derived here
        // because `linkSecret` never leaves this page in any other form.
        const routeTag = await deriveRouteTag(linkSecret, streamId);
        return logBroadcastStart(streamId, getCdnOverride("publisher-cdn"), claim, routeTag);
      }).then(async (res) => {
        broadcastEventId = res?.eventId ?? null;
        const relay = res?.relay;
        const jwt = res?.jwt;
        if (!relay || !jwt) {
          // Until 2026-08-29 this branch blamed the broker for everything and told nobody:
          // a console line, and a Server Status card reading "(no relay assigned)". At least
          // eight unrelated refusals arrive here, only one of which is actually /assign being
          // down, and the most common of them was recoverable in one click by someone who had
          // no way to know that. Allow a retry on the next device action rather than
          // connecting to a dead endpoint, but say what happened first.
          console.error(
            "[routing] go-live got no relay/token:",
            res ? `HTTP ${res.status ?? "?"} ${res.error ?? ""}` : "no publisher claim"
          );
          setActiveRelay(null);
          goLivePromise = null;
          // 409 means a row for this stream id is still open under a different publisher key.
          // Nearly always that is the SAME person: the keypair is deliberately lost on reload
          // while the id survives in ?stream=, so returning to your own tab looks to the
          // Worker like a stranger. Rotating the id both frees the old row and sidesteps it.
          if (res?.status === 409) {
            say(
              "This broadcast link is still marked as live from an earlier session, so it " +
              "cannot be started again under the same name. Starting a new link fixes it.",
              { label: "Start a new link", run: () => void rotateIdentity({ confirm: false }) }
            );
          } else {
            say(goLiveFailureText(res));
          }
          return;
        }
        // Relay-blind E2E: install the per-broadcast content key BEFORE connecting,
        // so the frames the armed publisher has been queuing get encrypted. The
        // server is authoritative on whether the stream is encrypted.
        // Relay-blind E2E applies to BOTH transports, so the key is installed here rather
        // than inside either branch. This is load-bearing: armPublisher() has already run,
        // so every encoded frame is queued awaiting this key. If it is never installed the
        // queue never drains, NOTHING is published, and a viewer subscribes successfully to
        // a track that stays silent forever -- a failure with no error on either side.
        if (res?.encrypted || streamEncrypted) {
          activeSalt = res?.salt ?? undefined;
          armPublisher(); // idempotent; covers the case where settings load lost the race
          await deriveMediaKey(linkSecret, { streamId, salt: activeSalt, passcode: activePasscode() });
          // The salt only exists now, so anything sealed before this moment was sealed against
          // the wrong key. This is the go-live case the resealLink comment describes.
          resealLink();
        }
        if (res?.path) {
          // moq.pro (Mode A): the broadcast path travels in the connect URL, so `name`
          // stays empty. Encryption is identical to the fleet path below.
          publisher.setAttribute("name", "");
          publisher.setAttribute("url", moqUrl(relay, res.path, jwt));
        } else {
          publisher.setAttribute("name", streamName);
          publisher.setAttribute("url", `https://${relay}/?jwt=${jwt}`);
        }
        setActiveRelay(relay);
        say(null); // whatever the last attempt failed with, it is no longer true
        console.log("[routing] broadcaster relay:", relay, "eventId:", broadcastEventId);
      });
      return goLivePromise;
    };

    // End the broadcast: mark ended + free the relay assignment (server-side /release).
    const endBroadcast = () => {
      if (broadcastEventId) {
        logBroadcastEnd(broadcastEventId);
        console.log("Broadcast ended, event ID:", broadcastEventId);
        broadcastEventId = null;
      }
      goLivePromise = null; // a later device selection re-assigns
      // Drop the content key (keep the publisher armed): a restarted broadcast
      // gets a fresh key, and frames queue until it arrives — never encrypted
      // with the previous session's key.
      resetMediaKey();
    };

    // --- Combinable capture toggles: 📹 Camera (video) + 🎤 Audio + 🖥️ Screen ---
    // Camera and/or Screen video is composited onto a single <canvas> and published as one
    // stable track (announce=true + source=undefined so the element's own capture stands
    // down); audio is mixed (mic for camera, system/tab audio for screen) into one stable
    // track. Toggling sources changes only the compositor inputs, never the published
    // tracks, so viewers never see a reset. Audio-only uses the element's native source.
    type Toggle = "camera" | "audio" | "screen";
    const capture: Record<Toggle, boolean> = { camera: false, audio: false, screen: false };
    let anyActive = false;

    // "New link" — replace the broadcast's whole identity in place.
    //
    // This is a clean break, not a re-key: a fresh stream id AND a fresh link secret, which
    // means a fresh claim keypair, a fresh relay assignment and a fresh salt too. The old
    // share link is dead in both halves — its id no longer names a live broadcast, and its
    // secret no longer derives the right key — so it cannot be resurrected by anyone who
    // kept it, including us.
    //
    // Capture is deliberately NOT touched. Ending and restarting the broadcast while leaving
    // the compositor alone is the whole point: the broadcaster keeps their camera, mic and
    // screen exactly as they had them and only the address changes.
    // The New-link BUTTON was removed from the stream header on 2026-08-30. rotateIdentity
    // stays: it is still the recovery offered when go-live hits a name conflict (the "Start a
    // new link" action further up), which is a path a broadcaster cannot reach any other way.
    //
    // What went with the button is the deliberate use — rotating a link that has escaped. There
    // is now no control for that; ending the broadcast is the nearest thing.
    let rotating = false;
    const rotateIdentity = async (opts?: { confirm?: boolean }) => {
      if (rotating) return;
      // Only guard once there is an audience to lose. Before go-live nobody holds the link,
      // so a confirmation would be noise on the one click that costs nothing.
      //
      // `confirm: false` is the recovery path from a name conflict: capture is on (which is
      // what triggered go-live), so anyActive is true, but the broadcast never started and
      // nobody is watching. Warning that everyone will be cut off would be false.
      if (opts?.confirm !== false && anyActive && !window.confirm(
        "Start a new link?\n\nThis ends the current broadcast and starts a fresh one. " +
        "Everyone watching now — and anyone holding the old link — will be cut off until " +
        "you send them the new one."
      )) return;

      rotating = true;
      try {
        const wasLive = anyActive;
        closeChat();       // the room is keyed to the old stream id
        endBroadcast();    // marks the old row ended, frees the relay, drops the media key

        streamId = await generateStreamId();
        streamName = `${NAMESPACE_PREFIX}/${streamId}.hang`;
        linkSecret = generateLinkSecret();
        activeSalt = undefined;   // the new go-live issues its own; deriving with a stale one
                                  // would silently produce a key no viewer can reproduce
        publisher.setAttribute("name", streamName);

        if (streamDisplay) streamDisplay.textContent = streamId;
        copyBtn?.setAttribute("data-share-url", shareUrl());
        // Keep the address bar honest, so a refresh resumes the NEW broadcast, not the dead one.
        window.history.replaceState({}, "", broadcastUrl(streamId));

        // The passcode survives on purpose. It travels by a different channel and rotating the
        // link already cuts everyone off; forcing the broadcaster to re-send both would make
        // this control more expensive than it needs to be.
        if (wasLive) await goLive();
        if (chatEnabled) openChat();   // re-joins, now keyed to the new stream id
        // New id and new link secret, so the sealed copy has to be written again under the new
        // stream's row. goLive already did it when the rotation was live; this covers the
        // rotate-while-stopped case, where nothing else would.
        if (!wasLive) resealLink();
        console.log("[rotate] new identity:", streamId);
      } finally {
        rotating = false;
      }
    };

    // Low-level seam: a video/audio Source is just a MediaStreamTrack signal.
    const bcast = publisher.broadcast as unknown as {
      video: { source: { set(t: MediaStreamTrack | undefined): void } };
      audio: { source: { set(t: MediaStreamTrack | undefined): void } };
    };

    // Any video state (camera and/or screen) routes through ONE compositor whose canvas
    // and audio-mix tracks are published once and never re-set. Toggling camera/screen/
    // mic changes only the compositor's inputs, so the viewer never sees a track reset
    // (RESET_STREAM) — the <moq-watch> element can't re-subscribe after one and would
    // otherwise freeze. ALL capture (including audio-only) goes through the compositor so
    // the publish path never switches the element's source mode mid-broadcast — that switch
    // silently dropped audio when the sequence was audio-first-then-video.
    let comp: Compositor | null = null;
    // Filled in when the control bar is built, further down. A mutable hook rather than a
    // direct call because applyState is DEFINED above that code and would otherwise read a
    // `const` from its temporal dead zone the first time a button was clicked.
    let onCameraChanged: () => void = () => {};
    // Location + time burn-in, armed independently of capture (see the stamp button below).
    let geoStamp: GeoStamp | null = null;
    // The handle watermark, likewise armed independently (see the @ button below).
    let watermark: string | null = null;
    // The Link watermark: the URL for the tappable copy, and the encoded matrix for the
    // picture. Both are kept because the matrix has to be re-attached to each new compositor
    // and re-encoding it on every capture toggle would be wasted work.
    let linkUrl: string | null = null;
    let linkQr: QrMatrix | null = null;
    // Video and audio sources are wired in independently and each exactly once, so a track
    // that appears later (camera added after audio-only, or vice versa) binds without
    // re-setting the other (re-setting a live track triggers RESET_STREAM → frozen viewers).
    let boundVideo = false;
    let boundAudio = false;
    const teardownComposite = () => {
      if (!comp) return;
      comp.stop();
      comp = null;
      boundVideo = false;
      boundAudio = false;
      bcast.video.source.set(undefined);
      bcast.audio.source.set(undefined);
      const v = publisher.querySelector("video") as HTMLElement | null;
      if (v) v.style.display = ""; // restore the element's own preview
      // Switching off the LAST capture never reaches the source reconcile below — it stops
      // here — so anything watching the camera has to be told from both places, not one.
      onCameraChanged();
    };

    // Serialize because getDisplayMedia/getUserMedia show permission prompts.
    let applying = false;
    const applyState = async () => {
      if (applying) return;
      applying = true;
      try {
        const { camera, audio, screen } = capture;
        anyActive = camera || audio || screen;
        const hasVideo = camera || screen;

        // Any active capture — video and/or audio — runs through ONE compositor path.
        // Audio-only just publishes the audio mix with no video track bound. Keeping a
        // single path is what makes the sequence order-independent.
        if (anyActive) {
          try {
            if (!comp) {
              comp = createCompositor();
              const v = publisher.querySelector("video") as HTMLElement | null;
              if (v) v.style.display = "none";
              comp.canvas.className = "pip-canvas";
              publisher.insertAdjacentElement("afterbegin", comp.canvas);
              // The compositor is created and destroyed as capture comes and goes, but the
              // overlays outlive it (either can be armed before any camera is on, and both
              // must survive a stop/start). Re-attach them to each new compositor.
              if (geoStamp) comp.setStampProvider(geoStamp.line);
              if (watermark) comp.setWatermark(watermark);
              if (linkQr) comp.setLinkQr(linkQr);
            }
            // Reconcile video sources without re-prompting the ones already captured.
            if (screen && !comp.hasScreen()) {
              await comp.enableScreen({
                onEnded: () => { capture.screen = false; syncButtons(); void applyState(); },
              });
            } else if (!screen && comp.hasScreen()) {
              comp.disableScreen();
            }
            if (camera && !comp.hasCamera()) {
              await comp.enableCamera({
                // The camera going away is not a click, so nothing else would ever say so.
                onEnded: () => {
                  capture.camera = false;
                  syncButtons();
                  say(
                    "The camera stopped. Another app or the system took it — close whatever else " +
                    "is using it, then switch Camera back on."
                  );
                  void applyState();
                },
                onMuteChange: (muted) =>
                  say(
                    muted
                      ? "The camera has stopped sending frames — it is probably in use by another " +
                        "app. Anyone watching is seeing a frozen picture."
                      : null
                  ),
              });
              say(null); // a fresh start clears whatever the last one failed with
            } else if (!camera && comp.hasCamera()) comp.disableCamera();
            onCameraChanged();

            // Audio routing: the mic is captured whenever audio is on (incl. while screen
            // sharing — for narration), and tab/system audio is additionally mixed in when a
            // screen that carries audio is shared. Both feed one stable mixed output track,
            // so toggling sources never resets the published audio.
            comp.setSystemAudioEnabled(audio && screen);
            await comp.setMicEnabled(audio);

            publisher.announce = true;
            publisher.source = undefined;
            publisher.invisible = !hasVideo; // audio-only -> no camera light / no video track
            publisher.muted = false; // the mixed audio track is always published (silent when audio off) to keep it stable
            // Bind each track once, when it first appears. Drop the video track if video
            // goes away while audio stays (so audio-only never publishes a black frame).
            if (!hasVideo && boundVideo) {
              bcast.video.source.set(undefined);
              boundVideo = false;
            } else if (hasVideo && !boundVideo) {
              bcast.video.source.set(comp.videoTrack);
              boundVideo = true;
            }
            if (!boundAudio) {
              bcast.audio.source.set(comp.audioTrack);
              boundAudio = true;
            }
            void goLive();
          } catch (e) {
            console.error("[media] capture failed (or cancelled):", e);
            // Until 2026-08-28 this was the whole handling: revert the toggle, log, and leave
            // the broadcaster watching a button switch itself back off for no stated reason.
            // A console.error is only visible to whoever opens devtools, which is nobody.
            say(captureFailureText(e));
            capture.screen = false;
            capture.camera = false;
            syncButtons();
            teardownComposite();
          }
          return;
        }

        // Nothing active — end the broadcast and drop the compositor.
        teardownComposite();
        publisher.announce = "source";
        publisher.source = null;
        endBroadcast();
      } finally {
        applying = false;
      }
    };

    // --- Build the control bar (status + capture toggles + overlay toggle) ---
    const bar = document.createElement("div");
    bar.className = "publish-controls";

    const statusEl = document.createElement("div");
    statusEl.className = "publish-status";
    statusEl.textContent = "⚪";
    statusEl.setAttribute("data-status-text", "Offline");
    bar.appendChild(statusEl);

    const toggleButtons: Partial<Record<Toggle, HTMLButtonElement>> = {};
    const syncButtons = () => {
      (Object.keys(toggleButtons) as Toggle[]).forEach((k) => {
        toggleButtons[k]?.classList.toggle("toggle-on", capture[k]);
      });
    };
    // Generic filled media-input icons (currentColor so they follow the button's on/off color).
    const ICONS = {
      camera:
        '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M17 10.2l4-2.6A1 1 0 0 1 22.5 8.4v7.2a1 1 0 0 1-1.5.8L17 13.8z"/></svg>',
      audio:
        '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M6 11a1 1 0 1 1 2 0 4 4 0 0 0 8 0 1 1 0 1 1 2 0 6 6 0 0 1-5 5.92V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-3.08A6 6 0 0 1 6 11z"/></svg>',
      screen:
        '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><path d="M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/></svg>',
      // An eye between two big arrows: one pointing right above it, one pointing left
      // below. It began as arrows curling AROUND the eye, and that failed for a reason
      // worth keeping: a ring at 18px has to be thin to stay a ring, and a thin curve is
      // the first thing to disappear. Straight arrows can be as heavy as the glyph allows,
      // so the part carrying the meaning is the part with the most ink.
      //
      // The eye is a filled lens with the pupil knocked out (fill-rule: evenodd) rather
      // than an outline, for the same reason — an outlined eye reads as a smudge beside
      // arrows this solid.
      flip:
        '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><path d="M2 3.1h12.2V1L22 4.2 14.2 7.4V5.3H2z"/><path d="M22 20.9H9.8V23L2 19.8 9.8 16.6V18.7H22z"/><path fill-rule="evenodd" d="M6.6 12Q12 7 17.4 12Q12 17 6.6 12ZM12 13.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z"/></svg>',
    } as const;
    // Icon plus a short name, the name shown only where there is room for it (see .btn-label).
    //
    // The row was six icons a first-time broadcaster could not identify — a pin with an "i" in
    // it, a bare "@", and "</>" — so it read as six unknowns rather than six features. The fix
    // is naming them, not hiding them: a label makes a feature more visible, an overflow menu
    // makes it less. On a phone there is no room, so the icons stand alone there and the
    // grouping below does the work instead.
    const faced = (glyph: string, label: string) =>
      `<span class="btn-glyph">${glyph}</span><span class="btn-label">${label}</span>`;

    const makeToggle = (key: Toggle, icon: string, label: string, name: string) => {
      const b = document.createElement("button");
      b.type = "button";
      // Screen capture (getDisplayMedia) isn't available on mobile browsers — tag the
      // screen toggle so CSS can hide it on touch devices (iOS/Android).
      b.className = "publish-btn toggle-btn" + (key === "screen" ? " cap-screen" : "");
      b.title = label;
      b.innerHTML = faced(icon, name);
      b.addEventListener("click", () => {
        capture[key] = !capture[key];
        syncButtons();
        void applyState();
      });
      toggleButtons[key] = b;
      bar.appendChild(b);
    };
    // Group one: where the picture and sound come from.
    makeToggle("camera", ICONS.camera, "Camera", "Camera");
    makeToggle("audio", ICONS.audio, "Audio (microphone; also mixes in tab/system audio when screen sharing)", "Audio");
    makeToggle("screen", ICONS.screen, "Screen", "Screen");

    // --- "More": everything that is not a camera or a microphone ------------------------
    //
    // Seven controls read as seven decisions to make before you can start. Camera and Audio
    // are the only two anyone needs to go live; the rest are things you might add once you
    // are already broadcasting.
    //
    // This reverses a call made on 2026-08-16 NOT to hide these behind a menu, so the reason
    // for that call has to survive the reversal. It was: a menu makes the least-known features
    // hardest to find, and — the part with real consequences — it can hide a control that is
    // currently ON, so a broadcaster would not see that the location burn-in is running and
    // being drawn into their picture.
    //
    // THE RULE THAT KEEPS THAT TRUE: an advanced control that is ON is never inside the menu.
    // It is promoted into the bar and stays there, lit, until it is switched off. The row
    // therefore shows exactly what is active plus a way to add more, and "hidden" only ever
    // means "off". Switching it off is what puts it away again.
    const morePanel = document.createElement("div");
    morePanel.className = "publish-more-panel hidden";
    morePanel.id = "publish-more-panel";

    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "publish-btn more-btn";
    moreBtn.id = "more-btn";
    moreBtn.setAttribute("aria-expanded", "false");
    moreBtn.setAttribute("aria-controls", "publish-more-panel");
    moreBtn.title = "More — screen sharing, chat, and what gets drawn on the picture";
    moreBtn.innerHTML = faced(
      '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">' +
      '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>' +
      "</svg>",
      "More"
    );
    moreBtn.addEventListener("click", () => {
      const open = !morePanel.classList.toggle("hidden");
      moreBtn.setAttribute("aria-expanded", String(open));
      moreBtn.classList.toggle("more-open", open);
    });

    const advancedBtns: HTMLButtonElement[] = [];
    const placeAdvanced = (): void => {
      for (const b of advancedBtns) {
        // Two classes mean "on" here: the capture and burn-in toggles use .toggle-on, the
        // Extras editor uses .active. Read both rather than normalising them, which would
        // mean touching five handlers in order to change one layout rule.
        const on = b.classList.contains("toggle-on") || b.classList.contains("active");
        const parent = on ? bar : morePanel;
        if (b.parentElement === parent) continue;
        if (on) bar.insertBefore(b, moreBtn);
        else morePanel.appendChild(b);
      }
      // Tells the stylesheet the row is carrying promoted controls and may need a second line
      // on a phone. See .publish-controls.has-promoted — measured, not guessed: with every
      // advanced control on, the row wants 352px inside 326px on a 390px iPhone.
      bar.classList.toggle(
        "has-promoted",
        advancedBtns.some((b) => b.parentElement === bar)
      );
    };
    /**
     * Hand a finished button over to the menu.
     *
     * Placement follows a MutationObserver on the class attribute rather than calls added to
     * each button's own handler. Several of these turn themselves on and off from places a
     * click never reaches — the geo stamp clears itself when permission is refused, chat
     * lights up when saved settings arrive after the bar is built, Extras toggles from inside
     * the editor — and every one of those has to move the button too. Watching the state that
     * is already the source of truth catches all of them; wiring the handlers would have
     * caught the two I happened to think of.
     */
    const advanced = (b: HTMLButtonElement): void => {
      advancedBtns.push(b);
      new MutationObserver(placeAdvanced).observe(b, {
        attributes: true,
        attributeFilter: ["class"],
      });
      placeAdvanced();
    };

    // More goes in BEFORE any advanced button is registered: promotion inserts before it, so
    // it has to already be in the bar or the first promoted control has nothing to sit against.
    bar.appendChild(moreBtn);

    // Screen is advanced, but makeToggle has already appended it to the bar.
    if (toggleButtons.screen) advanced(toggleButtons.screen);

    // --- Flip: front camera <-> back camera ---------------------------------------------
    //
    // Lives INSIDE the More panel, and the promotion rule that governs everything else there
    // does not apply to it. That rule exists so a control which is switched ON can never be
    // out of sight; Flip is an action, not a toggle, so it has no "on" to hide. Pressing it
    // changes the picture immediately and visibly, which is its own feedback.
    //
    // PHONE ONLY, via .cap-mobile. A desktop with two webcams has two cameras pointing
    // wherever they happen to point — "front" and "back" describe a phone, and Chrome reports
    // no facingMode to tell them apart anyway.
    //
    // Shown whenever the camera is live. Nothing else is consulted, and in particular NOT the
    // number of cameras enumerateDevices reports.
    //
    // That gate was here and it was wrong for the only platform this feature exists for: iOS
    // Safari reports ONE videoinput for a phone with three cameras, exposing front and back
    // through the facingMode constraint instead of as separate devices. Which is what
    // facingMode is for. Gating on the count hid the control on every iPhone.
    //
    // It went unnoticed for a day because .publish-btn's display beat the [hidden] attribute,
    // so the button was on screen no matter what this decided — the CSS fix is what made the
    // wrong gate start biting. Two mistakes, each hiding the other.
    //
    // The cost of dropping it: a phone with a single camera gets a button that re-acquires
    // the same camera. There is no way to tell that phone apart on iOS, and a rare no-op
    // beats hiding the control on every iPhone there is.
    //
    // The label never renders here — .btn-label is display:none below 601px, which is every
    // device this button appears on — so the icon carries the whole meaning and aria-label
    // carries it for anyone not looking at the icon.
    const flipBtn = document.createElement("button");
    flipBtn.type = "button";
    flipBtn.className = "publish-btn toggle-btn cap-mobile";
    flipBtn.id = "flip-camera-btn";
    flipBtn.hidden = true;

    // Name the camera you would GET, not the one you are on. A button reading "Back" while
    // the back camera is live looks like a state indicator, and gets pressed to leave it.
    const labelFlip = (live: CameraFacing): void => {
      const next = live === "environment" ? "Front" : "Back";
      const say = `Switch to the ${next.toLowerCase()} camera`;
      flipBtn.title = say;
      flipBtn.setAttribute("aria-label", say);
      flipBtn.innerHTML = faced(ICONS.flip, next);
    };
    labelFlip("user");

    let flipping = false;
    flipBtn.addEventListener("click", () => {
      if (flipping || !comp?.hasCamera()) return;
      flipping = true;
      flipBtn.disabled = true;
      void comp
        .switchCamera()
        .then((live) => {
          // null means neither camera came back. switchCamera has already fired onEnded,
          // which switches Camera off and says why, so there is nothing to add here.
          if (live) labelFlip(live);
        })
        .finally(() => {
          flipping = false;
          flipBtn.disabled = false;
        });
    });
    morePanel.appendChild(flipBtn);

    onCameraChanged = () => {
      const live = comp?.cameraFacing() ?? null;
      flipBtn.hidden = !live;
      if (live) labelFlip(live);
    };


    // --- Location + time burn-in ---
    //
    // Deliberately at odds with everything else here, and opt-in for exactly that reason.
    // Two jobs: make a frame harder to pass off as somewhere or somewhen else, and make
    // glass-to-glass latency readable by anyone who can see a clock.
    //
    // Not a capture toggle: it draws over the video, it isn't a source of one. Turning it on
    // alone won't start a broadcast or publish a black frame — it arms, and it appears the
    // moment there's a picture to sit on.
    //
    // The coordinates never leave the broadcaster's browser except as pixels: fetched from
    // our own edge, rendered to canvas, encrypted with the rest of the frame. We don't store
    // them, and the only people who see them are the ones already holding the link and the
    // passcode. See src/media/geo-stamp.ts for why the clock is the server's, not the laptop's.
    const stampBtn = document.createElement("button");
    stampBtn.type = "button";
    stampBtn.className = "publish-btn toggle-btn";
    stampBtn.id = "stamp-btn";
    stampBtn.title = "Burn in location and time — asks your browser for your location, then draws it and a UTC clock into the picture for everyone watching";
    // A map pin with an info "i" knocked out of it (evenodd), so one glyph says both
    // "where" and "this is information about the shot".
    stampBtn.innerHTML = faced(
      '<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" width="18" height="18" aria-hidden="true">' +
      '<path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7z' +
      'M10.9 6.2a1.1 1.1 0 1 0 2.2 0 1.1 1.1 0 1 0-2.2 0z' +
      'M11.05 8.6h1.9v4.9h-1.9z"/></svg>',
      "Location"
    );

    let stampBusy = false;
    let stampWarned = false;
    const toggleStamp = async () => {
      if (stampBusy) return;
      stampBusy = true;
      try {
        if (geoStamp) {
          geoStamp.stop();
          geoStamp = null;
          comp?.setStampProvider(null);
        } else {
          // Ask once per session. This is the one control here that deliberately publishes
          // something about the broadcaster, it cannot be taken back out of a recording
          // someone already made, and it is one click away from the camera button.
          if (!stampWarned && !window.confirm(
            "Show your location in the video?\n\n" +
            "Your browser will ask permission for your location. If you allow it, viewers see " +
            "where you are to within a few metres. If you don't, they see an approximate " +
            "city-level location from your network address instead — the line says which.\n\n" +
            "Either way it is drawn into the picture itself, along with a UTC clock. Anyone " +
            "watching sees them, and they stay in any recording that is made.\n\n" +
            "They stay inside the encryption: only people holding your link and passcode can " +
            "see them. We never store them."
          )) return;
          stampWarned = true;
          geoStamp = await createGeoStamp();
          comp?.setStampProvider(geoStamp.line);
          // Surface how good the clock is, since the latency reading is only worth this much.
          console.log(`[stamp] on; burned-in clock good to ±${geoStamp.clockUncertaintyMs().toFixed(1)}ms`);
        }
        stampBtn.classList.toggle("toggle-on", !!geoStamp);
      } catch (e) {
        console.error("[stamp] could not start the burn-in:", e);
        geoStamp = null;
        stampBtn.classList.remove("toggle-on");
      } finally {
        stampBusy = false;
      }
    };
    stampBtn.addEventListener("click", () => void toggleStamp());
    advanced(stampBtn);

    // --- Handle watermark ---
    //
    // The broadcaster's own name on their own picture, drawn subtly in the upper left. Unlike
    // the location burn-in this reveals nothing they did not choose to type, so there is no
    // confirmation step — but it lands in the picture just as permanently, and inside the same
    // encryption, so only link+passcode holders see it.
    const HANDLE_KEY = "e2emoq.handle";
    const HANDLE_MAX = 32;
    // Canvas text, not HTML, so there is no markup to escape. Strip control characters anyway:
    // a newline or a bidi override in a handle turns a watermark into a layout weapon.
    const cleanHandle = (raw: string): string =>
      raw.replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028-\u202E]/g, "")
        .replace(/^@+/, "")
        .trim()
        .slice(0, HANDLE_MAX);

    const handleBtn = document.createElement("button");
    handleBtn.type = "button";
    // glyph-btn matches the weight of the 18px icons either side, so "@" reads as one of
    // them rather than as a label. It is a class rather than an inline style so the
    // narrow-phone rules can shrink it with everything else.
    handleBtn.className = "publish-btn toggle-btn glyph-btn";
    handleBtn.id = "handle-btn";
    handleBtn.title = "Watermark — show your handle in the corner of the video";
    handleBtn.innerHTML = faced("@", "Handle");

    handleBtn.addEventListener("click", () => {
      if (watermark) {
        watermark = null;
        comp?.setWatermark(null);
        handleBtn.classList.remove("toggle-on");
        return;
      }
      // Always ask, prefilled with whatever was used last. One Enter to accept, and it is the
      // only discoverable way to change or clear a handle without inventing more UI.
      let stored = "";
      try { stored = localStorage.getItem(HANDLE_KEY) || ""; } catch { /* private mode */ }
      const raw = window.prompt("Your handle — shown in the corner of the video for viewers", stored);
      if (raw == null) return; // cancelled: stay off, keep what was stored
      const clean = cleanHandle(raw);
      if (!clean) {
        // Emptied deliberately — forget it rather than leaving it on the device.
        try { localStorage.removeItem(HANDLE_KEY); } catch { /* private mode */ }
        return;
      }
      try { localStorage.setItem(HANDLE_KEY, clean); } catch { /* private mode */ }
      watermark = `@${clean}`;
      comp?.setWatermark(watermark);
      handleBtn.classList.add("toggle-on");
    });
    advanced(handleBtn);

    // --- Link watermark (QR) ---
    //
    // Same shape as the handle above — click, get asked, it lands in the corner of the picture
    // — but pointing somewhere instead of naming someone. It replaces Extras as the way to put
    // a link in front of an audience, because Extras asked a broadcaster to write HTML and
    // this asks them for a URL.
    //
    // It reaches a viewer by two routes, and it needs both:
    //
    //   1. The QR, drawn into the frame. For someone in the room, or watching on a TV, or on a
    //      second device — they point a phone at it. This is also the copy that survives a
    //      screen recording, and the copy our servers never see, since it is only ever pixels.
    //   2. A tappable link under the video. Someone watching on their phone cannot scan their
    //      own screen, so the QR alone would be useless to exactly the audience most likely to
    //      act on it. That copy travels as text, SEALED under the link key (see linkSeal
    //      below) so that storing it does not hand us the destination.
    const LINK_KEY = "e2emoq.link";
    // Held at version 4 — 33 modules, about 62 bytes at this correction level.
    //
    // The limit is the PICTURE, not the encoder. Modules have to stay at QR_MODULE_MIN_PX or
    // the symbol does not survive being scaled (see the measurements over there), and holding
    // module size fixed means a longer URL can only produce a bigger plate: version 4 already
    // takes up 246 of 1280 pixels across, and version 6 would take 294. Past that the
    // watermark stops being a watermark and starts being a billboard sitting on the shot.
    //
    // So a long URL is declined rather than drawn small. Almost every link people actually put
    // on screen — a shop, a tip jar, a home page — is comfortably inside 62 characters.
    const LINK_MAX_VERSION = 4;

    const normaliseUrl = (raw: string): string | null => {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      // Typing "example.com" is the common case and meaning https:// is unambiguous, so fill
      // it in rather than rejecting.
      const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
      let parsed: URL;
      try {
        parsed = new URL(withScheme);
      } catch {
        return null;
      }
      // http(s) only. A javascript: or data: URL here would end up both in a QR a stranger
      // scans and in an href on the watch page — the second of those is an XSS, and the first
      // is worse for being one nobody can inspect before their phone offers to open it.
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      return parsed.href;
    };

    const linkBtn = document.createElement("button");
    linkBtn.type = "button";
    linkBtn.className = "publish-btn toggle-btn";
    linkBtn.id = "link-btn";
    linkBtn.title = "Link — show a QR code in the corner of the video, and a tappable link below it";
    // A QR at icon scale: three finder squares and a scatter of modules. Drawn rather than
    // rendered as a real QR because at 18px a real one would be an unreadable smudge, and this
    // has to say "QR code" at a glance, which the shape alone does.
    linkBtn.innerHTML = faced(
      '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">' +
      '<path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5z"/>' +
      '<path d="M6 6h2v2H6V6zm10 0h2v2h-2V6zM6 16h2v2H6v-2z"/>' +
      '<path d="M13 13h2v2h-2v-2zm4 0h2v2h-2v-2zm-4 4h2v2h-2v-2zm4 4h2v-2h-2v2zm2-4h2v2h-2v-2zm0 4h-2v2h2v-2z"/>' +
      "</svg>",
      "Link"
    );

    /**
     * Seal the URL for the watch page and save it, or clear it.
     *
     * Failures are logged and swallowed on purpose: the QR is already on screen by the time
     * this runs, so a settings write that does not land costs the tappable copy and nothing
     * else. Taking the watermark back down because a network call failed would be the worse
     * outcome.
     */
    const publishLink = async (url: string | null) => {
      try {
        if (!url) {
          await updateStreamSettings(streamId, { link_enc: "" });
          return;
        }
        // Same secret, salt and passcode as the video, through a different HKDF context — so
        // the link is exactly as reachable as the stream it belongs to, and no more.
        const key = await deriveLinkKey(linkSecret, {
          streamId,
          salt: activeSalt,
          passcode: activePasscode(),
        });
        await updateStreamSettings(streamId, { link_enc: await sealText(key, url) });
      } catch (e) {
        console.warn("[link] the tappable copy was not saved; the QR is unaffected:", e);
      }
    };
    resealLink = () => { if (linkUrl) void publishLink(linkUrl); };

    linkBtn.addEventListener("click", () => {
      if (linkUrl) {
        linkUrl = null;
        linkQr = null;
        comp?.setLinkQr(null);
        linkBtn.classList.remove("toggle-on");
        void publishLink(null);
        return;
      }
      let stored = "";
      try { stored = localStorage.getItem(LINK_KEY) || ""; } catch { /* private mode */ }
      const raw = window.prompt(
        "A link to show your viewers — it appears as a QR code in the corner of the video, and as a tappable link below it",
        stored
      );
      if (raw == null) return; // cancelled: stay off, keep what was stored
      const url = normaliseUrl(raw);
      if (!url) {
        if (raw.trim()) window.alert("That does not look like a web address. Try something like example.com/support");
        else { try { localStorage.removeItem(LINK_KEY); } catch { /* private mode */ } }
        return;
      }
      const matrix = encodeQr(url, { ecl: "M", maxVersion: LINK_MAX_VERSION });
      if (!matrix) {
        // Refusing beats drawing a symbol too dense to scan — see LINK_MAX_VERSION.
        window.alert(
          "That address is too long to show as a QR code people can actually scan.\n\n" +
          "Try one under about 60 characters — a home page, or a short link from your own domain."
        );
        return;
      }
      try { localStorage.setItem(LINK_KEY, url); } catch { /* private mode */ }
      linkUrl = url;
      linkQr = matrix;
      comp?.setLinkQr(matrix);
      linkBtn.classList.add("toggle-on");
      void publishLink(url);
    });
    advanced(linkBtn);

    // --- Live chat ---
    //
    // This was a checkbox up in the stream header, next to the id and the passcode, which put
    // it among the properties of the LINK — things a viewer has to be handed. Chat is not one
    // of those: it is a room the broadcaster opens and closes while live, in the same family
    // as the overlay editor and the capture toggles sitting either side of it here.
    //
    // The state and the open/close work live near the top of this function; this button is
    // only the surface. It registers itself so the settings load can light it up.
    const chatBtnEl = document.createElement("button");
    chatBtnEl.type = "button";
    chatBtnEl.className = "publish-btn toggle-btn";
    chatBtnEl.id = "chat-btn";
    chatBtnEl.title = "Live chat — opens a chat panel for you and everyone watching";
    chatBtnEl.innerHTML = faced(
      '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">' +
      '<path d="M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>' +
      "</svg>",
      "Chat"
    );
    chatBtnEl.addEventListener("click", () => void setChatEnabled(!chatEnabled));
    chatBtn = chatBtnEl;
    chatBtn.classList.toggle("toggle-on", chatEnabled);   // settings may have landed first
    advanced(chatBtnEl);

    // No Stop button. It set all three capture flags false and called applyState(), which is
    // the same "nothing active" branch that turning off your last input already reaches — so
    // it was a second way to do what the toggles do, sitting in a row that had grown to eight
    // controls. Every input here is a toggle; switching one off is how it stops, and the
    // broadcast ends when the last one does.
    //
    // What it cost to remove: one click instead of two or three when several inputs are live.
    // That is a smaller price than an eighth button whose relationship to the other seven has
    // to be worked out.
    syncButtons();

    // Place the control bar directly after the <moq-publish> element, and the More panel
    // directly after the bar — it opens downward, into the space above the passcode row,
    // rather than floating over the video the broadcaster is trying to watch.
    publisher.insertAdjacentElement("afterend", bar);
    bar.insertAdjacentElement("afterend", morePanel);
    morePanel.insertAdjacentElement("afterend", notice);

    // --- Status indicator (display only; go-live logging is handled by goLive) ---
    const refreshStatus = () => {
      const conn = publisher.connection?.status?.peek?.() ?? "disconnected";
      // anyActive covers PiP too (where state.source is undefined by design).
      const hasSource = anyActive || !!publisher.state?.source?.peek?.();
      let emoji = "⚪";
      let text = "Offline";
      if (conn === "connected" && hasSource) {
        emoji = "🟢"; text = "Live";
      } else if (conn === "connecting") {
        emoji = "🟡"; text = "Connecting";
      } else if (conn === "connected" && !hasSource) {
        emoji = "🟡"; text = "Select Device";
      }
      statusEl.textContent = emoji;
      statusEl.setAttribute("data-status-text", text);
    };
    try {
      publisher.connection?.status?.subscribe?.(refreshStatus);
      publisher.state?.source?.subscribe?.(refreshStatus);
    } catch (err) {
      console.warn("Could not subscribe to publish status signals:", err);
    }
    refreshStatus();

    // Log end on page unload.
    //
    // pagehide is the load-bearing one: mobile Safari fires it on background/close where
    // beforeunload is simply never delivered, and this is the exact reasoning the watch
    // session path already carries a few hundred lines down. A missed end here is worse than
    // a miscounted session — it leaves the row open and locks this stream id out of its own
    // next go-live with a 409. beforeunload stays as desktop belt-and-braces; logBroadcastEnd
    // is idempotent, so both firing is fine.
    const endOnUnload = () => {
      if (broadcastEventId) logBroadcastEnd(broadcastEventId);
    };
    window.addEventListener("pagehide", endOnUnload);
    window.addEventListener("beforeunload", endOnUnload);

    // --- HTML overlay editor (broadcaster-authored HTML shown to viewers) ---
    const overlayBtn = document.createElement("button");
    overlayBtn.type = "button";
    overlayBtn.title = "Extras — a promo, a poll, links or notes shown below the video for viewers";
    overlayBtn.className = "publish-btn html-overlay-btn";
    overlayBtn.innerHTML = faced("&lt;/&gt;", "Extras");
    // Built here, but it belongs with the other two overlay controls rather than tacked on
    // past Chat — so it is inserted into the group instead of appended to the end.
    //
    // On the name. Not "Code": this page already has a Passcode, and a second thing called a
    // code reads as related to it. Not "Overlay" either, which was the first attempt — that is
    // our word for the mechanism, and it is wrong twice over, because this renders in a block
    // BELOW the video rather than over anything. What a broadcaster is actually doing is
    // adding something alongside the stream: a product promo, a poll widget, a couple of
    // links. "Extras", plural, because the plural reads as a category of optional additions
    // where the singular reads as an adjective missing its noun.
    // Was `bar.insertBefore(overlayBtn, chatBtnEl)`, to keep it beside the other two overlay
    // controls. That would now THROW: Chat is an advanced control and has already moved into
    // the More panel, so it is not a child of the bar to insert against any more. Order inside
    // the panel is registration order, and registering here puts Extras exactly where that
    // insert was reaching for.
    advanced(overlayBtn);

    const overlayContainer = document.createElement("div");
    overlayContainer.className = "html-overlay-container";
    overlayContainer.innerHTML = `
      <div class="html-overlay-input" contenteditable="true"></div>
      <div class="html-overlay-hint">Shown below the video for everyone watching. Headings, lists, tables, links, images and embeds from other sites all work.</div>
      <div class="html-overlay-warning hidden"></div>
      <div class="html-overlay-preview-label hidden">Preview — this is exactly what viewers get</div>
      <div class="html-overlay-preview hidden"></div>
    `;
    const section = document.querySelector("#broadcast-view section");
    if (section && section.parentNode) {
      section.parentNode.insertBefore(overlayContainer, section.nextSibling);
    }

    const overlayInput = overlayContainer.querySelector(".html-overlay-input") as HTMLDivElement;
    const overlayPreview = overlayContainer.querySelector(".html-overlay-preview") as HTMLDivElement;
    const overlayPreviewLabel = overlayContainer.querySelector(".html-overlay-preview-label") as HTMLDivElement;
    const overlayWarning = overlayContainer.querySelector(".html-overlay-warning") as HTMLDivElement;
    let saveTimeout: number | null = null;

    // Preview through the same sanitiser the viewer uses, and say plainly when something was
    // dropped. Silent stripping is what made the old, much tighter allowlist read as a bug:
    // a heading came out as unstyled text and nothing anywhere said why.
    const refreshPreview = (raw: string) => {
      const source = raw.trim();
      if (!source) {
        overlayPreview.innerHTML = "";
        overlayPreview.classList.add("hidden");
        overlayPreviewLabel.classList.add("hidden");
        overlayWarning.classList.add("hidden");
        return;
      }
      const { html, removed } = renderOverlay(source);
      overlayPreview.innerHTML = html;
      overlayPreview.classList.remove("hidden");
      overlayPreviewLabel.classList.remove("hidden");
      if (removed.length) {
        // textContent, not innerHTML — this string is built from the broadcaster's own markup.
        overlayWarning.textContent = `Removed, because it could run code in a viewer's browser: ${removed.join(", ")}`;
        overlayWarning.classList.remove("hidden");
      } else {
        overlayWarning.classList.add("hidden");
      }
    };

    // Load existing overlay content
    getStreamSettings(streamId).then((settings) => {
      if (settings.overlay_html) {
        overlayInput.textContent = settings.overlay_html;
        overlayBtn.classList.add("active");
        refreshPreview(settings.overlay_html);
      }
    });

    // Save overlay content with debounce
    overlayInput.addEventListener("input", () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = window.setTimeout(() => {
        const content = overlayInput.textContent || "";
        updateStreamSettings(streamId, { overlay_html: content });
        overlayBtn.classList.toggle("active", !!content.trim());
        refreshPreview(content);
      }, 500);
    });

    // Toggle overlay input visibility
    overlayBtn.addEventListener("click", () => {
      overlayContainer.classList.toggle("visible");
      if (overlayContainer.classList.contains("visible")) {
        overlayInput.focus();
      }
    });
  }
}

// Show login required overlay for watch
/**
 * A share link whose `#k=` fragment is missing or was stripped. Common causes: the link was
 * re-typed, passed through something that drops fragments, or only the stream id was shared.
 * Nothing here can be fixed by signing in — without the fragment the stream is undecryptable
 * by anyone, us included, so the only remedy is to obtain the complete link.
 */
function showWatchKeyMissing() {
  const section = document.getElementById("watch-view")?.querySelector("section");
  if (!section) return;
  section.innerHTML = `
    <div class="login-required">
      <h2>This link is missing its key</h2>
      <p>
        e2eMoQ streams are encrypted in the broadcaster's browser, and the key to decrypt
        one travels only in the part of the link after the <code>#</code>. This link does not
        carry it, so the stream cannot be played.
      </p>
      <p>Ask the broadcaster for the complete link — and take care to copy all of it.</p>
    </div>`;
}

/**
 * Ask for the passcode the broadcaster sent by another channel. Resolves with what was
 * typed; nothing validates it here, because nothing can — the value is mixed into key
 * derivation and a wrong one just yields a key that does not decrypt. No request is made,
 * so no server learns that a guess happened, or whether it was right.
 */
import { fetchPublishCode } from "./publish-code";

/**
 * Ask for the publish code. This is the admission credential, not a password: there is one
 * shared value, it identifies nobody, and it is remembered per device so it is entered once.
 * It exists so bandwidth billed to our CDN tenant — and the overlay HTML that runs in every
 * viewer's browser — are not open to anonymous strangers.
 *
 * TWO THINGS CHANGED HERE, both from watching a first broadcast on a fresh browser.
 *
 * 1. Getting one is now a BUTTON, not a second page. It used to send people to /request:
 *    read a prompt, click through, read three sections, press a button, wait, copy a string,
 *    navigate back, paste it. Eight steps, every one mechanical, not one of them asking the
 *    person anything. The browser can do all of it — see src/publish-code.ts, and the timings
 *    there for why a puzzle that takes half a second does not deserve a page. /request stays
 *    for the thing this cannot do: putting a code on a DIFFERENT device.
 *
 * 2. It says "code" throughout. This screen used to say "key" while the page it linked to said
 *    "code", for one object — and worse, "key" is what /trust calls the ENCRYPTION key, which
 *    is a different thing entirely and the one that actually matters. One word, and not that
 *    one.
 *
 * The reassurance moved into a disclosure. Three paragraphs of "this is not an account, we do
 * not know you" comfort someone who arrived worried; someone who only wants to go live reads
 * the same words as complexity. They are all still here, in full, one click away.
 */
function promptPublishKey(): Promise<string | null> {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;" +
    "background:rgba(0,0,0,0.85);backdrop-filter:blur(2px);padding:20px;overflow:auto;";
  overlay.innerHTML = `
    <div style="max-width:27em;text-align:center;color:#e5e5e5;">
      <h2 style="margin:0 0 10px;font-size:1.25rem;">A publish code is needed</h2>
      <p style="margin:0 0 18px;color:#a3a3a3;line-height:1.5;">
        Broadcasting needs a code. It is not an account &mdash; no name, no email, no
        password &mdash; and this device will remember it.
      </p>

      <button id="pk-get"
              style="padding:11px 22px;border-radius:4px;border:0;background:#33ddc0;
                     color:#0a0a0a;font:inherit;font-size:1rem;font-weight:600;cursor:pointer;">
        Get a code
      </button>
      <p id="pk-status" style="display:none;margin:12px 0 0;color:#a3a3a3;font-size:0.9rem;"></p>
      <p id="pk-error" style="display:none;margin:12px 0 0;color:#e0a3a3;font-size:0.9rem;
                              line-height:1.45;"></p>

      <p style="margin:20px 0 10px;color:#6b6b6b;font-size:0.8rem;">
        or paste one you already have
      </p>
      <div style="display:flex;gap:8px;justify-content:center;">
        <input id="publish-key-entry" type="password" autocomplete="off" spellcheck="false"
               placeholder="publish code"
               style="padding:9px 12px;font-family:ui-monospace,monospace;width:14em;
                      border-radius:4px;border:1px solid #4a4a4a;background:#1a1a1a;color:#e5e5e5;">
        <button id="publish-key-go"
                style="padding:9px 16px;border-radius:4px;border:1px solid #4a4a4a;
                       background:transparent;color:#e5e5e5;font:inherit;cursor:pointer;">Use it</button>
      </div>

      <details style="margin-top:22px;text-align:left;">
        <summary style="cursor:pointer;color:#737373;font-size:0.875rem;">
          What this is, and what it isn't
        </summary>
        <div style="margin-top:10px;color:#8a8a8a;font-size:0.85rem;line-height:1.6;">
          <p style="margin:0 0 10px;">
            It admits you to broadcast. It does not decrypt anything: your stream is encrypted
            in your own browser with a key that lives only in the link you share, which never
            reaches us. A code being shared, stolen or expired changes nothing about who can
            watch your stream.
          </p>
          <p style="margin:0 0 10px;">
            We do not store it, so there is no record connecting you to anything you broadcast.
            Cloudflare, which serves this page, does see the IP address you connect from
            &mdash; here and again when you broadcast. If that matters to you, use a VPN or Tor
            for both. We would rather tell you that than imply a protection we cannot provide.
          </p>
          <p style="margin:0 0 10px;">
            Getting one spends a moment of your browser's time on a small puzzle. That is only
            there to stop scripts requesting thousands; it tests nothing about you.
          </p>
          <p style="margin:0;">
            Need a code on a different device?
            <a href="/request" style="color:#33ddc0;">Request one there</a>.
          </p>
        </div>
      </details>
    </div>`;
  document.body.appendChild(overlay);

  return new Promise((resolve) => {
    const input = overlay.querySelector("#publish-key-entry") as HTMLInputElement | null;
    const getBtn = overlay.querySelector("#pk-get") as HTMLButtonElement | null;
    const statusEl = overlay.querySelector("#pk-status") as HTMLElement | null;
    const errorEl = overlay.querySelector("#pk-error") as HTMLElement | null;

    const submit = () => {
      const v = input?.value.trim();
      if (!v) return;
      overlay.remove();
      resolve(v);
    };
    overlay.querySelector("#publish-key-go")?.addEventListener("click", submit);
    input?.addEventListener("keypress", (e) => {
      if ((e as KeyboardEvent).key === "Enter") submit();
    });

    getBtn?.addEventListener("click", async () => {
      getBtn.disabled = true;
      getBtn.style.opacity = "0.6";
      if (errorEl) errorEl.style.display = "none";
      if (statusEl) { statusEl.style.display = "block"; statusEl.textContent = "Working…"; }

      // The ellipsis is driven by real attempts rather than a timer, so it stops moving if the
      // search stalls. Throttled: at desktop speed the callback fires every couple of
      // milliseconds and an unthrottled update is a flicker, not an animation.
      let dots = 0;
      let last = 0;

      try {
        const got = await fetchPublishCode(() => {
          const now = performance.now();
          if (now - last < 120) return;
          last = now;
          dots = (dots + 1) % 4;
          if (statusEl) statusEl.textContent = "Working" + ".".repeat(dots);
        });

        // A code that is not active yet would fail at go-live with nothing to explain it, so
        // hand it over visibly instead of silently proceeding. Only reachable when
        // PUBLISH_CODE_DELAY_HOURS is raised above zero.
        if (!got.activeImmediately) {
          if (input) input.value = got.code;
          if (input) input.type = "text";
          if (statusEl) statusEl.style.display = "none";
          if (errorEl) {
            const when = got.activeAt ? new Date(got.activeAt).toLocaleString() : "later";
            errorEl.textContent =
              `Your code is ready, but it does not start working until ${when}. ` +
              `It is filled in below — save it, and come back then.`;
            errorEl.style.display = "block";
          }
          getBtn.disabled = false;
          getBtn.style.opacity = "1";
          return;
        }

        overlay.remove();
        resolve(got.code);
      } catch (e) {
        if (statusEl) statusEl.style.display = "none";
        if (errorEl) {
          errorEl.textContent = `${(e as Error).message}. You can paste a code instead.`;
          errorEl.style.display = "block";
        }
        getBtn.disabled = false;
        getBtn.style.opacity = "1";
      }
    });

    getBtn?.focus();
  });
}

/**
 * `first`   — we know from the link that a passcode is needed and have not asked yet.
 * `wrong`   — nothing has ever decrypted, so what they typed is not the passcode.
 * `rotated` — frames WERE decrypting and then stopped, which only happens when the
 *             broadcaster cycled the passcode mid-stream. Saying "didn't work" there blames
 *             the viewer for something that happened at the other end.
 * `added`   — nothing has ever decrypted AND the link never claimed a passcode, so this
 *             viewer has not mistyped anything: they were sent a link from before the
 *             broadcaster switched one on. "That passcode didn't work" would accuse them of
 *             an error they did not make.
 */
type PasscodeAsk = "first" | "wrong" | "rotated" | "added";

function promptPasscode(ask: PasscodeAsk = "first"): Promise<string | null> {
  const TITLE: Record<PasscodeAsk, string> = {
    first: "This stream needs a passcode",
    wrong: "That passcode didn't work",
    rotated: "The broadcaster changed the passcode",
    added: "This stream now needs a passcode",
  };
  const BODY: Record<PasscodeAsk, string> = {
    first: "The broadcaster set a passcode and sent it to you separately from this link.",
    wrong: "The stream is playing, but not with that passcode. Check it and try again.",
    rotated: "This stream re-keyed while you were watching. Enter the new passcode to carry on.",
    added: "Your link is from before the broadcaster added one. Ask them for it to carry on.",
  };
  // Overlay, NOT a replacement for the section's contents. Rewriting the section's innerHTML
  // destroys the <moq-watch> element the player lives in, so the stream can never render
  // afterwards however correct the passcode is.
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;" +
    "background:rgba(0,0,0,0.82);backdrop-filter:blur(2px);padding:20px;";
  overlay.innerHTML = `
    <div style="max-width:26em;text-align:center;color:#e5e5e5;">
      <h2 style="margin:0 0 10px;font-size:1.25rem;">${TITLE[ask]}</h2>
      <p style="margin:0 0 16px;color:#a3a3a3;line-height:1.5;">${BODY[ask]}</p>
      <div style="display:flex;gap:8px;justify-content:center;">
        <input id="passcode-entry" type="text" autocomplete="off" autocapitalize="characters"
               spellcheck="false" placeholder="passcode"
               style="padding:9px 12px;font-family:ui-monospace,monospace;font-size:1.05rem;
                      letter-spacing:0.12em;text-transform:uppercase;width:11em;border-radius:4px;
                      border:1px solid #4a4a4a;background:#1a1a1a;color:#e5e5e5;">
        <button id="passcode-go"
                style="padding:9px 18px;border-radius:4px;border:0;background:#33ddc0;
                       color:#0a0a0a;font:inherit;font-weight:600;cursor:pointer;">Watch</button>
      </div>
      <button id="passcode-skip"
              style="margin-top:14px;background:none;border:0;color:#8a8a8a;font:inherit;
                     font-size:0.88rem;text-decoration:underline;cursor:pointer;">I wasn't given
        a passcode</button>
    </div>`;
  document.body.appendChild(overlay);

  return new Promise((resolve) => {
    const input = overlay.querySelector("#passcode-entry") as HTMLInputElement | null;
    const submit = () => {
      const v = input?.value.trim().toUpperCase();
      if (!v) return;
      overlay.remove();
      resolve(v);
    };
    overlay.querySelector("#passcode-go")?.addEventListener("click", submit);
    // Dismissal resolves null, and the CALLER decides what that means. This exists because a
    // broadcaster can now turn the passcode off, which leaves links that still carry `p=1`
    // pointing at a stream that no longer needs one: without a way out, those viewers are
    // asked for a passcode that does not exist and no answer can ever be right.
    overlay.querySelector("#passcode-skip")?.addEventListener("click", () => {
      overlay.remove();
      resolve(null);
    });
    input?.addEventListener("keypress", (e) => {
      if ((e as KeyboardEvent).key === "Enter") submit();
    });
    input?.focus();
  });
}

// ── Reacting to a kill ────────────────────────────────────────────────────────────────
// Kill is enforced server-side at /route and at go-live, but both are request-time checks and
// an established session makes no further requests. Measured, not assumed: after a kill a
// viewer kept decoding fresh frames for a full minute and the publisher kept sending, and
// both would have continued until something made them reconnect
// (scripts/e2e/kill-live-viewer.mjs). Terminating a live broadcast therefore needs the
// clients to notice, which they do via the `killed` flag on the settings poll they already run.
//
// This is cooperative: a modified client can ignore it. That is an acceptable limit, because
// a modified client can also just record the stream — this closes the gap for the honest
// clients that every real viewer is actually running, and nothing more is claimed for it.

/**
 * Stop everything and say why. Replacing the section's contents is correct HERE — unlike the
 * passcode prompt, which must not — because tearing down <moq-watch> is exactly the goal: it
 * is what actually ends the media session rather than merely hiding it.
 */
function stopForKill(role: "viewer" | "broadcaster"): void {
  const watcher = document.querySelector("moq-watch");
  if (watcher) {
    watcher.removeAttribute("url");
    watcher.remove();
  }

  const publisher = document.querySelector("moq-publish") as (MoqPublishElement & { source?: unknown }) | null;
  if (publisher) {
    publisher.removeAttribute("url");
    try {
      publisher.announce = false;
      publisher.source = null;
    } catch {
      // Older element builds expose these differently; removing the URL above is what stops
      // the connection, and the rest is best-effort tidying.
    }
    publisher.remove();
  }

  // Release the camera and microphone. Leaving the capture light on after a broadcast has
  // been terminated would be its own small betrayal.
  for (const el of document.querySelectorAll("video")) {
    const stream = (el as HTMLVideoElement).srcObject as MediaStream | null;
    stream?.getTracks?.().forEach((t) => t.stop());
    (el as HTMLVideoElement).srcObject = null;
  }

  const section =
    document.querySelector("#watch-view section") ??
    document.querySelector("#broadcast-view section") ??
    document.body;

  const panel = document.createElement("div");
  panel.className = "login-required";
  panel.style.cssText = "text-align:center;padding:2.5rem 1.5rem;max-width:34em;margin:0 auto;";
  const heading = document.createElement("h2");
  heading.textContent = "This stream has been terminated";
  const body = document.createElement("p");
  body.style.cssText = "color:#a3a3a3;line-height:1.55;";
  body.textContent =
    role === "broadcaster"
      ? "An operator stopped this broadcast. Publishing has ended and your camera and microphone have been released. Nothing that was already sent can be recalled, and nobody here can play it back."
      : "An operator stopped this broadcast in response to a report. Playback has ended.";
  panel.append(heading, body);
  section.replaceChildren(panel);
}

function showWatchLoginRequired() {
  const watchView = document.getElementById("watch-view");
  if (!watchView) return;

  const section = watchView.querySelector("section");
  if (!section) return;

  section.innerHTML = `
    <div class="login-required">
      <h2>Sign in Required</h2>
      <p>The broadcaster requires viewers to sign in to watch this stream.</p>
      <div class="auth-buttons">
        <button id="watch-login-google" class="btn btn-google">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Google
        </button>
      </div>
    </div>
  `;

  document.getElementById("watch-login-google")?.addEventListener("click", loginWithGoogle);
}

// Initialize watch view
// Mode C (Enterprise): turn an enterprise route into a connectable QUIC endpoint via the
// autoscaler's proven two-step /assign flow — run from the BROWSER because only it can
// reach the PRIVATE on-net relay. Step 1: tell the local relay to pull the broadcast from
// the remote edge (origin) using the cluster pull pass; it replies "host:port". Step 2 is
// the returned URL: connect there with the watchToken and subscribe to <broadcast>.
// C1 contract: auth is the BYOK watch token as a `jwt=` QUERY PARAM (not an Authorization
// header — a header would trigger a CORS preflight on this cross-origin call; a query param
// doesn't). The edge resolves the tenant by the token's kid, validates it against this
// tenant's verify_jwk, and requires a valid subscribe <broadcast> scope. No provisioning
// bearer ever enters the browser → relay-blind preserved. `origin`/`pull` are added ONLY for
// cross-pull (edge pulls the broadcast from the publisher's origin relay); in standalone mode
// the worker omits edgeHost/pullToken because the publisher is already on the edge. The
// response body is the EDGE's media endpoint "host:port" as plain text (some builds wrap it as
// JSON {relay}, so we accept both). The browser MUST dial that returned value (NOT `origin`,
// which is only the upstream the edge pulls from). The same watch token then drives the QUIC
// connect. Returns null on any failure → caller falls to B/A.
async function resolveEnterpriseConnectUrl(route: StreamRoute): Promise<string | null> {
  if (!route.broadcast || !route.watchToken) return null;
  try {
    const q = new URLSearchParams({
      broadcast: route.broadcast,
      jwt: route.watchToken, // same watch token used on the QUIC connect step
    });
    if (route.edgeHost) q.set("origin", route.edgeHost); // cross-pull only (upstream, not dialed)
    if (route.pullToken) q.set("pull", route.pullToken); // cross-pull only
    // Transport hint from the viewer URL (?xport=): forwarded verbatim to the edge's /assign.
    // Not secret and not part of any token, so read it straight from the page URL rather than
    // threading it through the route resolver. xport=iroh makes the edge pull from the origin
    // over iroh/DHT; any other value or absent leaves today's host:port behavior unchanged.
    const xport = new URLSearchParams(location.search).get("xport");
    if (xport) q.set("xport", xport);
    const res = await fetch(`https://${route.relay}/assign?${q.toString()}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = (await res.text()).trim();
    if (!body) return null;
    // Plain "host:port" or JSON {relay:"host:port"} (mirrors the Worker's dual-mode /assign parse).
    let hostPort = body;
    if (body.startsWith("{")) {
      try {
        hostPort = String((JSON.parse(body) as { relay?: string }).relay ?? "").trim();
      } catch {
        return null;
      }
    }
    if (!hostPort) return null;
    return `https://${hostPort}/?jwt=${route.watchToken}`;
  } catch (e) {
    console.warn("[route] enterprise /assign preflight failed", e);
    return null;
  }
}

// Mode C fallback: reload forcing ?noEnterprise=1 so the Worker skips Mode C and returns
// B/A — the viewer always ends up watching even when the private relay is unreachable.
function forceBAFallback(): void {
  const u = new URL(window.location.href);
  u.searchParams.set("noEnterprise", "1");
  window.location.replace(u.toString());
}

// Promotional landing page (bare "/"). The content is static HTML in index.html; this
// just reveals the section. The Broadcast / Watch entry points are plain links to
// /broadcast and /watch (see getRouteInfo).
function initLandingView() {
  document.getElementById("landing-view")?.classList.remove("hidden");
  // The byline is redundant on the promo page (the hero says the same thing); hide it
  // here only — it stays in the header on the broadcast and watch pages.
  document.getElementById("site-tagline")?.classList.add("hidden");
  // The footer used to be hidden here, on the reasoning that MoQ | TinyMoQ | Browser Support
  // | Server Status were operator-ish links with no place on a promo page. That reasoning
  // expired when "How it works" moved into it: hiding the footer would leave a first-time
  // visitor with no way to read the one explanation this product is actually selling.
  document.querySelector("footer")?.classList.remove("hidden");
  // Server Status is meaningless here — no relay has been assigned, so the panel can only
  // report a placeholder, and it previously reported a fleet host this client never contacts.
  // It belongs on the pages where a connection actually exists.
  // Nothing else is in this row now, so the whole <p> goes: on the landing page there is no
  // connection, and a status that invented one would be worse than no status.
  document.getElementById("server-status-item")?.classList.add("hidden");
}

async function initWatchView(streamId: string, user: User | null) {
  // The ".hang" suffix makes the catalog format explicit so the watcher can parse
  // the catalog and subscribe to video/audio tracks (otherwise detectFormat() is
  // undefined and the viewer only fetches catalog.json, never video/hd).
  const streamName = `${NAMESPACE_PREFIX}/${streamId}.hang`;

  console.log(`MoQplay Watch - Stream: ${streamId}`);

  // Link secret and passcode, populated once the encryption block below runs. Declared here
  // because the chat panel is created earlier in this function and derives its key lazily
  // from whatever these hold at the moment a message is sent or received.
  let watchLinkSecret = "";
  let watchPasscode: string | undefined;
  // Whether the LINK said a passcode was needed. Not the same as whether one is actually
  // required now -- the broadcaster may have switched it on or off since this link was sent --
  // which is exactly why the failure path below distinguishes "wrong" from "added".
  let watchLinkClaimedPasscode = false;
  let watchSalt: string | undefined;

  /**
   * Forget which sealed Link blob was last decoded, so the next settings poll tries again.
   *
   * Needed because the Link is keyed on the passcode. A viewer who arrives without one gets
   * an unopenable blob, and once they enter the right passcode nothing else would prompt a
   * retry — the stored value has not changed, so the "unchanged, skip the crypto" fast path
   * would keep the link hidden for as long as they watched. Installed with the watch link
   * below; a no-op until then.
   */
  let retryWatchLink: () => void = () => {};

  // Show watch view, hide broadcast view
  document.getElementById("watch-view")?.classList.remove("hidden");
  document.getElementById("broadcast-view")?.classList.add("hidden");

  // Hide the New Stream button on watch page
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) {
    newStreamBtn.classList.add("hidden");
  }

  // Check if stream requires auth
  const settings = await getStreamSettings(streamId);
  if (settings.require_auth && !user) {
    showWatchLoginRequired();
    return;
  }

  // Live chat for viewers, when the broadcaster enabled it (right column on desktop,
  // bottom overlay on mobile). The WS is also gated server-side on chat_enabled.
  // Kept as open/close helpers so the settings poll below can react to the broadcaster
  // toggling chat mid-stream (mirrors the broadcaster's own openChat/closeChat).
  const watchChatPanel = document.getElementById("watch-chat") as HTMLElement | null;
  let watchChatHandle: ChatHandle | null = null;
  const openWatchChat = () => {
    if (!watchChatPanel || watchChatHandle) return;
    watchChatPanel.classList.remove("hidden");
    watchChatHandle = initChat({
      streamId,
      container: watchChatPanel,
      user,
      chatKey: () => deriveChatKey(watchLinkSecret, { streamId, salt: watchSalt, passcode: watchPasscode }),
    });
  };
  const closeWatchChat = () => {
    watchChatHandle?.destroy();
    watchChatHandle = null;
    watchChatPanel?.classList.add("hidden");
  };
  if (settings.chat_enabled) openWatchChat();

  // Set stream name on watcher (headless <moq-watch> core element)
  const watcher = document.querySelector("moq-watch") as MoqWatchElement | null;
  if (watcher) {
    // --- TEMP timing probe: localize viewer join latency by phase ---
    const t0 = performance.now();
    const ms = () => `${Math.round(performance.now() - t0)}ms`;
    // Strongest "we're actually playing" signal — the Mode-C fallback watchdog reads it.
    let gotFirstFrame = false;
    const wDiag = watcher as unknown as {
      connection?: { status?: { subscribe?: (fn: (s: string) => void) => void } };
      broadcast?: { catalog?: { subscribe?: (fn: (c: unknown) => void) => void } };
    };
    try {
      wDiag.connection?.status?.subscribe?.((s) => console.log(`[watch-timing] connection ${s} @ ${ms()}`));
      let gotCatalog = false;
      wDiag.broadcast?.catalog?.subscribe?.((c) => {
        if (c && !gotCatalog) { gotCatalog = true; console.log(`[watch-timing] catalog received @ ${ms()}`); }
      });
    } catch { /* ignore */ }

    // --- Time to first frame ---
    // The renderer draws decoded frames to the <canvas> 2D context via drawImage
    // (black background uses fillRect, so drawImage = a real video frame). Hook it
    // once to capture time-to-first-frame from page load and show it in the footer.
    const canvas = watcher.querySelector("canvas") as HTMLCanvasElement | null;
    const ctx = canvas?.getContext("2d");
    if (ctx) {
      const origDrawImage = ctx.drawImage as (...a: unknown[]) => unknown;
      (ctx as unknown as { drawImage: unknown }).drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        const result = origDrawImage.apply(this, args);
        // First real frame: report, then restore the prototype method (no per-frame overhead).
        delete (ctx as unknown as { drawImage?: unknown }).drawImage;
        gotFirstFrame = true;
        const sinceLoad = performance.now(); // ms since page navigation start
        // Console only. This used to print into the footer beside the nav links, where it read
        // as a permanent status field on a page that is otherwise a player — the number is
        // diagnostic, and diagnostics do not belong in a viewer's chrome.
        console.log(`[watch-timing] FIRST FRAME painted @ ${ms()} (from page load: ${Math.round(sinceLoad)}ms)`);
        return result;
      };
    }

    // Co-locate on the publisher's relay: look up the broadcast→relay route.
    // Relays are islands, so the viewer MUST use the same relay as the broadcaster.
    // Falls back to the static relay if the stream isn't routed yet / lookup fails.
    const viewerCdn = getCdnOverride("viewer-cdn");
    // Optional forced cross-cluster origin (publisher relay host:port) for testing;
    // normally the Worker derives it from the publisher's stored relay in D1.
    const originOverride = new URLSearchParams(window.location.search).get("origin")?.trim() || undefined;
    if (viewerCdn) console.log("[routing] viewer CDN override:", viewerCdn, originOverride ? `(forced origin ${originOverride})` : "");

    // Resolve the relay via /route. There is NO static relay to fall back to — every
    // connection must use the dynamic host:port from the directory. If the broadcast
    // isn't live yet (404), poll until it is, showing a "waiting" state. Connect once.
    // After a failed enterprise (Mode C) attempt we reload with ?noEnterprise=1 so the
    // Worker skips Mode C and returns B/A — guaranteeing the viewer ends up watching.
    const noEnterprise = new URLSearchParams(window.location.search).get("noEnterprise") === "1";

    // Prove we hold the share link before asking for a token. Derived here, ahead of the
    // route call, because every /route request needs it — the first one, the offline polling
    // loop, and each token renewal. A viewer without a fragment simply has no tag and gets
    // "offline", which is the correct answer for someone who was never given the link.
    const routeTag = await (async () => {
      const secret = new URLSearchParams(location.hash.replace(/^#/, "")).get("k");
      return secret ? deriveRouteTag(secret, streamId) : undefined;
    })();

    let routeInfo = await getStreamRoute(streamId, viewerCdn, originOverride, { noEnterprise, routeTag });
    console.log(`[watch-timing] route resolved @ ${ms()} ->`, routeInfo?.relay ?? "(offline, polling)", routeInfo?.mode ? `(mode=${routeInfo.mode})` : "");

    if (!routeInfo) {
      const section = document.querySelector("#watch-view section");
      const waitingEl = document.createElement("div");
      waitingEl.className = "watch-waiting";
      waitingEl.textContent = "Waiting for broadcaster…";
      waitingEl.style.cssText = "text-align:center;padding:1.5rem;color:var(--text-muted);";
      section?.appendChild(waitingEl);

      let stopped = false;
      window.addEventListener("beforeunload", () => { stopped = true; });
      while (!routeInfo && !stopped) {
        await new Promise((r) => setTimeout(r, 1500));
        routeInfo = await getStreamRoute(streamId, viewerCdn, originOverride, { noEnterprise, routeTag });
      }
      waitingEl.remove();
      if (stopped) return;
      console.log(`[watch-timing] route became available @ ${ms()} ->`, routeInfo?.relay);
    }

    if (!routeInfo) return; // stopped before a route resolved
    // Relay-blind E2E: if the stream is encrypted, arm decryption and install the
    // content key BEFORE connecting. If the key was withheld (auth-gated stream,
    // viewer not signed in) we can't decrypt — surface the sign-in requirement.
    // The content key is per-broadcast and relay-independent, so it survives any
    // later relay change in the refresh loop without re-fetching.
    if (routeInfo.encrypted) {
      // The key comes from OUR OWN URL fragment, never from the server response. The Worker
      // has no content key to withhold or release, so this is not an access-control check —
      // possessing the complete link simply is the ability to decrypt.
      const frag = new URLSearchParams(location.hash.replace(/^#/, ""));
      const linkSecret = frag.get("k");
      watchLinkSecret = linkSecret ?? "";
      if (!linkSecret) {
        console.warn("[crypto] share link carries no #k= secret; the stream cannot be decrypted");
        showWatchKeyMissing();
        return;
      }
      // `p=1` means the broadcaster mixed a passcode in. Ask before connecting so the key is
      // complete when the first frame arrives.
      let passcode: string | undefined;
      watchLinkClaimedPasscode = frag.get("p") === "1";
      if (watchLinkClaimedPasscode) {
        const entered = await promptPasscode();
        // Dismissing carries on with the link alone rather than abandoning the watch. If the
        // stream really is passcoded the watchdog re-prompts within a couple of seconds; if the
        // broadcaster turned it off after sending this link, playing is the correct outcome.
        if (entered) {
          passcode = entered;
          watchPasscode = entered;
        }
        // A wrong passcode looks exactly like a stalled stream at the pixel level. The
        // stuck-player watchdog further down owns saying so: it polls the decrypt counters, so
        // it can tell a wrong key from a dead decoder and re-prompt without a reload. A
        // one-shot timer here used to do it, and had to go — it fired on a timer rather than on
        // evidence, and would now race the watchdog into a second overlay.
      }
      watchSalt = routeInfo.salt ?? undefined;
      armViewer();
      await deriveMediaKey(linkSecret, { streamId, salt: watchSalt, passcode });

      // Tell the viewer what protects what, where they form the expectation.
      const sec = document.querySelector("#watch-view section") as HTMLElement | null;
      if (sec) {
        if (!sec.style.position) sec.style.position = "relative";
        const overlay = document.createElement("div");
        overlay.className = "watch-badges";
        overlay.style.cssText =
          "position:absolute;top:10px;right:10px;z-index:5;display:flex;align-items:center;" +
          "gap:8px;background:rgba(0,0,0,0.6);border-radius:999px;padding:4px 10px;";
        const rb = createRelayBlindBadge();
        rb.style.border = "none";
        rb.style.padding = "0";
        overlay.append(rb);
        sec.appendChild(overlay);
      }
    }

    if (routeInfo.mode === "enterprise") {
      // Mode C: an ASN match does NOT guarantee the user can actually reach the private
      // relay (VPN off-net, relay down…). Step 1 = /assign preflight to make it pull.
      console.log(`[route] played mode=enterprise relay=${routeInfo.relay} edge=${routeInfo.edgeHost ?? "?"}`);
      const connectUrl = await resolveEnterpriseConnectUrl(routeInfo);
      if (!connectUrl) {
        // Couldn't reach / provision the private relay — fall back to B/A right away.
        console.warn("[route] enterprise relay unreachable (/assign); falling back to B/A");
        forceBAFallback();
        return;
      }
      // Step 2: connect + subscribe. Watchdog still guards the case where /assign
      // succeeded but no frame ever paints (QUIC blocked, pull stalled…).
      setActiveRelay(routeInfo.relay);
      watcher.setAttribute("url", connectUrl);
      watcher.setAttribute("name", routeInfo.broadcast ?? streamName);
      window.setTimeout(() => {
        if (gotFirstFrame) return;
        console.warn("[route] enterprise connected but no frame; falling back to B/A");
        forceBAFallback();
      }, 6000);
    } else {
      // Modes A/B (unchanged): publisher origin relay, or a cross-cluster edge.
      // (Worker logs which of A/B; the player only sees a host:port here.)
      console.log(`[route] played mode=edge/origin relay=${routeInfo.relay}${noEnterprise ? " (enterprise fell back)" : ""}`);
      setActiveRelay(routeInfo.relay);
      if (routeInfo.path) {
        // moq.pro (Mode A): full connect URL + empty name + explicit hang catalog.
        watcher.setAttribute("catalog-format", "hang");
        watcher.setAttribute("name", "");
        watcher.setAttribute("url", moqUrl(routeInfo.relay, routeInfo.path, routeInfo.jwt ?? ""));
      } else {
        watcher.setAttribute("url", `https://${routeInfo.relay}/?jwt=${routeInfo.jwt}`);
        watcher.setAttribute("name", streamName);
      }
      // Cross-cluster (viewer-cdn=): the relay above is an edge that pulls from the origin.
      // Show the confirmed origin<->edge transport (iroh/DHT vs QUIC host:port) as a stats line.
      if (viewerCdn) startOriginLinkProbe(routeInfo.relay, streamId);
    }
    console.log(`[watch-timing] url set, connecting @ ${ms()}`);

    // ── Viewer token renewal: REMOVED ───────────────────────────────────────────────────
    //
    // The viewer token is now issued for its full lifetime and never renewed, so nothing
    // here reconnects and the player is never rebuilt on a timer.
    //
    // What that gave up, stated plainly because trust.html says so: renewal was what made
    // termination enforceable against a client MODIFIED to ignore the kill flag — no renewal,
    // and the relay dropped it within one token lifetime. Modified clients are no longer a
    // supported case, so that bought nothing, while costing every viewer a reconnect every
    // 90 seconds. On Safari/iOS that reconnect rebuilt the AudioContext with no user gesture
    // behind it, so it returned suspended and the stream went silent — five separate attempts
    // to make it survivable failed, three of them by breaking audio outright.
    //
    // Termination still works for every supported client: the settings poll sees `killed`
    // and stops within ~5s with the transport closed (scripts/e2e/kill-transport-close.mjs).

    let live = watcher;

    const isPainting = (el: Element): boolean => {
      const canvas = el.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas || canvas.width < 64) return false;
      const probe = document.createElement("canvas");
      probe.width = 32;
      probe.height = 18;
      const cx = probe.getContext("2d", { willReadFrequently: true });
      if (!cx) return false;
      try { cx.drawImage(canvas, 0, 0, 32, 18); } catch { return false; }
      const d = cx.getImageData(0, 0, 32, 18).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
      return lit > (d.length / 4) * 0.05;
    };

    // A swap has succeeded when media is ARRIVING, which is not the same as a lit canvas.
    // isPainting needs pixels, and an audio-only stream has no video to light them — so judging
    // a rebuild by paint alone makes every audio-only swap report failure, the old element is
    // kept, and the player can never be recovered. Fall back to the audio byte counter.
    const isReceiving = (el: Element): boolean => {
      if (isPainting(el)) return true;
      const bytes = (el as unknown as {
        backend?: { audio?: { stats?: { peek?: () => { bytesReceived?: number } | undefined } } };
      })?.backend?.audio?.stats?.peek?.()?.bytesReceived;
      return typeof bytes === "number" && bytes > 0;
    };

    // Start muted; first click/tap on the player enables audio. Declared before the swap so a
    // replacement element can re-arm it — `live` changes identity, this handler must follow.
    const enableAudio = () => {
      live.muted = false;
      live.removeEventListener("click", enableAudio);
    };
    watcher.addEventListener("click", enableAudio);

    /**
     * Replace the player with a freshly built one pointed at `url`, and only retire the old
     * element once the new one is genuinely painting.
     *
     * This is the ONLY way back from a dead player. <moq-watch> cannot re-subscribe after its
     * track resets, and a WebCodecs decoder that has errored stays closed — so re-pointing the
     * existing element achieves nothing (measured: the picture freezes on its last frame).
     * Used both to renew a token and to recover a decoder killed by undecryptable frames.
     */
    async function swapInPlayer(url: string, why: string): Promise<boolean> {
      const parent = live.parentElement;
      if (!parent) return false;
      const started = performance.now();

      const next = document.createElement("moq-watch");
      next.setAttribute("muted", "");
      next.setAttribute("visible", "always");
      next.setAttribute("catalog-format", "hang");
      next.setAttribute("name", "");
      next.appendChild(document.createElement("canvas"));
      // Stacked underneath rather than hidden: display:none would give the element no layout,
      // and a canvas with no box does not decode.
      next.style.cssText = "position:absolute;inset:0;opacity:0;pointer-events:none;";
      if (!parent.style.position) parent.style.position = "relative";
      parent.appendChild(next);
      next.setAttribute("url", url);

      const deadline = performance.now() + 15000;
      while (performance.now() < deadline) {
        if (isReceiving(next)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!isReceiving(next)) {
        // Keep the old element: a frozen picture beats a black one, and the caller decides
        // whether to try again.
        console.warn(`[${why}] replacement never painted in ${(performance.now() - started).toFixed(0)}ms; keeping the old session`);
        next.remove();
        return false;
      }

      const old = live;
      const wasUnmuted = !old.muted;
      live = next as unknown as typeof watcher;
      next.style.cssText = "";
      // The audio enabler lived on the retired element; without re-arming it, a click after a
      // swap silently stops unmuting the stream.
      live.muted = !wasUnmuted;
      live.addEventListener("click", enableAudio);
      old.remove();
      console.log(`[${why}] swapped in a fresh player in ${(performance.now() - started).toFixed(0)}ms`);

      // The rebuild just created a new AudioContext with no user gesture behind it. On iOS
      // that context is suspended and the viewer has no way back — video returns, sound does
      // not, and tapping the player cannot help because muted is already false. Give it a
      // moment to exist, then offer the restore IF it really did come back suspended.
      //
      // Only when audio was on before the swap: someone watching muted has nothing to restore
      // and should not be shown a button about it.
      if (wasUnmuted) window.setTimeout(offerAudioRestore, 2000);
      return true;
    }

    /**
     * Give a viewer their audio back after the player has been rebuilt.
     *
     * WHY THIS EXISTS, from a measurement rather than a theory. A fresh <moq-watch> builds a
     * fresh AudioContext, and on iOS that context has no transient user gesture behind it, so
     * it starts SUSPENDED — captured on an iPhone as `audio suspended t=0.0` while video flowed
     * normally, t=0.0 being proof the context is new. Tapping the player does nothing there,
     * because enableAudio only sets muted=false and it is already false.
     *
     * This is precisely why scheduled rebuilds were REMOVED from this client in 15941e4: they
     * left iOS viewers permanently silent and, being for token renewal, bought nothing in
     * exchange. Rebuilds are back only because they now prevent a stall that is otherwise
     * unavoidable — and only because this button makes them recoverable. Do not reintroduce a
     * rebuild path on this page without it.
     *
     * Deliberately kept OFF the initial-unmute path. Earlier attempts called resume() from the
     * ordinary player click and BROKE audio at start on Safari. This appears only once a
     * rebuild has actually left the context suspended, so the working path cannot be affected.
     */
    const audioCtxNow = (): AudioContext | undefined =>
      (live as unknown as {
        backend?: { audio?: { context?: { peek?: () => AudioContext | undefined } } };
      })?.backend?.audio?.context?.peek?.();

    let restoreBtn: HTMLButtonElement | null = null;

    const offerAudioRestore = () => {
      const ctx = audioCtxNow();
      if (!ctx || ctx.state === "running") return; // nothing to restore
      if (restoreBtn) return; // already offered

      const host = document.querySelector("#watch-view section") as HTMLElement | null;
      if (!host) return;
      if (!host.style.position) host.style.position = "relative";

      const btn = document.createElement("button");
      restoreBtn = btn;
      btn.type = "button";
      btn.textContent = `🔇 Tap to restore audio (${ctx.state})`;
      btn.style.cssText =
        "position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:20;" +
        "padding:0.7rem 1.3rem;border:0;border-radius:999px;background:#f59e0b;color:#0a0a0a;" +
        "font:inherit;font-weight:700;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,0.4);";

      btn.addEventListener("click", async (e) => {
        e.stopPropagation(); // do not also trigger enableAudio on the player beneath
        const c = audioCtxNow();
        if (!c) { btn.textContent = "no audio context"; return; }
        const before = c.state;
        try {
          await c.resume();
        } catch (err) {
          btn.textContent = `resume refused (${before} -> ${c.state})`;
          console.warn("[audio-restore] resume rejected", err);
          return;
        }
        // Report the honest outcome rather than assuming success.
        console.log(`[audio-restore] resume: ${before} -> ${c.state}`);
        if (c.state === "running") {
          btn.textContent = "✅ audio restored";
          window.setTimeout(() => { btn.remove(); restoreBtn = null; }, 1500);
        } else {
          btn.textContent = `still ${c.state} after resume`;
        }
      });

      host.appendChild(btn);
      console.log(`[audio-restore] offering restore; context is ${ctx.state}`);
    };

    // --- Bare mode: add ?bare=1 to the watch URL ---------------------------------------------
    //
    // Turns OFF every background loop this page runs, leaving nothing but connect-and-play.
    // It exists to answer one question that repeated fixes could not: is the stalling caused
    // by OUR JavaScript, or by the transport underneath it?
    //
    // Disabled in bare mode:
    //   • the stuck-player watchdog  — polls decrypt counters and REBUILDS the player, which
    //     is the loudest suspect: a false positive here would itself produce a stall, and the
    //     rebuild is what strands audio on iOS
    //   • the viewing-session heartbeat — a fetch every 30s
    //   • the settings poll — a fetch every 5s, which also carries kill detection
    //
    // Consequences worth knowing while testing: a killed stream will NOT stop for this viewer,
    // the audience count will not include them, and a genuinely dead decoder will not recover
    // on its own. That is the point — it is a diagnostic, not a mode to ship anyone into.
    const BARE = new URLSearchParams(location.search).get("bare") === "1";
    if (BARE) console.warn("[bare] all background loops disabled: no watchdog, no heartbeat, no settings poll");

    // --- Player rebuild before the stream ceiling --------------------------------------------
    //
    // WebKit stops delivering after ~6500-7600 cumulative incoming unidirectional streams on one
    // WebTransport session. MoQ audio opens one stream per Opus frame, so 20ms audio burns that
    // budget in about 135 SECONDS and the stream goes quiet with the session still open, no
    // error, and nothing in JS able to see why. Rebuilding the player opens a NEW session with a
    // fresh budget, so rebuilding before the ceiling means never reaching it.
    //
    // COUNTED, NOT TIMED. The budget is spent per stream and streams do not arrive at a fixed
    // rate: 20ms audio burns it in ~135s, a video-only stream at ~0.5 streams/s would take
    // hours. Any single interval is both far too late for the first and gratuitous for the
    // second. Measured on vivoh.earth, where a 360s timer left viewers with ~135s of audio and
    // then four minutes of silence before the rebuild that was meant to prevent it.
    //
    // NATIVE WEBTRANSPORT ONLY, which is the one thing this client needs that vivoh does not.
    // Older Safari has no WebTransport and falls back to the WebSocket polyfill; that path has
    // no QUIC streams and no ceiling, so rebuilding those viewers would be an interruption
    // bought for nothing. `needsPolyfill` is the same flag the diag panel reports as TRANSPORT.
    //
    // Every rebuild costs a TAP (offerAudioRestore above). That is the whole reason 15941e4
    // tore scheduled rebuilds out of this client — but that rebuild was for token renewal and
    // bought nothing, where this one is the only thing standing between an iPhone viewer and a
    // dead stream at two minutes.
    //
    // NOT in bare mode: a rebuild resets the very counter ?bare=1 exists to measure.
    //
    // Sized on the LOW end of the measured ceiling, not the average. The four unbatched runs
    // stalled between 6489 and 7596 streams; 5500 sits 15% under the worst of them. Overshooting
    // costs a dead stream and a confused viewer, undershooting costs one extra tap.
    const STREAM_BUDGET = 5500;
    const refreshParam = new URLSearchParams(location.search).get("refresh");
    const refreshEvery = Number(refreshParam);
    // ?refresh=0 turns it off; a positive value forces a fixed timer for testing.
    const useTimer = refreshParam !== null && Number.isFinite(refreshEvery) && refreshEvery > 0;
    const useBudget = refreshParam === null && isSafari && !needsPolyfill;

    let rebuilding = false;
    const rebuildPlayer = async (why: string): Promise<boolean> => {
      // setInterval does not await, so without this a slow rebuild would be re-entered by the
      // next tick and swap the player twice.
      if (rebuilding) return false;
      rebuilding = true;
      try {
        const url = live.getAttribute("url");
        if (!url) return false;
        const ok = await swapInPlayer(url, why);
        console.log(`[refresh] rebuild ${ok ? "succeeded" : "FAILED (kept the old player)"}`);
        return ok;
      } finally {
        rebuilding = false;
      }
    };

    if (!BARE && useBudget) {
      console.log(`[refresh] rebuilding after ${STREAM_BUDGET} incoming streams`);
      // wtProbe.uni is cumulative across sessions, so measure a DELTA from the last rebuild —
      // an absolute compare would fire on every tick forever once the total passed the budget.
      let streamBase = wtProbe.uni;
      const budgetTimer = window.setInterval(async () => {
        const used = wtProbe.uni - streamBase;
        if (used < STREAM_BUDGET) return;
        console.log(`[refresh] ${used} streams used — rebuilding before the ceiling`);
        if (await rebuildPlayer("stream budget")) streamBase = wtProbe.uni;
      }, 2000);
      window.addEventListener("beforeunload", () => window.clearInterval(budgetTimer));
    } else if (!BARE && useTimer) {
      console.log(`[refresh] rebuilding the player every ${refreshEvery}s (fixed timer)`);
      const refreshTimer = window.setInterval(() => void rebuildPlayer("refresh"), refreshEvery * 1000);
      window.addEventListener("beforeunload", () => window.clearInterval(refreshTimer));
    }

    // --- On-device diagnostics: add ?diag=1 to the watch URL ---------------------------------
    //
    // Exists because a freeze reproduces on an iPhone and NOT in the headless harness. Seven
    // minutes of scripts/e2e/audio-across-renewal.mjs against the same stream showed continuous
    // flow — context running, currentTime and byte counters climbing, one element, no rebuild —
    // so whatever stops on the device is invisible from here. The device has to report it.
    //
    // Deliberately opt-in by query parameter: no ordinary viewer sees this, and it reads state
    // without touching any of it. Everything shown is already in the page; nothing is sent
    // anywhere, which matters on a product whose whole claim is that we cannot see your stream.
    //
    // What to look for when it freezes: WHICH counter stops first is the diagnosis.
    //   bytes stop      -> nothing is arriving; publisher, relay, or the OS suspended the socket
    //   bytes climb but
    //     ok stops      -> arriving but not decrypting; a key or salt problem
    //   ok climbs but
    //     painted stops -> decrypting but not rendering; the decoder died
    //   ctxTime stops   -> the AudioContext itself was suspended, typically by iOS
    if (new URLSearchParams(location.search).get("diag") === "1") {
      const panel = document.createElement("div");
      panel.style.cssText =
        "position:fixed;left:6px;bottom:6px;z-index:9999;max-width:96vw;padding:7px 9px;" +
        "background:rgba(0,0,0,0.82);color:#0f0;font:11px/1.45 ui-monospace,Menlo,monospace;" +
        "border-radius:6px;white-space:pre;pointer-events:none;";
      document.body.appendChild(panel);

      const t0 = performance.now();
      let lastBytes = -1;
      let lastVBytes = -1;
      let lastOk = -1;
      let stalledFor = 0;
      let lastAudioMove = 0;
      let lastVideoMove = 0;
      let lastDecMove = 0;
      // Which transport the page ACTUALLY chose. iOS Safari has no WebTransport and falls back
      // to the WebSocket polyfill; every clean headless run used native WebTransport, so this
      // is the single most important line for telling those two worlds apart.
      const TRANSPORT = needsPolyfill ? "TRANSPORT=websocket-polyfill" : "TRANSPORT=native-webtransport";

      const tick = () => {
        const el = live as unknown as {
          backend?: {
            audio?: {
              context?: { peek?: () => AudioContext | undefined };
              stats?: { peek?: () => { bytesReceived?: number } | undefined };
              buffered?: { peek?: () => unknown };
            };
            video?: {
              stats?: { peek?: () => { bytesReceived?: number } | undefined };
              stalled?: { peek?: () => boolean };
              timestamp?: { peek?: () => number };
            };
          };
          connection?: { established?: { peek?: () => unknown }; url?: { peek?: () => URL | undefined } };
          broadcast?: { status?: { peek?: () => string }; active?: { peek?: () => unknown } };
        };
        const a = el?.backend?.audio;
        const v = el?.backend?.video;
        const ctx = a?.context?.peek?.();
        const bytes = a?.stats?.peek?.()?.bytesReceived ?? -1;
        // VIDEO bytes separately from audio. If both stop together the connection died; if
        // only one stops it is that track's pipeline, which is a completely different fault.
        const vbytes = v?.stats?.peek?.()?.bytesReceived ?? -1;
        const vstalled = v?.stalled?.peek?.() ?? null;
        const vts = v?.timestamp?.peek?.() ?? null;
        // Is the CONNECTION still up? A live socket with no bytes means the relay stopped
        // sending; a dead one means the transport dropped and nothing re-established it.
        const conn = el?.connection?.established?.peek?.() ? "up" : "DOWN";
        const bstatus = el?.broadcast?.status?.peek?.() ?? "?";
        const bactive = el?.broadcast?.active?.peek?.() ? "yes" : "no";
        const { successes, failures } = decryptStats();
        const canvas = live.querySelector("canvas") as HTMLCanvasElement | null;

        // "Stalled" here means the two counters that should never stop both stopped. Reported
        // in seconds so the freeze can be timed against whatever else was happening.
        // Order matters, and getting it wrong made this panel lie: the "moved Ns ago" fields
        // below compare against lastBytes/lastOk, so those must NOT be overwritten until the
        // comparison has happened. A first version assigned them here and every audio/decrypt
        // field then reported the full session length, which is exactly the sort of confident
        // wrong number that sends an investigation down a blind alley.
        const nowSec = (performance.now() - t0) / 1000;
        if (bytes !== lastBytes) lastAudioMove = nowSec;
        if (successes !== lastOk) lastDecMove = nowSec;
        if (vbytes !== lastVBytes) lastVideoMove = nowSec;

        const frozen = bytes === lastBytes && successes === lastOk;
        stalledFor = frozen ? stalledFor + 1 : 0;
        lastBytes = bytes;
        lastOk = successes;
        lastVBytes = vbytes;

        const nowS = nowSec;
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        panel.style.color = stalledFor >= 3 ? "#f87171" : "#4ade80";
        // Rate over the FLOWING span, never over uptime. Dividing by uptime once reported
        // "13.3/s" for a run that actually ran at 49.5/s and then sat dead for 358s — a wrong
        // number that looked exactly like the hoped-for one, and it cost a full test cycle.
        const uniSpan = wtProbe.lastUniAt ? (wtProbe.lastUniAt - t0) / 1000 : 0;
        const uniRate = uniSpan > 0.5 ? wtProbe.uni / uniSpan : 0;
        const uniAgo = wtProbe.lastUniAt ? (performance.now() - wtProbe.lastUniAt) / 1000 : -1;
        const quicLine = wtProbe.installed
          ? `quic    streams=${wtProbe.uni} (${uniRate.toFixed(1)}/s over ${uniSpan.toFixed(0)}s)\n` +
            `        ${uniAgo >= 0 ? `last ${uniAgo.toFixed(0)}s ago` : "none yet"}  sess=${wtProbe.constructed}\n` +
            `closed  ${wtProbe.closedHow ?? "no — session still open"}\n`
          : "";

        panel.textContent =
          `up ${nowS.toFixed(0)}s   ${stalledFor >= 3 ? `STALLED ${stalledFor}s` : "flowing"}\n` +
          `conn    ${conn}  bcast=${bstatus}/${bactive}  ${TRANSPORT}\n` +
          quicLine +
          `audio B ${bytes}  (moved ${(nowS - lastAudioMove).toFixed(0)}s ago)\n` +
          `video B ${vbytes}  (moved ${(nowS - lastVideoMove).toFixed(0)}s ago)  stalled=${vstalled}\n` +
          `decrypt ok ${successes} fail ${failures}  (moved ${(nowS - lastDecMove).toFixed(0)}s ago)\n` +
          `vts     ${vts === null ? "?" : Math.round(vts as number)}\n` +
          `canvas  ${canvas ? `${canvas.width}x${canvas.height}` : "none"}\n` +
          `actx    ${ctx ? `${ctx.state} t=${ctx.currentTime.toFixed(1)}` : "none"}  muted=${live.muted}\n` +
          `page    ${document.visibilityState}` +
          (mem ? `  heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)}MB` : "");
      };

      tick();
      const diagTimer = window.setInterval(tick, 1000);
      window.addEventListener("beforeunload", () => window.clearInterval(diagTimer));
    }

    // --- Stuck-player watchdog --------------------------------------------------------------
    //
    // A viewer had no way back from either failure this page can produce, and both end in the
    // same silent black rectangle, so neither could be told from a stream that simply stopped:
    //
    //   Wrong key. The broadcaster cycled the passcode; frames arrive and none authenticate.
    //   Recoverable without touching the connection — ask for the new passcode and re-derive.
    //
    //   Dead decoder. Frames decrypt but nothing paints, because a WebCodecs decoder that was
    //   handed deltas without a keyframe has errored and stays closed. Nothing short of a new
    //   element recovers it (see swapInPlayer), which is why "just wait" never worked.
    //
    // Decrypt counters separate the two: it is the SUCCESS delta that says whether we hold the
    // right key, and painting that says whether the decoder survived. Failures alone cannot
    // distinguish them, which is what made the old check blame the viewer's passcode for a
    // decoder that had died holding a perfectly good one.
    let lastStats = decryptStats();
    let blankPolls = 0;
    let recovering = false;

    const watchdog = window.setInterval(async () => {
      if (BARE) return;
      if (recovering) return;
      const now = decryptStats();
      const gotFrames = now.successes - lastStats.successes;
      const failed = now.failures - lastStats.failures;
      lastStats = now;
      const painting = isPainting(live);

      // Nothing arriving at all: the broadcast may have paused or ended. Not our business —
      // the settings poll owns "terminated" and the route poll owns "offline".
      if (gotFrames === 0 && failed === 0) { blankPolls = 0; return; }

      if (gotFrames === 0 && failed > 0) {
        recovering = true;
        try {
          const entered = await promptPasscode(
            watchPasscode ? "rotated" : watchLinkClaimedPasscode ? "wrong" : "added"
          );
          if (entered) {
            watchPasscode = entered;
            await deriveMediaKey(watchLinkSecret, { streamId, salt: watchSalt, passcode: entered });
            retryWatchLink();   // the Link is keyed on the passcode too
            // The decoder may already have died on the frames that failed before this. Let the
            // painting branch below notice on a later tick and swap the element.
            blankPolls = 0;
          }
        } finally {
          recovering = false;
          lastStats = decryptStats();
        }
        return;
      }

      if (painting) { blankPolls = 0; return; }

      // Decrypting but not painting. Give it a few ticks — a viewer that joined mid-group is
      // legitimately blank until the next keyframe — then rebuild the player.
      if (++blankPolls < 4) return;
      blankPolls = 0;
      recovering = true;
      try {
        const url = live.getAttribute("url");
        if (url) await swapInPlayer(url, "watchdog");
      } finally {
        recovering = false;
        lastStats = decryptStats();
      }
    }, 2000);
    window.addEventListener("beforeunload", () => window.clearInterval(watchdog));

    // --- Viewing session ------------------------------------------------------------------
    //
    // A measured session, not a page-load ping. The old version opened a row and closed it
    // from beforeunload alone, which does not fire on iOS backgrounding, a crash, a dead
    // network or force-quit — so rows leaked and the viewer count only ever went up.
    //
    // Three parts keep it honest: a heartbeat that proves we are still here, sendBeacon on
    // pagehide (the one page-close signal mobile Safari actually delivers), and a server-side
    // reaper for everything neither of those catches.
    let watchSession: WatchSession | null = null;
    let heartbeat: number | null = null;

    const stopHeartbeat = () => {
      if (heartbeat !== null) window.clearInterval(heartbeat);
      heartbeat = null;
    };

    const startSession = async () => {
      if (watchSession) return;
      // routeTag is the proof we hold the share link; without it the Worker will not open a
      // session, which is what stops audience being manufactured for a guessed stream id.
      watchSession = await logWatchStart(streamId, routeTag);
      if (!watchSession) return;
      stopHeartbeat();
      heartbeat = window.setInterval(async () => {
        if (BARE) return;
        if (!watchSession) return;
        if (await logWatchHeartbeat(watchSession)) return;
        // The server has forgotten this session — the tab was suspended long enough to be
        // reaped. Start a fresh one rather than beat against a closed row: the viewer really
        // did stop watching for that gap, and stitching over it would over-report.
        watchSession = null;
        stopHeartbeat();
        void startSession();
      }, watchSession.heartbeatSeconds * 1000);
    };

    const endSession = () => {
      stopHeartbeat();
      if (!watchSession) return;
      logWatchEnd(watchSession);
      watchSession = null;
    };

    void startSession();

    // pagehide is the reliable one — mobile Safari fires it on background/close where
    // beforeunload is simply never delivered. beforeunload stays as a desktop belt-and-braces;
    // end is idempotent, so both firing costs nothing.
    window.addEventListener("pagehide", endSession);
    window.addEventListener("beforeunload", endSession);

    // Deliberately NOT ending on visibilitychange: switching apps for a moment is not leaving.
    // A hidden tab keeps beating (browsers throttle to ~1/min, still inside the reaper's
    // window); if the OS suspends it outright the reaper closes the session at its last
    // heartbeat, and coming back opens a new one through the handler above.

    // Create HTML overlay display div. It sits as a full-width block BELOW the video/chat
    // row (its CSS is width:100%/max-width:900px/margin:auto). It must stay a direct child
    // of #watch-view, NOT inside the flex .video-chat-layout row — flex would override the
    // width and park it beside the video — so insert it right after the layout row.
    const watchView = document.querySelector("#watch-view");
    const watchLayout = watchView?.querySelector(".video-chat-layout");
    let overlayDiv = document.querySelector(".viewer-html-overlay") as HTMLDivElement;
    if (!overlayDiv && watchView && watchLayout) {
      overlayDiv = document.createElement("div");
      overlayDiv.className = "viewer-html-overlay";
      watchLayout.after(overlayDiv);
    }

    // Render the broadcaster's overlay, SANITISED. The policy and the reasoning behind every
    // rule in it live in src/overlay-sanitize.ts; the broadcaster's editor previews through
    // the same function, so what they see there is what lands here.
    const updateOverlay = (overlayHtml: string) => {
      if (!overlayDiv) return;
      overlayDiv.innerHTML = overlayHtml.trim() ? renderOverlay(overlayHtml).html : "";
    };

    // Load initial overlay content
    if (settings.overlay_html) {
      updateOverlay(settings.overlay_html);
    }

    // ---- The broadcaster's Link, as something you can actually tap ----
    //
    // The QR is already burned into the picture, which serves anyone watching on another
    // screen. It does nothing at all for the person watching on the phone they would have
    // scanned it with — and on a touch device that is most of the audience. So the same URL
    // arrives here as text and becomes a real anchor: a full-width target on a phone, an
    // ordinary link with a cursor on a desktop.
    //
    // It arrives SEALED (see deriveLinkKey). Opening it needs the fragment, so this is one
    // more thing the link-holder can see and we cannot.
    let linkBar: HTMLAnchorElement | null = null;
    let shownLink = "";

    const renderWatchLink = (url: string | null) => {
      if (!url) {
        linkBar?.remove();
        linkBar = null;
        return;
      }
      if (!linkBar) {
        // Nowhere to put it means no link rather than a detached node quietly collecting
        // href updates that nobody can see.
        const mount = overlayDiv ?? watchLayout;
        if (!mount) return;
        linkBar = document.createElement("a");
        linkBar.className = "viewer-link-bar";
        // noopener/noreferrer: the destination is chosen by the broadcaster, so it must not
        // get a handle on this window or learn which stream sent the traffic. nofollow because
        // this is user-submitted in every sense that matters.
        linkBar.target = "_blank";
        linkBar.rel = "noopener noreferrer nofollow";
        // Not innerHTML anywhere near the URL. The arrow is static markup; the address is set
        // as text below.
        linkBar.innerHTML = '<span class="viewer-link-icon" aria-hidden="true">↗</span><span class="viewer-link-text"></span>';
        // Directly under the video, above the Extras block if one is present.
        mount.before(linkBar);
      }
      const label = linkBar.querySelector(".viewer-link-text") as HTMLElement;
      // Show the whole address rather than a prettified host. Someone deciding whether to tap
      // a stranger's link deserves to see where it goes; CSS truncates it if it is long, and
      // the title carries the rest.
      label.textContent = url;
      linkBar.href = url;
      linkBar.title = url;
    };

    /**
     * Unseal and display, or take the bar down.
     *
     * Re-validates the scheme AFTER decryption even though the broadcaster's side already
     * did. This value made a round trip through storage before becoming an href, and the cost
     * of checking again is three lines against a `javascript:` URL landing in a link the
     * viewer is being invited to tap.
     */
    const updateWatchLink = async (sealed: string) => {
      if (sealed === shownLink) return;   // unchanged; skip the crypto on every poll
      shownLink = sealed;
      if (!sealed || !watchLinkSecret) {
        renderWatchLink(null);
        return;
      }
      try {
        const key = await deriveLinkKey(watchLinkSecret, {
          streamId,
          salt: watchSalt,
          passcode: watchPasscode,
        });
        const url = await openText(key, sealed);
        // null means the wrong key — no passcode yet, or a stale salt. Same treatment as
        // undecryptable video: show nothing and let a later poll succeed once the viewer has
        // what they need. Never surface it as an error, because it is routinely temporary.
        if (!url) {
          renderWatchLink(null);
          return;
        }
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          console.warn("[link] refusing a non-http link from the broadcaster");
          renderWatchLink(null);
          return;
        }
        renderWatchLink(parsed.href);
      } catch {
        renderWatchLink(null);
      }
    };
    retryWatchLink = () => { shownLink = " "; };   // never a real sealed value
    void updateWatchLink(settings.link_enc);

    // Poll for setting changes (auth and overlay)
    const settingsCheckInterval = setInterval(async () => {
      if (BARE) return;
      const currentSettings = await getStreamSettings(streamId);

      // Terminated: checked first, because nothing below it matters afterwards.
      if (currentSettings.killed) {
        clearInterval(settingsCheckInterval);
        endSession();
        closeWatchChat();
        stopForKill("viewer");
        return;
      }

      // Check auth requirement (anonymous viewers only)
      if (!user && currentSettings.require_auth) {
        clearInterval(settingsCheckInterval);
        endSession();
        showWatchLoginRequired();
        return;
      }

      // Update overlay content
      updateOverlay(currentSettings.overlay_html);

      // The broadcaster can put a link up, change it, or take it down mid-stream, and the QR
      // in the picture changes the instant they do. This keeps the tappable copy in step.
      void updateWatchLink(currentSettings.link_enc);

      // React to the broadcaster toggling live chat on/off mid-stream.
      if (currentSettings.chat_enabled) openWatchChat();
      else closeWatchChat();
    }, 5000); // Check every 5 seconds

    // Cleanup interval on page unload
    window.addEventListener("beforeunload", () => {
      clearInterval(settingsCheckInterval);
    });
  }
}


// Initialize the app
// TEMP diagnostic: time WebTransport bidi-stream creation. If a stream takes
// ~15s to OPEN after being requested, the stall is QUIC stream-credit/flow-control
// (relay grants MAX_STREAMS slowly) — NOT client logic. If "called" itself is late,
// it's client-side. Distinguishes the two for the ~15s subscribe gaps.
function instrumentWebTransportStreams() {
  if (typeof WebTransport === "undefined") return;
  const proto = WebTransport.prototype as unknown as {
    __streamTimed?: boolean;
    createBidirectionalStream: (...args: unknown[]) => Promise<unknown>;
  };
  if (proto.__streamTimed) return;
  proto.__streamTimed = true;
  const orig = proto.createBidirectionalStream;
  let n = 0;
  proto.createBidirectionalStream = function (this: unknown, ...args: unknown[]) {
    const i = ++n;
    if (i > 8) return orig.apply(this, args);
    const t = performance.now();
    console.log(`[wt-stream] #${i} createBidirectionalStream() called @ ${Math.round(t)}ms`);
    const p = orig.apply(this, args);
    Promise.resolve(p).then(
      () => console.log(`[wt-stream] #${i} OPENED after ${Math.round(performance.now() - t)}ms`),
      (e: unknown) => console.log(`[wt-stream] #${i} failed after ${Math.round(performance.now() - t)}ms`, e)
    );
    return p;
  };
}

// TEMP diagnostic: prefix every console line with a wall-clock timestamp
// (HH:MM:SS.mmm) so the @moq MoQ request logs (connected, negotiated ALPN,
// announced, subscribe start/ok catalog.json + video/hd, received catalog,
// sync[video]) can be correlated directly against the relay's server-side timeline.
function timestampConsole() {
  const w = window as unknown as { __consoleTimestamped?: boolean };
  if (w.__consoleTimestamped) return;
  w.__consoleTimestamped = true;
  (["debug", "log", "info", "warn", "error"] as const).forEach((m) => {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]) => orig(`[${new Date().toISOString().slice(11, 23)}]`, ...args);
  });
}

async function init() {
  timestampConsole();
  instrumentWebTransportStreams();
  // Count incoming unidirectional streams for EVERY viewer. WebKit stops delivering after
  // ~6500-7600 cumulative streams on one WebTransport session and the watch page rebuilds the
  // player before that (see STREAM_BUDGET), so this counter is load-bearing, not diagnostic.
  //
  // Installed here rather than at module scope so it wraps whatever WebTransport the page
  // actually ends up using: the WebSocket polyfill above replaces the global when native
  // WebTransport is absent, and measuring the wrong one would be worse than not measuring.
  installWtProbe();
  // Detect browser support (async for codec checks)
  browserSupport = await detectBrowserSupport();

  // For Safari/polyfill mode, select the best relay server based on latency
  if (needsPolyfill) {
    // Safari/polyfill path is disabled (tinymoq is WebTransport-only); kept for the
    // serverStatus side effect only. No static relay URL is used anymore — relays and
    // per-broadcast tokens are resolved dynamically at go-live / watch time.
    await selectBestFallbackRelay();
  } else {
    // WebTransport mode - assume connected
    serverStatus.connected = true;
  }

  // Update status panels
  updateBrowserSupportPanel();
  updateServerStatusPanel();

  // Load hang components dynamically AFTER polyfill is installed
  await loadHangComponents();

  // Harvest ?pk= into storage BEFORE routing runs. The /broadcast route rewrites the URL to
  // /?stream=<id> and preserves only ?geo=, so the publish key would otherwise be discarded
  // before go-live ever asks for it.
  getPublishKey();

  const { view, streamId } = await getRouteInfo();
  // Tell anything waiting which view this is, HERE — before the user fetch and before any
  // connecting — so a consumer is unblocked in milliseconds. Chiefly the seed economy, which
  // must not run its onboarding at a viewer. See src/route-view.ts for why the URL cannot
  // answer this question by itself.
  publishView(view);

  // Get user first (needed for broadcast auth check)
  const { user, geo } = await getCurrentUser();
  updateAuthUI(user, geo);

  if (view === "landing") {
    initLandingView();
  } else if (view === "broadcast") {
    initBroadcastView(streamId, user);
  } else {
    await initWatchView(streamId, user);
  }

  // Browser support toggle
  const supportLink = document.getElementById("support-link");
  const supportPanel = document.getElementById("support-panel");
  if (supportLink && supportPanel) {
    supportLink.addEventListener("click", (e) => {
      e.preventDefault();
      supportPanel.classList.toggle("hidden");
    });
  }

  // "How it works" has one door now, on the "How you're protected" card — see below. This
  // panel is landing-only as a consequence, which is the intent: the words are for someone
  // deciding whether to trust this, not for someone already mid-broadcast.
  const howPanel = document.getElementById("howitworks-panel");

  // Closing from INSIDE the panel, because the only thing that opens it is most of a page
  // above and scrolled away by the time it is open. Takes the support box with it, which
  // would otherwise be stranded below with nothing on screen to close it again.
  document.getElementById("howitworks-close")?.addEventListener("click", (e) => {
    e.preventDefault();
    howPanel?.classList.add("hidden");
    supportPanel?.classList.add("hidden");
  });

  // The card's second door. Deliberately OPENS rather than toggles: this link is most of a
  // page away from the panel it controls, and a toggle that happened to close it would read as
  // a dead link rather than as a toggle.
  const cardHow = document.getElementById("card-howitworks-link");
  if (cardHow && howPanel) {
    cardHow.addEventListener("click", (e) => {
      e.preventDefault();
      howPanel.classList.remove("hidden");
      howPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // Server status toggle
  const serverLink = document.getElementById("server-link");
  const serverPanel = document.getElementById("server-panel");
  if (serverLink && serverPanel) {
    serverLink.addEventListener("click", (e) => {
      e.preventDefault();
      serverPanel.classList.toggle("hidden");
    });
  }
}

import { publishView } from "./route-view";

// Run when DOM is ready
function bootstrap(): void {
  init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
