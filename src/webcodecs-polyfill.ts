// WebCodecs polyfill for Safari - provides Opus audio encoding via libav.js WASM
// This must be loaded and initialized BEFORE hang components try to use AudioEncoder

import * as LibAVWebCodecs from "@kixelated/libavjs-webcodecs-polyfill";

// Check if we need the audio encoder polyfill
// Safari doesn't support AudioEncoder with Opus codec natively
async function needsAudioPolyfill(): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") {
    return true;
  }

  // Check if Opus encoding is supported
  try {
    const result = await AudioEncoder.isConfigSupported({
      codec: "opus",
      numberOfChannels: 2,
      sampleRate: 48000,
    });
    return !result.supported;
  } catch {
    return true;
  }
}

let initialized = false;

/**
 * Initialize the WebCodecs polyfill for audio encoding.
 * This installs AudioEncoder, AudioDecoder, AudioData, and EncodedAudioChunk
 * polyfills that support Opus via libav.js WASM.
 */
export async function install(): Promise<boolean> {
  if (initialized) {
    return false;
  }

  const needsPolyfill = await needsAudioPolyfill();
  if (!needsPolyfill) {
    console.log("WebCodecs: Native Opus encoding supported, skipping polyfill");
    return false;
  }

  console.log("WebCodecs: Installing Opus audio polyfill via libav.js");

  try {
    // Set up LibAV to load the opus variant from our vendored copy
    // The WASM files are ~1.5MB and served from /vendor/libav-opus/
    // This is vendored for stability - won't break if upstream changes
    // Using 6.7.7 to match polyfill compatibility (6.8.x has API changes)
    // IMPORTANT: Use the .js entry point, not .wasm.js (which lacks static methods)
    const libavBase = "/vendor/libav-opus";
    const libavScript = "libav-6.7.7.1.1-opus-af.js";

    // Load the LibAV script - it will set up globalThis.LibAV
    // biome-ignore lint/suspicious/noExplicitAny: polyfill global
    (globalThis as any).LibAV = { base: libavBase };

    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${libavBase}/${libavScript}`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load LibAV script"));
      document.head.appendChild(script);
    });

    // The entry point script sets up globalThis.LibAV with LibAV.LibAV as factory
    // biome-ignore lint/suspicious/noExplicitAny: polyfill global
    const LibAV = (globalThis as any).LibAV;
    if (!LibAV || !LibAV.LibAV) {
      throw new Error("LibAV.LibAV not found after loading script");
    }

    // Load the polyfill with our LibAV
    // The polyfill expects LibAV to have a .LibAV() factory function
    await LibAVWebCodecs.load({
      polyfill: true,
      LibAV: LibAV,
      libavOptions: {
        noworker: true, // Workers can't be loaded cross-origin
      },
    });

    initialized = true;
    console.log("WebCodecs: Opus audio polyfill installed successfully");
    return true;
  } catch (error) {
    console.error("WebCodecs: Failed to install polyfill:", error);
    return false;
  }
}
