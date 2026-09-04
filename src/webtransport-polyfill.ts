// Patched WebTransport polyfill that handles requireUnreliable gracefully
// The original polyfill throws when requireUnreliable is true, but we want to
// just warn and continue since MoQ can work without datagrams (streams only)

import WebTransportWs from "@moq/web-transport-ws";

// Track active connections for debugging
const activeConnections: WeakSet<WebTransportWs> = new WeakSet();
let connectionCount = 0;

// Create a wrapper that intercepts the constructor to handle requireUnreliable
function createPatchedWebTransport() {
  return function PatchedWebTransport(url: string | URL, options?: WebTransportOptions) {
    // Remove requireUnreliable from options to avoid the throw
    const patchedOptions = options ? { ...options } : undefined;
    if (patchedOptions?.requireUnreliable) {
      console.warn("WebSocket polyfill: requireUnreliable is not supported, continuing without unreliable transport");
      delete (patchedOptions as Record<string, unknown>).requireUnreliable;
    }

    const connId = ++connectionCount;
    console.log(`WebSocket polyfill [${connId}]: Creating connection to ${url}`);

    // Call the original constructor
    const transport = new WebTransportWs(url, patchedOptions);
    activeConnections.add(transport);

    // Log connection lifecycle
    transport.ready.then(() => {
      console.log(`WebSocket polyfill [${connId}]: Connection ready`);
    });

    transport.closed.then((info) => {
      console.log(`WebSocket polyfill [${connId}]: Connection closed - code: ${info.closeCode}, reason: ${info.reason}`);
    });

    return transport;
  };
}

// Monitor page visibility changes (Safari aggressively suspends connections)
let visibilityMonitorInstalled = false;
function installVisibilityMonitor() {
  if (visibilityMonitorInstalled) return;
  visibilityMonitorInstalled = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      console.warn("WebSocket polyfill: Page hidden - Safari may throttle/close WebSocket connections");
    } else {
      console.log("WebSocket polyfill: Page visible again");
    }
  });

  // Also monitor Safari's page lifecycle events
  window.addEventListener("pagehide", () => {
    console.warn("WebSocket polyfill: Page hide event - connections may be closed");
  });

  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      console.log("WebSocket polyfill: Page restored from bfcache - connections likely need reconnection");
    }
  });
}

// Install the patched polyfill
// Use force=true to override native WebTransport (e.g., for Safari compatibility issues)
export function install(force = false): boolean {
  if (!force && "WebTransport" in globalThis) {
    return false;
  }
  // biome-ignore lint/suspicious/noExplicitAny: polyfill
  (globalThis as any).WebTransport = createPatchedWebTransport();

  // Install visibility monitoring for debugging
  if (typeof document !== "undefined") {
    installVisibilityMonitor();
  }

  return true;
}
