// Frontend authentication utilities

import { buildPublisherClaim } from "./publisher-claim";

export interface User {
  id: number;
  email: string;
  name: string;
  avatar_url: string;
}

export interface Geo {
  country: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string | null;
  continent: string | null;
}

export type Provider = "google";

// OAUTH-DISABLED: return a static anonymous user so broadcast/play work without
// sign-in. Restore the /api/auth/me fetch (below) to re-enable Google OAuth.
export async function getCurrentUser(): Promise<{ user: User | null; geo: Geo | null }> {
  return {
    user: { id: 1, email: "anonymous@e2emoq.com", name: "Anonymous", avatar_url: "" },
    geo: null,
  };
  /* OAUTH-DISABLED — original:
  try {
    const response = await fetch("/api/auth/me");
    const data = await response.json();
    return { user: data.user, geo: data.geo };
  } catch {
    return { user: null, geo: null };
  }
  */
}

// Convert ISO 3166-1 Alpha 2 country code to flag emoji
export function countryToFlag(countryCode: string | null): string {
  if (!countryCode || countryCode.length !== 2) return "";
  // Regional indicator symbols: A=🇦 (U+1F1E6), B=🇧 (U+1F1E7), etc.
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 0x1f1e6 + char.charCodeAt(0) - 65);
  return String.fromCodePoint(...codePoints);
}

// OAUTH-DISABLED: sign-in/out are no-ops while OAuth is off. Restore the redirects to re-enable.
export function login(): void {
  /* OAUTH-DISABLED: window.location.href = "/api/auth/google/login"; */
}

export function loginWithGoogle(): void {
  /* OAUTH-DISABLED: window.location.href = "/api/auth/google/login"; */
}

export function logout(): void {
  /* OAUTH-DISABLED: window.location.href = "/api/auth/logout"; */
}

// Stats logging functions
export interface BroadcastStart {
  eventId: number | null; // null when go-live failed, so no row was written
  relay: string | null; // assigned tinymoq relay "host:port", or null on failure
  jwt: string | null; // per-broadcast publisher token (scoped to this stream), or null
  path?: string | null; // moq.pro connect path "<root>/<stream>.hang" (Mode A); absent in fleet mode
  encrypted?: boolean; // true if this stream uses relay-blind E2E media encryption
  contentKey?: string | null; // always null now: the key is derived from the link fragment
  salt?: string | null;       // public HKDF salt; rotating it re-keys the stream
  /**
   * Why go-live failed, for the caller to show a person.
   *
   * This used to be a bare `return null`, which meant eight distinct refusals — no publish
   * key, an expired one, a terminated stream, an expired challenge, a name already in use, a
   * broker that is down — all arrived at the UI as the single phrase "(no relay assigned)".
   * The reason was read here and then dropped on the floor. `status` is the HTTP status, or 0
   * when the request never completed at all.
   */
  status?: number;
  error?: string;
}

export async function logBroadcastStart(
  streamId: string,
  publisherCdn?: string,
  claim?: { publishKey: string; pubkey: string; challenge: string; signature: string },
  routeTag?: string
): Promise<BroadcastStart | null> {
  try {
    console.log("Attempting to log broadcast start for stream:", streamId, publisherCdn ? `(publisher CDN: ${publisherCdn})` : "");
    // Forward a ?geo= test override so the broadcaster's broker assign (origin placement)
    // honors it too; brokerHints reads it from the request URL.
    const geo = new URLSearchParams(location.search).get("geo");
    const qs = geo ? `?geo=${encodeURIComponent(geo)}` : "";
    const response = await fetch(`/api/stats/broadcast${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream_id: streamId,
        publisher_cdn: publisherCdn,
        // Admission credential, plus proof that this broadcast name is ours. The private half
        // of the broadcast key never leaves this page — only the signature travels.
        publish_key: claim?.publishKey,
        pubkey: claim?.pubkey,
        challenge: claim?.challenge,
        signature: claim?.signature,
        // Proof-of-link tag: lets the Worker check that a viewer asking for a token actually
        // holds the share link. Derived from the link secret with a different HKDF info AND
        // salt than the content key, so sending it here gives the Worker nothing to decrypt
        // with — see deriveRouteTag() in crypto/media-crypto.ts.
        route_tag: routeTag,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to log broadcast start:", response.status, errorText);
      // The Worker answers refusals as {"error": "..."} — its own words, already written for a
      // person. Anything else (an HTML error page from in front of it, an empty body) is not
      // worth showing raw, so it falls back to the status alone.
      let error = "";
      try {
        const parsed = JSON.parse(errorText);
        if (typeof parsed?.error === "string") error = parsed.error;
      } catch { /* not JSON: the status is all we have */ }
      return { eventId: null, relay: null, jwt: null, status: response.status, error };
    }
    const data = await response.json();
    console.log("Broadcast started with geo:", data.geo, "relay:", data.relay);
    return {
      eventId: data.id,
      relay: data.relay ?? null,
      jwt: data.jwt ?? null,
      path: data.path ?? null,
      encrypted: data.encrypted ?? false,
      contentKey: data.content_key ?? null,
      salt: data.salt ?? null,
    };
  } catch (e) {
    console.error("Error logging broadcast start:", e);
    // Never reached the Worker at all — offline, DNS, a captive portal. status 0 marks that
    // apart from a refusal, because the advice differs completely.
    return { eventId: null, relay: null, jwt: null, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// Look up the relay hosting a live broadcast (for viewers to co-locate) plus a
// per-broadcast viewer token. Returns { relay: "host:port", jwt } or null if the
// stream is offline / not yet routed (404) or access is denied (401 on auth-required
// streams without a session). Optional viewerCdn pulls from a specific CDN destination;
// optional origin (publisher relay host:port) forces a cross-cluster pull source (testing).
export interface StreamRoute {
  relay: string;
  jwt: string | null;
  path?: string | null; // moq.pro connect path "<root>/<stream>.hang" (Mode A); absent in fleet mode
  encrypted?: boolean; // true if this stream uses relay-blind E2E media encryption
  contentKey?: string | null; // always null now: the key is derived from the link fragment
  salt?: string | null;       // public HKDF salt, identical to the publisher's
  // Mode C (Enterprise): present only when the Worker resolved a PRIVATE on-net relay
  // for this viewer's network. The browser is the only thing that can reach `relay`.
  mode?: "enterprise";
  edgeHost?: string; // remote edge the local relay pulls the broadcast from
  broadcast?: string; // full broadcast name to subscribe to
  watchToken?: string; // browser -> local relay (mirrors jwt)
  pullToken?: string; // local relay -> edge (cluster-flagged pull pass)
}

export async function getStreamRoute(
  streamId: string,
  viewerCdn?: string,
  origin?: string,
  opts?: { noEnterprise?: boolean; routeTag?: string }
): Promise<StreamRoute | null> {
  try {
    const qp = new URLSearchParams();
    if (viewerCdn) qp.set("viewer-cdn", viewerCdn);
    if (origin) qp.set("origin", origin);
    // Proof that we hold the share link. Derived from the fragment, which never leaves the
    // browser — this tag does, and is useless for decryption. Without it the Worker would
    // hand a viewer token to anyone who guessed a five-character stream id.
    if (opts?.routeTag) qp.set("tag", opts.routeTag);
    // Tell the Worker to skip Mode C and return B/A (set after a failed enterprise attempt).
    if (opts?.noEnterprise) qp.set("noEnterprise", "1");
    // Forward the viewer's transport hint (?xport=) so the Worker can pass it onto the
    // server-side edge /assign (Mode B). Not secret; read straight from the page URL.
    const xp = new URLSearchParams(location.search).get("xport");
    if (xp) qp.set("xport", xp);
    // Test override: forward ?geo=<lat>,<lon> so the Worker sends it to the broker as the
    // viewer location, letting geo-routing be tested from anywhere without a VPN.
    const geo = new URLSearchParams(location.search).get("geo");
    if (geo) qp.set("geo", geo);
    // Test override: ?ttl=<seconds> asks for a shorter-lived viewer token. Used to measure
    // whether the CDN enforces token expiry on an ESTABLISHED session or only at connect —
    // which decides whether the kill switch can be enforced against any client, or only
    // requested of cooperative ones. The Worker clamps it and will never issue a LONGER token.
    const ttl = new URLSearchParams(location.search).get("ttl");
    if (ttl) qp.set("ttl", ttl);
    const qs = qp.toString() ? `?${qp.toString()}` : "";
    const response = await fetch(`/api/streams/${streamId}/route${qs}`);
    if (!response.ok) return null; // 404 = offline, 401 = auth required
    const data = await response.json();
    if (!data.relay) return null;
    return {
      relay: data.relay,
      jwt: data.jwt ?? data.watchToken ?? null,
      path: data.path ?? null,
      encrypted: data.encrypted ?? false,
      contentKey: data.content_key ?? null,
      salt: data.salt ?? null,
      mode: data.mode === "enterprise" ? "enterprise" : undefined,
      edgeHost: data.edgeHost,
      broadcast: data.broadcast,
      watchToken: data.watchToken,
      pullToken: data.pullToken,
    };
  } catch {
    return null;
  }
}

/**
 * Mark a broadcast ended and free its relay assignment.
 *
 * sendBeacon, for the same reason logWatchEnd uses it: this fires from pagehide/beforeunload,
 * and a normal fetch() started there is routinely cancelled when the document goes away. The
 * viewer side learned that; this one had not, and here it costs more than a miscounted
 * session. An unclosed row keeps `ended_at IS NULL`, and nameIsAvailable() then refuses the
 * NEXT go-live under that stream id with 409 "that broadcast name is in use" — because the
 * claim keypair is deliberately lost on reload, so a returning broadcaster cannot prove they
 * are the same publisher. The id survives a reload in ?stream=, so the effect was a
 * broadcaster permanently locked out of their own link by closing a tab. Production held 131
 * such rows blocking 131 ids, the oldest from 2026-08-13.
 *
 * The Worker's reaper closes anything this still fails to deliver.
 */
export function logBroadcastEnd(eventId: number): void {
  const url = `/api/stats/broadcast/${eventId}/end`;
  try {
    // No body: the route takes the id from the path. An empty blob still needs a type that
    // does not trip a CORS preflight, same as logWatchEnd.
    if (navigator.sendBeacon?.(url, new Blob([""], { type: "text/plain;charset=UTF-8" }))) {
      return;
    }
  } catch {
    // fall through to fetch
  }
  try {
    // See logWatchEnd for why the cast is needed.
    void fetch(url, { method: "POST", keepalive: true } as RequestInit);
  } catch {
    // Ignore errors — the reaper closes anything we fail to report.
  }
}

/**
 * A viewing session.
 *
 * `token` authorises heartbeat and end for THIS session and nothing else. It stays in memory
 * for the life of the page — never localStorage, never sessionStorage, never reused for
 * another stream. Persisting it would turn a per-session capability into a stable handle for
 * the person holding it, which is the one thing the audience tables must not contain.
 */
export interface WatchSession {
  id: number;
  token: string;
  heartbeatSeconds: number;
}

/**
 * Open a viewing session. `routeTag` proves we hold the share link — the same capability
 * /route requires — so audience cannot be manufactured for a stream by anyone who merely
 * guessed its five-character id.
 */
export async function logWatchStart(streamId: string, routeTag?: string): Promise<WatchSession | null> {
  try {
    const response = await fetch("/api/stats/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream_id: streamId, tag: routeTag }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (typeof data.id !== "number" || typeof data.token !== "string") return null;
    return { id: data.id, token: data.token, heartbeatSeconds: data.heartbeat_seconds ?? 30 };
  } catch {
    return null;
  }
}

/**
 * "Still watching." Returns false when the server no longer has the session — usually
 * because the tab was suspended long enough to be reaped — which is the caller's cue to
 * open a fresh one rather than keep beating against a closed row.
 */
export async function logWatchHeartbeat(session: WatchSession): Promise<boolean> {
  try {
    const response = await fetch(`/api/stats/watch/${session.id}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: session.token }),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

/**
 * Close a viewing session.
 *
 * Uses sendBeacon, because this fires while the page is going away and a normal fetch() is
 * routinely cancelled at that point — which is exactly how sessions used to leak. sendBeacon
 * can only send text/plain without tripping a CORS preflight, so the Worker parses the body
 * leniently; see readJsonBody(). Falls back to keepalive fetch where sendBeacon is missing.
 */
export function logWatchEnd(session: WatchSession): void {
  const url = `/api/stats/watch/${session.id}/end`;
  const body = JSON.stringify({ token: session.token });
  try {
    if (navigator.sendBeacon?.(url, new Blob([body], { type: "text/plain;charset=UTF-8" }))) {
      return;
    }
  } catch {
    // fall through to fetch
  }
  try {
    // `keepalive` lets the request outlive the page, which is the entire point here. The cast
    // is because this project typechecks against worker-configuration.d.ts with no DOM lib,
    // so RequestInit resolves to the Workers one, which has no such field.
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    } as RequestInit);
  } catch {
    // Ignore errors — the reaper closes anything we fail to report.
  }
}

// Stream settings functions
export async function checkStreamExists(streamId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/streams/${streamId}/exists`);
    const data = await response.json();
    return data.exists ?? false;
  } catch {
    return false;
  }
}

export interface StreamSettings {
  require_auth: boolean;
  overlay_html: string;
  /**
   * The Link watermark's URL, SEALED — `<nonce>.<ciphertext>` under the link key, never a
   * plain URL. Named `_enc` so that nothing downstream mistakes it for one and drops it into
   * an href: the only correct thing to do with this value is openText() it first, which fails
   * closed for anyone without the share-link fragment.
   */
  link_enc: string;
  encrypted: boolean;
  chat_enabled: boolean;
  /** Terminated by an operator. Both sides poll for this and stop; see stopForKill(). */
  killed: boolean;
}

export async function getStreamSettings(streamId: string): Promise<StreamSettings> {
  try {
    const response = await fetch(`/api/streams/${streamId}`);
    const data = await response.json();
    return {
      require_auth: data.require_auth ?? false,
      overlay_html: data.overlay_html ?? "",
      link_enc: data.link_enc ?? "",
      encrypted: data.encrypted ?? false,
      chat_enabled: data.chat_enabled ?? false,
      killed: data.killed ?? false,
    };
  } catch {
    // Fails to `killed: false` deliberately. A network blip must not black out a stream that
    // is running perfectly well — the real signal is an explicit `true` from the server, and
    // a poll that fails will simply be retried five seconds later.
    return { require_auth: false, overlay_html: "", link_enc: "", encrypted: false, chat_enabled: false, killed: false };
  }
}

/**
 * Save stream settings, PROVING the caller is this broadcast's publisher.
 *
 * The proof is required because these settings are not cosmetic: overlay_html renders as
 * markup and cross-origin iframes in every viewer's browser, and require_auth decides who may
 * watch. Without it the endpoint accepted a write for any stream id from anyone — see the
 * ownership block in the Worker for why "requires auth" was not the gate it appeared to be.
 *
 * Same claim shape as go-live: admission credential plus a signature over a fresh Worker
 * challenge, made with the keypair this broadcast already holds.
 *
 * A broadcaster with no publish key yet cannot save settings. That is consistent — they cannot
 * broadcast either — but it means toggles flipped BEFORE a key is entered do not persist, so
 * the failure is logged rather than swallowed.
 */
/**
 * Returns whether the write actually landed.
 *
 * It used to return void, so every caller treated "saved" and "silently refused" as the same
 * outcome. That is how chat came to sit on "reconnecting…" indefinitely on a device with no
 * publish key: the setting never persisted, the Worker therefore refused the WebSocket with
 * 403, and the client — unable to tell that apart from a dropped connection — retried on a
 * backoff for as long as the page stayed open. A caller that is about to act on the write
 * needs to know it happened.
 */
export async function updateStreamSettings(
  streamId: string,
  settings: Partial<Omit<StreamSettings, never>>
): Promise<boolean> {
  try {
    const claim = await buildPublisherClaim(streamId);
    if (!claim) {
      console.warn("[settings] not saved: no publish key on this device yet");
      return false;
    }
    const res = await fetch("/api/streams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream_id: streamId,
        ...settings,
        publish_key: claim.publishKey,
        pubkey: claim.pubkey,
        challenge: claim.challenge,
        signature: claim.signature,
      }),
    });
    if (!res.ok) {
      // Silence here previously meant a rejected write looked exactly like a saved one.
      console.warn(`[settings] not saved: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[settings] not saved", e);
    return false;
  }
}

// Live stats
export interface LiveBroadcast {
  id: number;
  stream_id: string;
  started_at: string;
  user_id: number;
  user_name: string;
  user_email: string;
  avatar_url: string;
  geo_country: string | null;
  geo_city: string | null;
  geo_region: string | null;
  geo_latitude: string | null;
  geo_longitude: string | null;
  geo_timezone: string | null;
}

export interface LiveViewer {
  id: number;
  stream_id: string;
  started_at: string;
  last_seen_at: string | null;
  user_id: number | null;
  user_name: string | null;
  user_email: string | null;
  avatar_url: string | null;
  geo_country: string | null;
  geo_city: string | null;
  geo_region: string | null;
  geo_latitude: string | null;
  geo_longitude: string | null;
  geo_timezone: string | null;
}

export async function getLiveStats(): Promise<{ broadcasts: LiveBroadcast[]; viewers: LiveViewer[] } | null> {
  try {
    const response = await fetch("/api/stats/live");
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// `routeTag` is required once the broadcast has registered one: audience size is metadata
// about the broadcaster, so reading it takes the same proof-of-link everything else does.
export async function getStreamViewers(
  streamId: string,
  routeTag?: string
): Promise<{ stream_id: string; viewers: LiveViewer[] } | null> {
  try {
    const qs = routeTag ? `?tag=${encodeURIComponent(routeTag)}` : "";
    const response = await fetch(`/api/stats/stream/${streamId}/viewers${qs}`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
