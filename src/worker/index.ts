// Cloudflare Worker entry point
// Handles API routes for authentication, falls back to static assets

// OAUTH-DISABLED: Google OAuth + session imports are off while auth is disabled.
// Restore these imports (and the handlers/routes/guards marked OAUTH-DISABLED below)
// to re-enable Google sign-in.
/*
import {
  getGoogleAuthUrl,
  exchangeCodeForTokens as exchangeGoogleCode,
  getGoogleUserInfo,
} from "./auth/google";
import {
  createSessionToken,
  verifySessionToken,
  setSessionCookie,
  clearSessionCookie,
  getSessionFromCookie,
} from "./auth/session";
*/
// NOTE: moq-token is NOT OAuth — it signs per-broadcast MoQ relay tokens. Keep it.
import { mintEd25519Token, mintHs256Token, mintMoqProToken, mintMoqProTokenEd25519, publicVerifyJwk, type MoqClaims } from "./auth/moq-token";
// Per-stream live chat Durable Object (WebSocket hibernation). Re-exported so wrangler
// can bind it; see wrangler.jsonc durable_objects + migrations.
export { ChatRoom } from "./chat-room";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD?: string; // secret (wrangler secret put) — admin API bearer; unset ⇒ admin disabled
  // Days to keep viewing-session rows. Unset ⇒ keep forever, so any stream id stays
  // reportable. Set it when the audience history stops being worth more than the risk of
  // holding it: these rows are timestamps against stream ids, and what has been deleted
  // cannot be compelled. See reapSessions().
  STATS_RETENTION_DAYS?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  // BYOK: tenant's Ed25519 PRIVATE signing key as an OKP JWK (JSON string, includes `d`).
  // When set, the Worker mints EdDSA tokens with it (only the matching public key is
  // registered with TinyMoQ). When unset, the Worker falls back to the per-stream HS256
  // key returned by /assign (managed mode). Optional so the file is tenant-agnostic.
  MOQ_AUTH_PRIVATE_JWK?: string;
  // DIRECT mode only (FLEET_MODE=direct): the provisioning bearer for a relay box's control
  // API (/assign, /release) — i.e. the box bearer. Legitimate only when you operate the box
  // yourself (operator == customer). In BROKERED mode this must NOT be set on moqplay: the
  // box bearer stays with the broker; leaking it into the customer app defeats Path 2.
  TINYMOQ_PROVISION_KEY?: string;
  // BROKERED mode only (FLEET_MODE=brokered): the operator-issued CUSTOMER token moqplay
  // presents to the broker's assign URL. This is the customer's credential — NOT the box
  // bearer (which moqplay never sees). Set it as a wrangler secret.
  CDN_API_TOKEN?: string;
  // moq.pro (Luke Curley's hosted CDN) migration — Mode A. base64url "k" of the account's
  // HS256 JWK (kid f865…); the Worker signs per-broadcast moq.pro tokens with it. When set,
  // broadcast/route publish through cdn.moq.pro instead of the self-hosted fleet. wrangler secret.
  MOQ_PRO_K?: string;
  // moq.pro asymmetric signing key: the PRIVATE half of an Ed25519 keypair whose public half
  // was uploaded via moq.pro's "Import Asymmetric". Preferred over MOQ_PRO_K, because with
  // this the CDN can verify our tokens but cannot mint one. wrangler secret.
  MOQ_PRO_JWK?: string;
  // moq.pro account root (the path namespace under cdn.moq.pro). Defaults to "erik".
  MOQ_PRO_ROOT?: string;
  // What moq.pro calls the signing key, if that differs from the `kid` inside MOQ_PRO_JWK.
  // The CDN picks its verifying key by this value; get it wrong and every token is refused
  // at the MoQ layer — the WebTransport session still connects and negotiates ALPN, then
  // closes a few hundred ms later with nothing but "Connection lost". Unset => use the kid
  // in the JWK, which is what our keygen writes (an RFC 7638 thumbprint).
  MOQ_PRO_KID?: string;
  // Publisher admission credential. A broadcaster must present this to get a publish token.
  // It is NOT an account: there is one shared value, it identifies nobody, and it is never
  // written down anywhere on this side. It exists so that bandwidth billed to our moq.pro
  // tenant — and the overlay-HTML surface that executes in viewers' browsers — is not open
  // to anonymous strangers. Rotating it revokes every broadcaster at once. wrangler secret.
  PUBLISH_SECRET?: string;
  // HMAC key for stateless publish challenges. Separate from PUBLISH_SECRET so that leaking
  // a challenge can never reveal the admission credential. wrangler secret.
  CHALLENGE_SECRET?: string;
  // HMAC key that seals per-person publish CODES (see "Publish codes" below). A code carries
  // its own not-before, expiry and batch in the clear; this key is what makes those claims
  // unforgeable, so holding it is equivalent to being able to mint publish access. Separate
  // from PUBLISH_SECRET and CHALLENGE_SECRET so the three can be rotated independently.
  // Unset => the whole code path is off and only PUBLISH_SECRET admits. wrangler secret.
  ISSUE_KEY?: string;
  // Current issuance cohort stamped into new codes. Bump it to make `revoked_batches` able to
  // cut off everything minted before the bump without touching anyone issued after. Default 1.
  PUBLISH_CODE_BATCH?: string;
  // How long a minted code stays valid. Expiry — not a revocation list — is the primary way a
  // broadcaster is cut off: you simply do not reissue. That works because the kill switch
  // already handles anything urgent, so code revocation is only ever about FUTURE broadcasts
  // and is allowed to be slow. Default 30 days.
  PUBLISH_CODE_TTL_DAYS?: string;
  // Delay before a freshly minted code becomes usable. This is the real abuse lever: it
  // breaks the killed -> request another -> back up in ninety seconds loop that makes abuse
  // cheap, at the cost of making a legitimate first-time broadcaster wait. Set to 0 to issue
  // codes that work immediately. Default 24 hours.
  PUBLISH_CODE_DELAY_HOURS?: string;
  // Proof-of-work difficulty (leading zero BITS) for requesting a code. Be honest about what
  // this buys: it stops scripted mass-minting and nothing more. It is asymmetric the wrong
  // way — an abuser has cloud CPUs, a legitimate user has a phone on a train — so it is set
  // where a phone takes a few seconds, and the delay above does the heavier lifting.
  PUBLISH_CODE_POW_BITS?: string;
  // TinyMoQ fleet endpoint: the base URL the Worker hits to get a relay for a broadcast.
  // Switching endpoints (or paths, see FLEET_MODE) is a config change, not a code change —
  // set it in wrangler.jsonc `vars`. Optional; falls back to the historical box when unset.
  //   - direct mode:   the relay box BASE, e.g. https://cdn.tinymoq.com (Worker appends /assign + /release)
  //   - brokered mode: the broker's full ASSIGN URL, e.g. https://tinymoq.com/cdn/assign (Worker POSTs to it)
  // The credential is mode-specific (TINYMOQ_PROVISION_KEY in direct, CDN_API_TOKEN in
  // brokered). MOQ_AUTH_PRIVATE_JWK's public half is installed as the fleet's verify_jwk —
  // BYOK is unchanged across both paths.
  FLEET_ENDPOINT?: string;
  // How the Worker gets a relay: "direct" (Path 1 — call a relay box's /assign yourself) or
  // "brokered" (Path 2 — POST {broadcast} to a CDN operator's broker, which selects the box
  // and returns {relay}). Default "direct". In brokered mode moqplay never sees box topology
  // and holds no per-box secret, so the operator adding/removing boxes needs no config change.
  FLEET_MODE?: string;
  // Mode C (Enterprise) — WORKER-DRIVEN steering. When set, this Worker ITSELF (not the
  // broker, not any external resolve API) steers matching viewers to this dedicated edge
  // host (e.g. "erik.moqcdn.net"). The browser couriers its BYOK watch token to the edge's
  // /assign, which validates it against this tenant's verify_jwk (box-side "C1" — no bearer
  // in the browser). Unset => Mode C is off and the viewer route is pure brokered B/A.
  ENTERPRISE_EDGE_HOST?: string;
  // Optional ASN allow-list for ENTERPRISE_EDGE_HOST (comma-separated, e.g. "13335,7922").
  // Empty/unset => steer ALL viewers to the edge. Set to gate steering to specific networks.
  ENTERPRISE_ASNS?: string;
  // How the edge sources the broadcast: "crosspull" (default) — the edge pulls it from the
  // publisher's origin relay, so the Worker hands the browser `edgeHost` (real origin
  // host:port) + a cluster-flagged `pullToken`. "standalone" — the publisher is already on
  // the edge (edge = origin), so neither is sent and the only new piece is C1 viewer auth.
  ENTERPRISE_MODE?: string;
  // Per-stream live chat rooms (one Durable Object instance per streamId).
  CHAT_ROOMS: DurableObjectNamespace;
}

interface User {
  id: number;
  google_id: string | null;
  email: string;
  name: string;
  avatar_url: string;
  created_at: string;
  updated_at: string;
}

type Provider = "google";

// OAUTH-DISABLED: stand-in user returned wherever a signed-in user is expected, so
// broadcast/stream/stats writes keep working without sign-in. Matches the seeded
// users row (id=1) in db/schema.sql. Remove when OAuth is restored.
const ANON_USER: User = {
  id: 1,
  google_id: null,
  email: "anonymous@e2emoq.com",
  name: "Anonymous",
  avatar_url: "",
  created_at: "",
  updated_at: "",
};

/**
 * Refuse to be framed. Anywhere, by anyone, including ourselves.
 *
 * This is the other half of the overlay embed policy in src/overlay-sanitize.ts. That side
 * only lets a broadcaster embed a CROSS-ORIGIN https iframe, because a cross-origin frame
 * cannot reach `window.parent` and therefore cannot read the content key out of the viewer's
 * page. The gap it cannot close on its own: an embed we allowed could, after loading,
 * navigate ITSELF to e2emoq.com — and its sandbox carries allow-same-origin, so at that
 * point it would be same-origin with the page that holds the key.
 *
 * `frame-ancestors 'none'` ends that at the source: no document of ours renders inside a
 * frame, so the navigation produces nothing to talk to. X-Frame-Options says the same thing
 * for anything that predates CSP.
 *
 * Nothing here frames itself, so this costs us no functionality. Both halves are load-bearing
 * — do not drop one because the other looks sufficient on its own.
 */
function noFraming(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("content-security-policy", "frame-ancestors 'none'");
  out.headers.set("x-frame-options", "DENY");
  return out;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // API routes
    if (url.pathname.startsWith("/api/")) {
      return handleApiRoutes(request, env, url, ctx);
    }

    // Standalone pages, deliberately NOT SPA routes. Each shares nothing with the app bundle:
    //   /request — loaded by someone who has no credential yet, so it pulls in no player, no
    //              crypto and no chat code.
    //   /trust   — the claims page. No player, no crypto: someone deciding whether to trust
    //              this service should not have to load the thing they are evaluating.
    const STANDALONE_PAGES: Record<string, string> = {
      "/request": "/request.html",
      "/trust": "/trust.html",
    };
    const standalone = STANDALONE_PAGES[url.pathname.replace(/\/$/, "")];
    if (standalone) {
      const pageUrl = new URL(standalone, url.origin);
      return noFraming(await env.ASSETS.fetch(new Request(pageUrl.toString(), {
        method: request.method,
        headers: request.headers,
      })));
    }

    // SPA routes - serve index.html for stream ID paths, /stats, and /{stream}/stats
    const pathWithoutSlash = url.pathname.slice(1);
    const isStreamId = /^[a-z0-9]{5}$/.test(pathWithoutSlash);
    const isStatsPage = url.pathname === "/stats";
    const isStreamStatsPage = /^\/[a-z0-9]{5}\/stats$/.test(url.pathname);
    const isClearDataPage = url.pathname === "/cleardata";
    // Client-routed app pages (the SPA renders these; no matching asset file exists).
    const isAppPage = url.pathname === "/broadcast" || url.pathname === "/watch";

    if (isStreamId || isStatsPage || isStreamStatsPage || isClearDataPage || isAppPage) {
      const indexUrl = new URL("/index.html", url.origin);
      return noFraming(await env.ASSETS.fetch(new Request(indexUrl.toString(), {
        method: request.method,
        headers: request.headers,
      })));
    }

    // Fall through to static assets — including "/" itself, which is the app.
    return noFraming(await env.ASSETS.fetch(request));
  },

  // Close viewing sessions whose heartbeat stopped, and apply STATS_RETENTION_DAYS.
  //
  // Without this, every session that ended in a way the browser could not report — iOS
  // backgrounding, a crash, a dead network, force-quit — would stay open forever, and both
  // the live count and any duration derived from it would be fiction. Scheduled rather than
  // opportunistic so it still runs when nobody is broadcasting.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const { closed, purged } = await reapSessions(env);
    if (closed || purged) console.log(`[reaper] closed=${closed} purged=${purged}`);
    const broadcasts = await reapBroadcasts(env);
    if (broadcasts) console.log(`[reaper] broadcasts closed=${broadcasts}`);
  },
};

async function handleApiRoutes(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    // GET /api/geo-debug — read-only diagnostic: shows the Cloudflare geo this Worker sees
    // on the incoming request, and exactly what it WOULD forward to the broker as hints.geo
    // (respecting the ?geo= test override). No secrets. Answers "is request.cf populated,
    // and are we sending geo?" without needing a broadcast or broker access.
    if (request.method === "GET" && url.pathname === "/api/geo-debug") {
      const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
      return Response.json({
        fleet_mode: fleetMode(env),
        cf: cf
          ? {
              latitude: cf.latitude ?? null,
              longitude: cf.longitude ?? null,
              country: cf.country ?? null,
              city: cf.city ?? null,
              colo: cf.colo ?? null,
            }
          : null,
        would_forward: brokerHints(request) ?? null,
      });
    }

    // GET /api/whereami — tells a caller where WE think THEY are, and what time it is here.
    //
    // Feeds the broadcaster's location burn-in. Everything here is derived from the caller's
    // own request: `request.cf` geo (which we see on every request regardless) plus our clock.
    // It is returned to that caller and to nobody else — not written to D1, not logged, not
    // forwarded to the broker. If you add a console.log or an INSERT here you have turned an
    // echo of the caller's own metadata into a location record; don't.
    //
    // `no-store` matters more than it looks: a cached response would hand one broadcaster
    // another broadcaster's city, and this value gets burned into video as evidence.
    //
    // Deliberately NOT honouring the ?geo= override that brokerHints() accepts. That override
    // exists to test relay routing from a laptop; wired up here it would make forging the
    // location in a "proof" burn-in a matter of typing a query string.
    if (request.method === "GET" && url.pathname === "/api/whereami") {
      const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
      const num = (v: unknown): number | null => {
        // cf.latitude is a STRING and may be absent or empty (always under `wrangler dev`).
        // Number("") is 0, so an empty value would otherwise render as null island {0,0}
        // burned into the picture as fact.
        if (v == null || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return Response.json(
        {
          lat: num(cf?.latitude),
          lon: num(cf?.longitude),
          city: cf?.city ?? null,
          region: cf?.region ?? null,
          country: cf?.country ?? null,
          colo: cf?.colo ?? null,
          // Milliseconds since epoch at the edge. The caller pairs this with its own send and
          // receive times to correct its local clock, so the burned-in time is real time and
          // not whatever the broadcaster's machine believes.
          server_time_ms: Date.now(),
          // Say plainly what this is, so a client can't present it as more than it is —
          // including when it is nothing. Off Cloudflare (a self-hosted origin)
          // there is no request.cf, and reporting "cloudflare-ip-geo" beside a null latitude
          // would be a weaker answer wearing a stronger label, which is the one thing the
          // burn-in is not allowed to do.
          source: cf ? "cloudflare-ip-geo" : "none",
          precision: cf ? "city" : "none",
        },
        { headers: { "cache-control": "no-store" } }
      );
    }

    // GET /api/pubkey — the PUBLIC verify JWK for this deployment's BYOK signing key, as
    // plain JSON, for an operator to paste into their CDN console as moqplay's verify_jwk.
    // Public material only; the private half (MOQ_AUTH_PRIVATE_JWK) is never exposed here.
    if (request.method === "GET" && url.pathname === "/api/pubkey") {
      if (!env.MOQ_AUTH_PRIVATE_JWK) {
        return new Response("signing key not configured", { status: 503 });
      }
      try {
        return Response.json(publicVerifyJwk(env.MOQ_AUTH_PRIVATE_JWK));
      } catch (e) {
        console.error("/api/pubkey:", e);
        return new Response("invalid signing key", { status: 500 });
      }
    }

    // OAUTH-DISABLED: provider (Google) auth routes are off.
    // if (url.pathname.startsWith("/api/auth/google/")) {
    //   return handleProviderAuth(request, env, url, "google");
    // }

    // Publish-code issuance. Public: the whole point is that obtaining one requires no
    // account and tells us nothing about who asked. Note these live under /api/publish-code/
    // and NOT /api/publish/… — the latter is an exact-match route for something else.
    if (url.pathname.startsWith("/api/publish-code/")) {
      return handlePublishCodeRoutes(request, env, url);
    }

    // The publish challenge is handled in handleStatsRoutes, alongside the go-live endpoint
    // it pairs with. Dispatched explicitly because it matches none of the prefixes below —
    // and note it must come BEFORE the /api/publish exact match, which is a different route.
    if (url.pathname === "/api/publish/challenge") {
      return handleStatsRoutes(request, env, url);
    }

    // Stream settings routes.
    if (url.pathname.startsWith("/api/streams")) {
      return handleStreamRoutes(request, env, url);
    }

    // Admin routes
    if (url.pathname.startsWith("/api/admin/")) {
      return handleAdminRoutes(request, env, url);
    }

    // Stats routes
    if (url.pathname.startsWith("/api/stats/")) {
      return handleStatsRoutes(request, env, url);
    }

    // OAUTH-DISABLED: only /api/auth/me remains (returns an anonymous session so the
    // frontend renders without sign-in). Login/callback are off; logout is a no-op redirect.
    switch (url.pathname) {
      case "/api/auth/me":
        return handleMe(request, env);
      case "/api/auth/logout":
        return Response.redirect(url.origin, 302);
      default:
        return new Response("Not Found", { status: 404 });
    }
  } catch (error) {
    console.error("API error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

// OAUTH-DISABLED: Google sign-in handlers below reference the commented-out
// google/session modules. The whole block is disabled; restore it (and the imports)
// to re-enable OAuth.
/*
function handleProviderAuth(
  request: Request,
  env: Env,
  url: URL,
  provider: Provider
): Promise<Response> {
  const action = url.pathname.split("/").pop();

  if (action === "login") {
    return Promise.resolve(handleLogin(env, url, provider));
  }
  if (action === "callback") {
    return handleCallback(request, env, url, provider);
  }

  return Promise.resolve(new Response("Not Found", { status: 404 }));
}

// GET /api/auth/{provider}/login - Redirect to OAuth provider
function handleLogin(env: Env, url: URL, provider: Provider): Response {
  const state = `${provider}:${crypto.randomUUID()}`;
  const redirectUri = `${url.origin}/api/auth/${provider}/callback`;

  const authUrl = getGoogleAuthUrl(env.GOOGLE_CLIENT_ID, redirectUri, state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      "Set-Cookie": `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}

// GET /api/auth/{provider}/callback - Handle OAuth callback
async function handleCallback(
  request: Request,
  env: Env,
  url: URL,
  provider: Provider
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return Response.redirect(`${url.origin}/?error=oauth_denied`, 302);
  }

  if (!code || !state) {
    return Response.redirect(`${url.origin}/?error=invalid_request`, 302);
  }

  // Verify state (CSRF protection)
  const cookieHeader = request.headers.get("Cookie");
  const storedState = cookieHeader?.match(/oauth_state=([^;]*)/)?.[1];

  if (state !== storedState) {
    return Response.redirect(`${url.origin}/?error=invalid_state`, 302);
  }

  try {
    const redirectUri = `${url.origin}/api/auth/${provider}/callback`;

    const tokens = await exchangeGoogleCode(
      code,
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );
    const googleUser = await getGoogleUserInfo(tokens.access_token);
    const userInput: UserInput = {
      provider: "google",
      provider_id: googleUser.id,
      email: googleUser.email,
      name: googleUser.name,
      avatar_url: googleUser.picture,
    };

    // Upsert user in D1
    const user = await upsertUser(env.DB, userInput);

    // Create session token
    const sessionToken = await createSessionToken(user.id, env.SESSION_SECRET);
    const isProduction = url.hostname !== "localhost";

    // Clear oauth_state cookie and set session cookie
    return new Response(null, {
      status: 302,
      headers: [
        ["Location", url.origin],
        ["Set-Cookie", setSessionCookie(sessionToken, isProduction)],
        ["Set-Cookie", "oauth_state=; Path=/; HttpOnly; Max-Age=0"],
      ],
    });
  } catch (err) {
    console.error("OAuth callback error:", err);
    return Response.redirect(`${url.origin}/?error=auth_failed`, 302);
  }
}

// GET /api/auth/logout - Clear session and redirect
function handleLogout(url: URL): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.origin,
      "Set-Cookie": clearSessionCookie(),
    },
  });
}
*/

// GET /api/config is gone with the node-id path: node_directory was its only field, and
// nothing in the client ever read anything else from it.

// GET /api/auth/me - OAUTH-DISABLED: return the anonymous user + Cloudflare geo (no
// session lookup). Restore the original (in the commented block above) to re-enable.
async function handleMe(request: Request, _env: Env): Promise<Response> {
  const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
  const geo = {
    country: cf?.country || null,
    city: cf?.city || null,
    region: cf?.region || null,
    postalCode: cf?.postalCode || null,
    latitude: cf?.latitude?.toString() || null,
    longitude: cf?.longitude?.toString() || null,
    timezone: cf?.timezone || null,
    continent: cf?.continent || null,
  };
  return Response.json({
    user: {
      id: ANON_USER.id,
      email: ANON_USER.email,
      name: ANON_USER.name,
      avatar_url: ANON_USER.avatar_url,
    },
    geo,
  });
}

// Database operations

interface UserInput {
  provider: Provider;
  provider_id: string;
  email: string;
  name: string;
  avatar_url: string;
}

async function upsertUser(db: D1Database, input: UserInput): Promise<User> {
  const providerColumn = `${input.provider}_id`;

  // Try to find existing user by provider ID
  const existing = await db
    .prepare(`SELECT * FROM users WHERE ${providerColumn} = ?`)
    .bind(input.provider_id)
    .first<User>();

  if (existing) {
    // Update existing user
    await db
      .prepare(
        `UPDATE users
         SET email = ?, name = ?, avatar_url = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(input.email, input.name, input.avatar_url, existing.id)
      .run();

    return { ...existing, email: input.email, name: input.name, avatar_url: input.avatar_url };
  }

  // Check if user exists with same email (link accounts)
  const existingByEmail = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(input.email)
    .first<User>();

  if (existingByEmail) {
    // Link new provider to existing account
    await db
      .prepare(
        `UPDATE users
         SET ${providerColumn} = ?, name = ?, avatar_url = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(input.provider_id, input.name, input.avatar_url, existingByEmail.id)
      .run();

    return {
      ...existingByEmail,
      [providerColumn]: input.provider_id,
      name: input.name,
      avatar_url: input.avatar_url
    };
  }

  // Insert new user
  const result = await db
    .prepare(
      `INSERT INTO users (${providerColumn}, email, name, avatar_url)
       VALUES (?, ?, ?, ?)
       RETURNING *`
    )
    .bind(input.provider_id, input.email, input.name, input.avatar_url)
    .first<User>();

  return result!;
}

async function getUserById(db: D1Database, id: number): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

// Stream settings routes handler
async function handleStreamRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // GET /api/streams/:stream_id/chat - Live chat WebSocket (forwarded to the per-stream
  // Durable Object). Only for chat-enabled streams; everyone (broadcaster + viewers) can
  // connect. WS handshakes are GET requests.
  const chatMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})\/chat$/);
  if (chatMatch) {
    const streamId = chatMatch[1];
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const s = await env.DB
      .prepare("SELECT chat_enabled FROM streams WHERE stream_id = ?")
      .bind(streamId)
      .first<{ chat_enabled: number }>();
    if (s?.chat_enabled !== 1) {
      return new Response("chat disabled", { status: 403 });
    }
    const id = env.CHAT_ROOMS.idFromName(streamId);
    return env.CHAT_ROOMS.get(id).fetch(request);
  }

  // GET /api/streams/:stream_id - Get stream settings (public)
  //
  // `killed` rides along here rather than getting its own endpoint because broadcaster and
  // viewer BOTH already poll this every 5s. Adding a second poll to carry one boolean would
  // double the request rate for something this already fetches.
  //
  // It is the client's only chance to learn a stream was terminated. Kill is enforced at
  // /route and at go-live, but both are request-time checks and an established session makes
  // no further requests — measured: a viewer kept decoding for a full minute after a kill,
  // and would have continued until its next reconnect (scripts/e2e/kill-live-viewer.mjs).
  //
  // Not a new disclosure: /route already answers 410-vs-404 for anyone who asks, so the
  // killed state of a stream id was public before this line existed.
  const streamIdMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})$/);
  if (method === "GET" && streamIdMatch) {
    const streamId = streamIdMatch[1];
    // One round trip, and a row comes back even when neither table has an entry — a stream
    // with settings but no salt row, or a salt row with no settings, must both be answerable.
    const stream = await env.DB
      .prepare(`
        SELECT s.require_auth, s.overlay_html, s.link_enc, s.encrypted, s.chat_enabled, k.killed_at
        FROM (SELECT ? AS sid) q
        LEFT JOIN streams s ON s.stream_id = q.sid
        LEFT JOIN stream_salts k ON k.stream_id = q.sid
      `)
      .bind(streamId)
      .first<{
        require_auth: number | null;
        overlay_html: string | null;
        link_enc: string | null;
        encrypted: number | null;
        chat_enabled: number | null;
        killed_at: string | null;
      }>();

    return Response.json({
      stream_id: streamId,
      require_auth: stream?.require_auth === 1,
      overlay_html: stream?.overlay_html || "",
      // Handed back exactly as received. This is the broadcaster's Link watermark, sealed
      // under a key derived from the share-link fragment — so it means nothing here and is not
      // ours to interpret. Only a viewer holding the fragment can open it.
      link_enc: stream?.link_enc || "",
      encrypted: true, // mandatory for every stream; the column is retained but no longer authoritative
      chat_enabled: stream?.chat_enabled === 1,
      killed: !!stream?.killed_at,
    });
  }

  // /api/publish and /api/edge lived here: the provisioning half of watch-by-pubkey, where
  // the browser resolved a 52-char Ed25519 name off the Mainline DHT and we placed the origin
  // and edge for it. Both are gone. Cross-fleet placement was never the DHT's job — the
  // brokered viewer assign below already hands the broker the origin and lets it steer the
  // viewer to their nearest fleet — and the discovery record it published was world-readable
  // and unencrypted, which is the opposite of what the rest of this app promises.

  // GET /api/streams/:stream_id/exists - Check if stream ID is in use (has active broadcast)
  const streamExistsMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})\/exists$/);
  if (method === "GET" && streamExistsMatch) {
    const streamId = streamExistsMatch[1];
    const activeBroadcast = await env.DB
      .prepare("SELECT id FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL LIMIT 1")
      .bind(streamId)
      .first<{ id: number }>();

    return Response.json({
      stream_id: streamId,
      exists: activeBroadcast !== null,
    });
  }

  // GET /api/streams/:stream_id/route - Relay hosting the live broadcast (public).
  // 404 = no live broadcast. Viewers use this to co-locate on the publisher's relay.
  //
  // IMPORTANT: relay ports are dynamic and can change DURING a live broadcast
  // (reap/respawn), so the stored D1 port goes stale. We therefore re-query the
  // autoscaler (/assign is sticky + idempotent → the broadcast's CURRENT relay)
  // and use D1 only to confirm the stream is live and which CDN cluster the
  // publisher is on. D1 is synced when the port has changed (for /admin + stats).
  //
  // Optional ?viewer-cdn=cdn-02.tinymoq.com pulls from a different CDN cluster
  // (push-to-one/pull-from-two), with origin = the publisher's CURRENT relay.
  const streamRouteMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})\/route$/);
  if (method === "GET" && streamRouteMatch) {
    const streamId = streamRouteMatch[1];
    const row = await env.DB
      .prepare(
        "SELECT relay_host, relay_port, route_tag FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
      )
      .bind(streamId)
      .first<{ relay_host: string | null; relay_port: number | null; route_tag: string | null }>();

    if (!row?.relay_host) {
      return new Response("offline", { status: 404 });
    }

    // Proof of link. The publisher registered a tag derived from the link secret; a viewer
    // proves it holds the same link by presenting the identical value. See deriveRouteTag().
    //
    // This is what stops a stranger sweeping the five-character id space, collecting viewer
    // tokens and pulling the ciphertext of every live broadcast on our CDN bill.
    //
    // Enforced only when the publisher supplied one, so a broadcast started by an older client
    // still serves its viewers. That is not a bypass: an attacker cannot choose whether the
    // row carries a tag, only the broadcaster can.
    if (row.route_tag) {
      const presented = url.searchParams.get("tag") ?? "";
      if (!constantTimeEqual(presented, row.route_tag)) {
        // 404, not 403: a stranger guessing ids learns nothing from this response that they
        // did not already know, and in particular not whether the id is live.
        return new Response("offline", { status: 404 });
      }
    }

    // Terminated streams get no viewer token, checked before any capacity is provisioned.
    // `create: false` — a viewer must never bring a salt row into existence for a stream
    // that was never broadcast.
    const viewerSalt = await derivationSalt(env, streamId, false);
    if (!viewerSalt) {
      return new Response("offline", { status: 404 });
    }
    if (viewerSalt.killed) {
      return Response.json({ error: "This stream has been terminated." }, { status: 410 });
    }

    // Access control: the token IS the grant. For auth-required streams, only mint a
    // viewer token for a caller with a valid session — otherwise 401. Public streams
    // (require_auth = 0) mint for anyone. Checked before we assign any relay so an
    // unauthorized viewer never provisions capacity. Future policies (allow-list, paid,
    // geo) are just additional "decide whether to mint" checks here; the relay has no ACL.
    const streamCfg = await env.DB
      .prepare("SELECT require_auth FROM streams WHERE stream_id = ?")
      .bind(streamId)
      .first<{ require_auth: number }>();
    if (streamCfg?.require_auth === 1) {
      const user = await getAuthenticatedUser(request, env);
      if (!user) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
    }

    // Optional shorter viewer token: ?ttl=<seconds>.
    //
    // Safe to expose publicly because it can only REDUCE privilege — a caller may ask for a
    // token that dies sooner, never one that lives longer, and the clamp enforces that.
    //
    // It is kept purely as a MEASUREMENT tool — it is how token-expiry.mjs asks whether the
    // CDN enforces expiry on an established session. Nothing in normal operation sets it:
    // the default is now the full VIEWER_TOKEN_TTL, because the client no longer renews.
    const requestedTtl = Number(url.searchParams.get("ttl"));
    const viewerTtl =
      Number.isFinite(requestedTtl) && requestedTtl >= 10 && requestedTtl < VIEWER_TOKEN_TTL
        ? Math.floor(requestedTtl)
        : VIEWER_TOKEN_TTL;

    // moq.pro (Mode A): relay is always cdn.moq.pro; mint a subscribe-only token scoped to
    // THIS stream and return the connect path. Bypasses the fleet broker/direct logic below.
    const mp = await moqProAssign(env, streamId, "watch", viewerTtl);
    if (mp) {
      // No content key to release: the viewer derives it from the `#k=` fragment of the link
      // they were given. `encrypted` is a statement of fact about the stream, not a grant.
      // The salt is the same public value the publisher got, so both derive the same key.
      return Response.json({
        relay: mp.relay,
        path: mp.path,
        jwt: mp.jwt,
        encrypted: true,
        content_key: null,
        salt: viewerSalt.salt,
        // Echoed so a test can assert it got the short token it asked for, rather than
        // measuring a session that quietly received the 6h default.
        token_ttl: viewerTtl,
      });
    }

    // ── Brokered viewer assign ──────────────────────────────────────────────
    // The broker owns box selection AND cross-fleet placement. We hand it the origin
    // (host:port from D1) + a subscribe-scoped pull token and send them UNCONDITIONALLY:
    // the broker serves direct when the viewer co-locates with the origin box (hostname
    // check, no hair-pin), else steers the viewer to their geo-nearest fleet and makes THAT
    // box cluster-pull the origin over host:port. Returns
    // here, so the direct-mode logic below (which assumes current==origin and would overwrite
    // D1's origin row with the viewer's box) never runs in brokered mode.
    if (fleetMode(env) === "brokered") {
      const origin = row.relay_port ? `${row.relay_host}:${row.relay_port}` : null;
      const now = Math.floor(Date.now() / 1000);
      // One subscribe-scoped token (get:[broadcastName]) serves BOTH as the browser's ?jwt=
      // AND the edge->origin pull pass — the relay authorizes the pull by scope alone (no
      // cluster/internal flag needed). Same scope the viewer already subscribes with.
      const pull = origin
        ? await tryMintMoqToken(env, { put: [], get: [broadcastName(streamId)], exp: now + PULL_TOKEN_TTL })
        : null;
      const relay = await assignViaBroker(env, broadcastName(streamId), request, origin ? { origin, pull } : undefined);
      if (!relay) return new Response("offline", { status: 404 });
      const viewerJwt = await tryMintMoqToken(env, { put: [], get: [broadcastName(streamId)], exp: now + VIEWER_TOKEN_TTL });
      // Link-held keys: nothing to release here. Kept as constants so the response shape below is unchanged.
          const encrypted = true;
          const contentKey = null;
      console.log(`[route] mode=brokered stream=${streamId} origin=${origin} relay=${relay.host}:${relay.port}`);
      return Response.json({ relay: `${relay.host}:${relay.port}`, jwt: viewerJwt, encrypted, content_key: contentKey });
    }
    // ────────────────────────────────────────────────────────────────────────

    // Direct mode only: the publisher's own relay is authoritative (sticky per name).
    const publisherCluster = row.relay_host; // cluster host, e.g. usw.<fleet-domain>
    const current = await assignRelay(env, streamId, publisherCluster, undefined, env.TINYMOQ_PROVISION_KEY, undefined, undefined, request);
    if (!current) {
      return new Response("offline", { status: 404 });
    }

    // Keep D1 in sync if the relay moved (reap/respawn) so admin/stats stay accurate.
    if (current.host !== publisherCluster || current.port !== row.relay_port) {
      await env.DB
        .prepare("UPDATE broadcast_events SET relay_host = ?, relay_port = ? WHERE stream_id = ? AND ended_at IS NULL")
        .bind(current.host, current.port, streamId)
        .run();
    }

    // ── Mode C (Enterprise) ────────────────────────────────────────────────
    // If this viewer's network (Cloudflare-provided ASN) has a PRIVATE on-net relay,
    // hand the browser the local relay address + the two tokens it needs and let IT
    // connect — no server can reach that relay. Runs BEFORE today's B/A logic. The
    // player sets ?noEnterprise=1 after a failed enterprise attempt to force B/A, and
    // any resolve failure simply falls through, so the viewer always gets the stream.
    const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
    const asn = cf?.asn ?? 0;
    const asOrg = cf?.asOrganization ?? "";
    const skipEnterprise = url.searchParams.get("noEnterprise") === "1";
    if (!skipEnterprise) {
      const ent = enterpriseEdge(env, asn, current);
      if (ent) {
        // crosspull (default): the edge pulls the broadcast from the publisher's origin, so we
        // hand the browser `edgeHost` (real origin host:port) + a cluster-flagged pullToken.
        // standalone: publisher is already on the edge — no origin/pull, just C1 viewer auth.
        const crossPull = (env.ENTERPRISE_MODE || "crosspull").trim().toLowerCase() !== "standalone";
        const now = Math.floor(Date.now() / 1000);
        // watchToken authorizes the browser to subscribe to THIS broadcast on the edge; the
        // edge validates it against this tenant's PUBLIC verify_jwk (BYOK EdDSA). pullToken is
        // the edge's cluster-flagged pass to pull from the origin (root get:[''] scope, matching
        // the working cross-CDN edge pull; short-lived as it's browser-couriered). If BYOK isn't
        // configured we can't mint → fall through to B/A.
        const watchToken = await tryMintMoqToken(env, {
          put: [],
          get: [broadcastName(streamId)],
          exp: now + VIEWER_TOKEN_TTL,
        });
        const pullToken = crossPull
          ? await tryMintMoqToken(env, { put: [], get: [""], cluster: true, exp: now + ENTERPRISE_PULL_TOKEN_TTL })
          : null;
        if (watchToken && (!crossPull || pullToken)) {
          // Link-held keys: nothing to release here. Kept as constants so the response shape below is unchanged.
          const encrypted = true;
          const contentKey = null;
          console.log(
            `[route] mode=C enterprise(${crossPull ? "crosspull" : "standalone"}) asn=${asn} ` +
            `org=${JSON.stringify(asOrg)} relay=${ent.localRelayHost}` +
            (crossPull ? ` edge=${ent.edgeHost}` : ``) + ` stream=${streamId}`
          );
          return Response.json({
            mode: "enterprise",
            relay: ent.localRelayHost,
            broadcast: broadcastName(streamId),
            watchToken,
            // A/B-compatible alias so any older player still finds jwt.
            jwt: watchToken,
            // cross-pull legs (omitted in standalone): origin to pull from + the pull pass.
            ...(crossPull ? { edgeHost: ent.edgeHost, pullToken } : {}),
            encrypted,
            content_key: contentKey,
          });
        }
        console.warn("[route] enterprise matched but BYOK token mint unavailable; falling back to B/A");
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // Resolve the relay the viewer will actually connect to. For a cross-cluster viewer
    // that's a fresh edge (with its OWN per-stream key); otherwise the publisher's relay.
    // The viewer token must be signed with THAT relay's key (managed mode).
    let relay = current;
    const viewerCdn = url.searchParams.get("viewer-cdn");
    if (viewerCdn && viewerCdn !== current.host) {
      // Cross-cluster: assign an edge on the viewer's cluster that pulls from the
      // publisher's CURRENT relay. Explicit ?origin= test override wins.
      const forcedOrigin = url.searchParams.get("origin");
      const origin = forcedOrigin ?? `${current.host}:${current.port}`;
      // Viewer transport hint (?xport=): forwarded verbatim onto the edge's /assign so the
      // origin->edge hop can use iroh/DHT instead of host:port. Only the edge pull honors it.
      const xport = url.searchParams.get("xport");
      // Subscribe-scoped, cluster-flagged token so the edge can authenticate its pull
      // from the origin. Signed with OUR key via the SAME signer used for viewer tokens
      // (BYOK EdDSA when configured) — the autoscaler can't mint this, and a different
      // signer would produce tokens the deployed relay rejects. Broad get:[''] (root)
      // scope so the edge can pull whatever subtree the origin advertises for the pull.
      const pullToken = await tryMintMoqToken(env, {
        put: [],
        get: [""],
        cluster: true,
        exp: Math.floor(Date.now() / 1000) + PULL_TOKEN_TTL,
      });
      const edge = await assignRelay(env, streamId, viewerCdn, origin, env.TINYMOQ_PROVISION_KEY, pullToken, xport, request);
      if (!edge) return new Response("offline", { status: 404 });
      relay = edge;
    }

    // Viewer token: subscribe-only to THIS broadcast (put:[] => cannot publish/hijack).
    const viewerJwt = await tryMintMoqToken(env, {
      put: [],
      get: [broadcastName(streamId)],
      exp: Math.floor(Date.now() / 1000) + VIEWER_TOKEN_TTL,
    }, relay.key);

    // Relay-blind E2E: hand the per-broadcast content key to authorized viewers
    // (auth-gated streams require a session; see viewerContentKey).
    // Link-held keys: nothing to release here. Kept as constants so the response shape below is unchanged.
          const encrypted = true;
          const contentKey = null;

    // Which mode resolved: B = cross-cluster edge, A = publisher origin relay.
    const mode = relay === current ? "A" : "B";
    console.log(`[route] mode=${mode} ${mode === "B" ? "edge" : "origin"} asn=${asn} stream=${streamId} relay=${relay.host}:${relay.port}`);

    return Response.json({
      relay: `${relay.host}:${relay.port}`,
      jwt: viewerJwt,
      encrypted,
      content_key: contentKey,
    });
  }

  // POST /api/streams - Create or update stream settings (publisher claim required)
  //
  // WHAT THIS USED TO SAY: "requires auth", on the strength of the getAuthenticatedUser check
  // below. That check cannot fail. With OAuth off getAuthenticatedUser returns ANON_USER
  // unconditionally, so the 401 was unreachable and the endpoint accepted a write for ANY
  // stream id from anyone on the internet, with no credential at all. Verified against
  // production before this fix: POST {} returned 400 "stream_id required", i.e. it had already
  // passed the "authentication" step. Exactly the failure the admission check on
  // /api/stats/broadcast carries a warning about — a gate that reads as a gate and is not one.
  //
  // These settings are not cosmetic. overlay_html renders as markup and cross-origin iframes
  // in every viewer's browser, and require_auth decides who may watch, so an anonymous write
  // here reaches the audience of a stream the writer does not own.
  //
  // Gated the way this codebase actually identifies a publisher — admission credential plus a
  // signed claim over a fresh challenge — NOT by user identity. Porting vivoh.earth's
  // `current.user_id !== user.id` check would have been worse than useless here: every caller
  // is the same ANON_USER, so that comparison always passes while looking like protection.
  if (method === "POST" && path === "/api/streams") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await request.json() as {
      stream_id: string;
      require_auth?: boolean;
      overlay_html?: string;
      link_enc?: string;
      encrypted?: boolean;
      chat_enabled?: boolean;
      publish_key?: string;
      pubkey?: string;
      challenge?: string;
      signature?: string;
    };
    if (!body.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    // ── 1. Admission: may you publish at all? ────────────────────────────────────────
    const admission = await admissionVerdict(env, body.publish_key);
    if (!admission.ok) {
      const unconfigured = admission.reason.includes("not configured");
      return Response.json({ error: admission.reason }, { status: unconfigured ? 503 : 403 });
    }

    // ── 2. Ownership: is this broadcast name yours? ──────────────────────────────────
    // Same three steps as go-live. The challenge is single-use and short-lived, so a captured
    // signature cannot be replayed; the signature proves possession of the private half of the
    // key that named this broadcast.
    if (!body.pubkey || !body.challenge || !body.signature) {
      return Response.json({ error: "signed claim required" }, { status: 400 });
    }
    if (!(await challengeIsValid(env, body.challenge))) {
      return Response.json({ error: "challenge expired or invalid" }, { status: 403 });
    }
    if (!(await claimIsValid(body.pubkey, body.stream_id, body.challenge, body.signature))) {
      return Response.json({ error: "claim signature does not verify" }, { status: 403 });
    }
    // While a broadcast is LIVE under this name, only the publisher who started it may change
    // its settings — that is the case that reaches an audience.
    //
    // KNOWN RESIDUAL, stated rather than hidden: when nothing is live under this id,
    // nameIsAvailable returns true, so any holder of a valid publish key can write settings
    // for an unused id. That is deliberate — settings are edited before go-live, when no
    // broadcast row exists yet to own them — and it is a far smaller surface than before,
    // since it now takes an admission credential rather than nothing at all. Closing it fully
    // means persisting an owning pubkey on the streams row, which the per-broadcast keypair
    // design makes a larger change than it looks.
    if (!(await nameIsAvailable(env, body.stream_id, body.pubkey))) {
      return Response.json({ error: "that broadcast name is in use" }, { status: 409 });
    }

    // Get current settings first
    const current = await env.DB
      .prepare("SELECT require_auth, overlay_html, link_enc, encrypted, chat_enabled FROM streams WHERE stream_id = ?")
      .bind(body.stream_id)
      .first<{ require_auth: number; overlay_html: string | null; link_enc: string | null; encrypted: number; chat_enabled: number }>();

    const requireAuth = body.require_auth !== undefined ? body.require_auth : (current?.require_auth === 1);
    const overlayHtml = body.overlay_html !== undefined ? body.overlay_html : (current?.overlay_html || "");
    const isEncrypted = body.encrypted !== undefined ? body.encrypted : (current?.encrypted === 1);
    const chatEnabled = body.chat_enabled !== undefined ? body.chat_enabled : (current?.chat_enabled === 1);

    // Opaque to us by design (see the 0017 migration), which means it cannot be validated on
    // content — a length bound is the only check available, and it is the one that matters:
    // without it this column is a free write-anything-sized blob store. A sealed URL runs to a
    // few hundred bytes, so 2 KB is generous and still bounded.
    const linkEnc = body.link_enc !== undefined ? body.link_enc : (current?.link_enc || "");
    if (typeof linkEnc !== "string" || linkEnc.length > 2048) {
      return Response.json({ error: "link_enc too large" }, { status: 400 });
    }

    // Upsert stream settings
    await env.DB
      .prepare(`
        INSERT INTO streams (stream_id, user_id, require_auth, overlay_html, link_enc, encrypted, chat_enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stream_id) DO UPDATE SET
          require_auth = excluded.require_auth,
          overlay_html = excluded.overlay_html,
          link_enc = excluded.link_enc,
          encrypted = excluded.encrypted,
          chat_enabled = excluded.chat_enabled,
          updated_at = datetime('now')
      `)
      .bind(body.stream_id, user.id, requireAuth ? 1 : 0, overlayHtml, linkEnc, isEncrypted ? 1 : 0, chatEnabled ? 1 : 0)
      .run();

    return Response.json({
      stream_id: body.stream_id,
      require_auth: requireAuth,
      overlay_html: overlayHtml,
      link_enc: linkEnc,
      encrypted: isEncrypted,
      chat_enabled: chatEnabled,
    });
  }

  return new Response("Not Found", { status: 404 });
}

// Stats routes handler
// --- TinyMoQ fleet broadcast→relay routing -------------------------------
// "Get a relay" has TWO configurable paths (FLEET_MODE); both return a host:port the
// browser connects to, and both keep BYOK token signing (only the endpoint + credential
// differ, so switching paths is config, not code):
//   - direct (Path 1):   the Worker calls a relay box's /assign itself (GET, keyed by the
//                         full broadcast name), authed by the provisioning bearer. The box
//                         is its own sticky/idempotent autoscaler; publisher-cdn/viewer-cdn
//                         override per-request within the fleet domain; viewers co-locate
//                         via relay_host.
//   - brokered (Path 2): the Worker POSTs {broadcast} to a CDN operator's broker (the
//                         FLEET_ENDPOINT assign URL), which selects a box and returns
//                         {relay}. moqplay never sees box topology and holds NO box bearer —
//                         it authenticates with the operator-issued CUSTOMER token
//                         (env.CDN_API_TOKEN). The box bearer (TINYMOQ_PROVISION_KEY) stays
//                         with the broker and must never be set on a brokered moqplay.
// Endpoint = env.FLEET_ENDPOINT; credential = TINYMOQ_PROVISION_KEY (direct) / CDN_API_TOKEN (brokered).
//
// NOTE: there is no static relay fallback. The autoscaler endpoint is a control API (TCP),
// not a MoQ relay — UDP/443 has no media listener. Every media connection must use a
// dynamic host:port from /assign or /route (relays advertise as <box>.<fleet-domain>:<port>).
const FALLBACK_FLEET_ENDPOINT = "https://cdn.gpcmoq.com";

// FLEET_ENDPOINT may be a single base URL or a comma/whitespace-separated LIST of them.
// The FIRST is the default (used for the default box, brokered assign/release, and any
// request without an override). Every host in the list — and its registrable-domain
// siblings — is an allowed override target for ?publisher-cdn / ?viewer-cdn / cross-cluster
// origin (see isFleetHost). This lets one deployment span multiple fleets on different
// domains (e.g. ams.moqcdn.net default + ams.gpcmoq.com override) with no code change.
function fleetEndpoints(env: Env): string[] {
  const list = (env.FLEET_ENDPOINT || FALLBACK_FLEET_ENDPOINT)
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length ? list : [FALLBACK_FLEET_ENDPOINT];
}

// The default fleet base URL for this deployment (first in the list; no trailing slash).
function fleetEndpoint(env: Env): string {
  return fleetEndpoints(env)[0];
}

// Which "get a relay" path this deployment uses (see FLEET_MODE). Default direct.
function fleetMode(env: Env): "direct" | "brokered" {
  return (env.FLEET_MODE || "").trim().toLowerCase() === "brokered" ? "brokered" : "direct";
}

// The configured fleet's autoscaler hostname (e.g. cdn.tinymoq.com).
function fleetHost(env: Env): string {
  try {
    return new URL(fleetEndpoint(env)).hostname.toLowerCase();
  } catch {
    return new URL(FALLBACK_FLEET_ENDPOINT).hostname;
  }
}

// SSRF guard for user-supplied hosts (publisher-cdn / viewer-cdn / cross-cluster origin):
// allow only the configured fleet host and sibling boxes under its registrable domain
// (e.g. usw.<fleet-domain>), so multi-box fleets work without a code change while a
// stray/hostile value can't redirect the Worker's /assign fetch off-fleet.
function isFleetHost(env: Env, host: string): boolean {
  const h = host.toLowerCase();
  // Allowed if it matches ANY configured fleet endpoint's host, or a sibling box under
  // that endpoint's registrable domain (e.g. usw.<fleet-domain>).
  for (const ep of fleetEndpoints(env)) {
    let fh: string;
    try { fh = new URL(ep).hostname.toLowerCase(); } catch { continue; }
    if (h === fh) return true;
    const parent = fh.split(".").slice(-2).join("."); // e.g. moqcdn.net
    if (parent.includes(".") && (h === parent || h.endsWith("." + parent))) return true;
  }
  return false;
}

function broadcastName(streamId: string): string {
  return `moqplay.com/${streamId}.hang`;
}

// Relay-blind E2E: decide whether to hand the per-broadcast content key to this viewer.
// The key gates DECRYPTION (the JWT only gates the connection). Auth-required encrypted
// streams release the key only to a signed-in caller (fail-closed); non-auth encrypted
// streams release to anyone (encryption there only blinds the relay). Shared by every
// viewer-route mode (A/B/C) so the policy can't drift between them.
async function viewerContentKey(
  request: Request,
  env: Env,
  streamId: string,
  rowContentKey: string | null
): Promise<{ encrypted: boolean; contentKey: string | null }> {
  if (!rowContentKey) return { encrypted: false, contentKey: null };
  const stream = await env.DB
    .prepare("SELECT require_auth FROM streams WHERE stream_id = ?")
    .bind(streamId)
    .first<{ require_auth: number }>();
  if (stream?.require_auth === 1) {
    const viewer = await getAuthenticatedUser(request, env);
    return { encrypted: true, contentKey: viewer ? rowContentKey : null };
  }
  return { encrypted: true, contentKey: rowContentKey };
}

// Mode C (Enterprise) — WORKER-DRIVEN steering rule. The Worker decides locally (from its
// own config, NOT the broker or an external resolve API) whether to steer this viewer to a
// dedicated edge. When ENTERPRISE_EDGE_HOST is set, matching viewers are steered there; the
// browser couriers the BYOK watch token to that edge's /assign (validated against this
// tenant's verify_jwk — box-side C1), and the edge cluster-pulls the broadcast from `edgeHost`
// (the publisher's CURRENT relay, which we already resolved) using the BYOK pull token. The
// match rule is: feature on (host set) AND (no ASN allow-list, or this viewer's ASN is in it).
// Returns null = no steering (fall through to brokered B/A); never hard-fails a viewer.
function enterpriseEdge(
  env: Env,
  asn: number,
  origin: { host: string; port: number }
): { localRelayHost: string; edgeHost: string; name: string } | null {
  const host = (env.ENTERPRISE_EDGE_HOST || "").trim();
  if (!host) return null; // feature off
  const asnList = (env.ENTERPRISE_ASNS || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (asnList.length > 0 && !asnList.includes(asn)) return null; // gated, not this network
  return { localRelayHost: host, edgeHost: `${origin.host}:${origin.port}`, name: host };
}

// Generate a fresh 256-bit content encryption key (base64url, unpadded) for a
// broadcast session. Distinct from any relay/JWT secret; only ever sent to the
// publisher and authorized viewers over TLS, never to the relay.
function generateContentKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── moq.pro assignment (Mode A) ─────────────────────────────────────────────────
// When MOQ_PRO_K is set the app streams through Luke Curley's hosted CDN instead of the
// self-hosted fleet. There is no /assign: the relay is always cdn.moq.pro, the broadcast
// path is `<root>/<streamId>.hang`, and the Worker mints a short-lived HS256 token scoped
// to THAT stream (moq.pro accepts put/get of ["<streamId>.hang"]). "publish" gets put+get;
// "watch" gets get only. Returns null when unconfigured → callers use the fleet path.
const MOQ_PRO_RELAY = "cdn.moq.pro";
async function moqProAssign(
  env: Env,
  streamId: string,
  role: "publish" | "watch",
  ttlSeconds: number
): Promise<{ relay: string; path: string; jwt: string } | null> {
  // Prefer the asymmetric key. moq.pro holds only its public half, so it can verify our
  // tokens and cannot mint one; MOQ_PRO_K is the legacy symmetric secret that the CDN also
  // holds, kept as a fallback so unsetting the JWK restores the previous behaviour.
  const jwk = env.MOQ_PRO_JWK;
  const k = env.MOQ_PRO_K;
  if (!jwk && !k) return null;
  const root = env.MOQ_PRO_ROOT || "erik";
  const sub = `${streamId}.hang`;
  const claims = {
    root,
    put: role === "publish" ? [sub] : [],
    get: [sub],
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const jwt = jwk
    ? await mintMoqProTokenEd25519(jwk, claims, env.MOQ_PRO_KID)
    : await mintMoqProToken(k as string, claims);
  return { relay: MOQ_PRO_RELAY, path: `${root}/${sub}`, jwt };
}

// Resolve the autoscaler base URL, honoring an optional per-request CDN override
// (a specific box within the fleet). Only hosts on the configured fleet's domain are
// allowed — this guards the Worker's fetch against SSRF via user input.
function autoscalerBase(env: Env, cdnHost?: string | null): string {
  if (cdnHost && isFleetHost(env, cdnHost)) {
    return `https://${cdnHost}`;
  }
  return fleetEndpoint(env);
}

// A fleet relay origin "host:port" (the publisher's relay), for cross-cluster pulls.
// The host must be on the configured fleet's domain.
function isValidOrigin(env: Env, origin: string): boolean {
  const m = /^([a-z0-9.-]+):(\d+)$/i.exec(origin);
  return !!m && isFleetHost(env, m[1]);
}

// fetchOriginEndpointId lived here. Its only caller was /api/publish, which needed the
// origin's 64-hex iroh EndpointId to put in a DHT record. The brokered path addresses the
// origin as host:port and never needs it.

// Pick the box for a publisher. Currently the configured fleet's autoscaler host (single
// entry point); a future geo-router can return a sibling box under the same fleet domain
// without touching callers. Viewers co-locate on the publisher's box (relay_host).
function nearestBox(env: Env): string {
  return fleetHost(env);
}

// Ask the autoscaler for the relay hosting this broadcast (spawns/sticks as needed).
// When the viewer's cluster differs from the publisher's, pass `origin` (the
// publisher's relay host:port) so the assigned edge relay pulls the stream across
// clusters. Returns null if /assign is unavailable — there is NO static fallback.
// The /assign response is dual-mode (cutover-safe):
//   bare text  "host:port"                         -> sign tokens with the tenant key
//   JSON  {"relay":"host:port","key":<b64url|null>,"byok":<bool>}
//     - managed:  key is the per-stream HMAC secret -> sign THIS broadcast with `key`
//     - BYOK:     key is null + byok true            -> Worker signs its own EdDSA token
// /assign is sticky; in managed mode a reap/respawn yields a new key, so do NOT cache
// the key — sign on demand with whatever this call returned.
// Additive broker hints derived from the incoming browser request — today just the viewer's
// Cloudflare geo. The broker routes to the geo-nearest healthy fleet, but on a Worker->Worker
// subrequest it can't see the viewer; only WE can, from request.cf. Send geo ONLY when lat/lon
// are present and finite (both are absent under local `wrangler dev`). Purely additive: the
// broker falls back to its own edge geo when this is missing.
function brokerHints(req?: Request): Record<string, unknown> | undefined {
  if (!req) return undefined;
  // Test override: ?geo=<lat>,<lon> on the request forces the viewer location the broker
  // sees, so the full browser->Worker->broker routing can be exercised from anywhere with no
  // VPN. Takes precedence over request.cf when both are present.
  try {
    const g = new URL(req.url).searchParams.get("geo");
    if (g) {
      const [aS, bS] = g.split(",");
      const lat = Number(aS);
      const lon = Number(bS);
      if (aS !== "" && bS != null && Number.isFinite(lat) && Number.isFinite(lon)) {
        return { geo: { lat, lon, country: "TEST", colo: "TEST" } };
      }
    }
  } catch {
    // malformed URL — fall through to the real cf geo
  }
  const cf = (req as (Request & { cf?: IncomingRequestCfProperties }) | undefined)?.cf;
  if (!cf) return undefined;
  // Require the coords to be PRESENT before parsing: Number("") is 0 (finite), so an empty
  // string would otherwise send bogus null-island {0,0}. A real "0" (equator) still passes.
  const rawLat = cf.latitude;
  const rawLon = cf.longitude;
  if (rawLat == null || rawLon == null || rawLat === "" || rawLon === "") return undefined;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return { geo: { lat, lon, country: cf.country, colo: cf.colo } };
}

async function assignRelay(
  env: Env,
  streamId: string,
  cdnHost?: string | null,
  origin?: string | null,
  provisionKey?: string | null,
  pull?: string | null,
  xport?: string | null,
  req?: Request
): Promise<{ host: string; port: number; key?: string } | null> {
  const name = broadcastName(streamId);
  // Path 2 (brokered): hand the broadcast to the operator and let it pick the box. The
  // cdnHost/origin/pull overrides are direct-mode (self-selected box) concerns and don't
  // apply — the operator owns topology. We DO forward the viewer's geo (from req.cf) so the
  // broker can pick the geo-nearest fleet.
  if (fleetMode(env) === "brokered") {
    return assignViaBroker(env, name, req);
  }
  const base = autoscalerBase(env, cdnHost);
  let query = `broadcast=${encodeURIComponent(name)}`;
  // An origin can be a fleet host:port (cross-cluster QUIC pull) OR — when xport=iroh — a
  // 64-hex iroh EndpointId the edge dials by key (watch-by-pubkey). The EID form is not a
  // URL and the Worker never fetches it (the box dials it over iroh), so it needs no
  // isFleetHost/SSRF gate; a strict 64-hex shape check is the whole validation.
  const isEidOrigin = !!origin && xport === "iroh" && /^[0-9a-f]{64}$/i.test(origin);
  if (origin && (isValidOrigin(env, origin) || isEidOrigin)) {
    query += `&origin=${encodeURIComponent(origin)}`;
    // Both origin flavors' pull legs are token-gated now: a cross-cluster host:port pull uses
    // a cluster-flagged subscribe token, and a gated iroh EID origin needs a subscribe token
    // on its pull-listener too (it is no longer open-pull). Forward whatever the caller minted.
    if (pull) query += `&pull=${encodeURIComponent(pull)}`;
  }
  // Transport hint forwarded verbatim from the viewer's ?xport= (same contract as the Mode C
  // preflight): xport=iroh makes the edge pull from the origin over iroh/DHT; absent/other =
  // host:port. Pure hint — no token/auth change — so append it as-is when present.
  if (xport) query += `&xport=${encodeURIComponent(xport)}`;
  try {
    const res = await fetch(`${base}/assign?${query}`, { headers: provisionHeaders(provisionKey) });
    if (res.ok) {
      const text = (await res.text()).trim();
      let relayStr = text; // e.g. "usw.gpcmoq.com:8000"
      let key: string | undefined;
      // Per-stream / BYOK mode returns JSON; shared mode returns a bare "host:port".
      if (text.startsWith("{")) {
        try {
          const obj = JSON.parse(text) as { relay?: string; key?: string | null };
          if (obj.relay) relayStr = String(obj.relay).trim();
          if (obj.key) key = String(obj.key); // null in BYOK mode — left undefined
        } catch {
          console.warn("assignRelay: /assign returned non-JSON starting with '{'");
        }
      }
      const [host, portStr] = relayStr.split(":");
      const port = parseInt(portStr, 10);
      if (host && Number.isFinite(port)) {
        return { host, port, key };
      }
    }
    console.warn("assignRelay: unexpected /assign response", res.status);
  } catch (e) {
    console.warn("assignRelay: /assign failed", e);
  }
  return null;
}

// Path 2 (brokered): POST {broadcast} to the operator's broker; it selects a box and
// returns {relay:"host:port"}. No per-stream key (BYOK — moqplay signs the viewer/publisher
// token itself), no topology and no cdnHost/origin overrides (the operator owns box
// selection). `credential` is the operator-issued customer token, sent as a bearer.
async function assignViaBroker(
  env: Env,
  broadcast: string,
  req?: Request,
  // Watch-by-pubkey edge placement (node path): the broker accepts a bare iroh EID `origin`
  // + a `pull` token + `xport`, geo-picks the viewer's nearest box, and — if that box isn't
  // the origin's — inserts the edge->origin iroh pull itself. Omitted for the plain fleet
  // assign (origin placement), where the broker chooses freely.
  opts?: { origin?: string | null; pull?: string | null; xport?: string | null }
): Promise<{ host: string; port: number; key?: string } | null> {
  // FLEET_ENDPOINT IS the broker's full assign URL in brokered mode. Credential is the
  // operator-issued CUSTOMER token (CDN_API_TOKEN) — never the box bearer.
  const assignUrl = fleetEndpoint(env);
  const hints = brokerHints(req);
  const body: Record<string, unknown> = { broadcast };
  if (opts?.origin) body.origin = opts.origin; // bare iroh EID the edge pulls from
  if (opts?.pull) body.pull = opts.pull; // subscribe token the broker forwards to the edge
  if (opts?.xport) body.xport = opts.xport; // e.g. "iroh" — origin->edge transport
  if (hints) body.hints = hints; // additive: viewer geo for geo-nearest fleet routing
  try {
    const res = await fetch(assignUrl, {
      method: "POST",
      headers: { ...provisionHeaders(env.CDN_API_TOKEN), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    let data: { relay?: string; box?: string; reason?: string; tried?: unknown } = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    // Diagnostic: log the request (broadcast + hints.geo) and the broker's full response —
    // the `box`/`reason`/`tried` fields we otherwise ignore — so the app tail lines up with
    // the broker's own trace when chasing geo-routing. Redact the pull token (a bearer JWT)
    // so it never lands in the tail.
    const logBody = body.pull ? { ...body, pull: "<token>" } : body;
    console.log(
      `[broker] assign ${res.status} req=${JSON.stringify(logBody)} resp=${JSON.stringify({
        relay: data.relay,
        box: data.box,
        reason: data.reason,
        tried: data.tried,
      })}`
    );
    if (res.ok) {
      const [host, portStr] = String(data.relay ?? "").split(":");
      const port = parseInt(portStr, 10);
      if (host && Number.isFinite(port)) return { host, port };
    }
    console.warn("assignViaBroker: unexpected broker response", res.status);
  } catch (e) {
    console.warn("assignViaBroker: broker assign failed", e);
  }
  return null;
}

// Free the relay route when a broadcast ends so the node can be scaled down. Direct mode
// releases the box it assigned (the stored relay_host); brokered mode tells the operator,
// which owns the box lifecycle.
async function releaseRelay(env: Env, streamId: string, cdnHost?: string | null, provisionKey?: string | null): Promise<void> {
  const name = broadcastName(streamId);
  if (fleetMode(env) === "brokered") {
    // Derive the release URL from the assign URL (…/assign → …/release). If FLEET_ENDPOINT
    // doesn't end in /assign we can't derive it — skip and let the operator reap the box.
    const assignUrl = fleetEndpoint(env);
    if (!/assign\/?$/.test(assignUrl)) return;
    const releaseUrl = assignUrl.replace(/assign(\/?)$/, "release$1");
    try {
      await fetch(releaseUrl, {
        method: "POST",
        headers: { ...provisionHeaders(env.CDN_API_TOKEN), "content-type": "application/json" },
        body: JSON.stringify({ broadcast: name }),
      });
    } catch (e) {
      console.warn("releaseRelay(brokered): broker release failed", e);
    }
    return;
  }
  const base = autoscalerBase(env, cdnHost);
  try {
    await fetch(`${base}/release?broadcast=${encodeURIComponent(name)}`, { headers: provisionHeaders(provisionKey) });
  } catch (e) {
    console.warn("releaseRelay: /release failed", e);
  }
}

// Authenticate the Worker to TinyMoQ's provisioning API (/assign, /release) with an
// opaque bearer that also identifies the tenant. Omitted when the key isn't set so
// deploys are safe before the operator runs `wrangler secret put TINYMOQ_PROVISION_KEY`.
function provisionHeaders(provisionKey?: string | null): HeadersInit {
  return provisionKey ? { Authorization: `Bearer ${provisionKey}` } : {};
}

// Token lifetimes (seconds). Generous until a refresh loop exists, so long broadcasts /
// long views aren't dropped mid-stream.
const PUBLISHER_TOKEN_TTL = 12 * 60 * 60; // 12h
// The viewer token lifetime on EVERY path. Long, and deliberately so — see below.
const VIEWER_TOKEN_TTL = 6 * 60 * 60; // 6h
//
// ── Why there is no longer a short, renewed viewer token ──────────────────────────────────
//
// There used to be a 120s TTL on the moq.pro path with the client renewing through this
// Worker, so that a killed stream stopped even for a client ignoring the `killed` flag: no
// renewal, and the relay drops the session within one token lifetime.
//
// That bought enforcement against ONE adversary — a viewer running a modified client during
// an abuse incident — and modified clients are no longer a supported case. Meanwhile it cost
// every legitimate viewer a reconnect every 90 seconds, and on Safari/iOS that reconnect
// rebuilt the AudioContext with no user gesture behind it, so it came back suspended and the
// stream went silent. Measured, at length, on 2026-08-17.
//
// Be exact about what was given up, because a page says so: termination is now enforced by
// the client honouring the kill signal — every supported client does, within about 5s, with
// the transport closed (scripts/e2e/kill-transport-close.mjs). It is NOT enforced against a
// client modified to ignore it; such a viewer keeps receiving until this token lapses.
//
// Restoring the old behaviour means lowering this constant AND rebuilding the renewal loop in
// main.ts, which no longer exists. Read the audio history first: five attempts failed to make
// that reconnect survivable on Safari, and three of them broke working audio.
// Cross-cluster pull token (edge relay -> origin). Matches the viewer TTL so a long
// broadcast's edge pull isn't dropped mid-stream (the moq-token-cli example used 1h).
// SERVER-HELD only (Mode B): never leaves the Worker/relay, so a long TTL is safe.
const PULL_TOKEN_TTL = 6 * 60 * 60; // 6h
// Mode C (Enterprise) pull token is BROWSER-HELD: the viewer's browser carries a
// root-scoped, cluster:true token to the local relay. Same broad scope as Mode B (must
// match the proven cross-cluster pull), but in an end-user's hands it could act as a
// cluster node — so containment is a TIGHT expiry, not scope. Keep it to minutes.
// NOTE (box-side, being validated): if the local relay needs the pass valid for the
// whole pull session rather than just to establish it, bump this — it's the one knob.
const ENTERPRISE_PULL_TOKEN_TTL = 5 * 60; // 5 min

// Mint a per-broadcast token, config-driven and guarded (returns null instead of throwing
// so the endpoint still works). BYOK: sign EdDSA with the tenant's private key when set.
// Managed: else sign HS256 with the per-stream `streamKey` from /assign. Neither => null.
async function tryMintMoqToken(env: Env, claims: MoqClaims, streamKey?: string | null): Promise<string | null> {
  try {
    if (env.MOQ_AUTH_PRIVATE_JWK) return await mintEd25519Token(env.MOQ_AUTH_PRIVATE_JWK, claims);
    if (streamKey) return await mintHs256Token(streamKey, claims);
    console.warn("[moq-token] no signing material (no BYOK key, no per-stream key); no token");
    return null;
  } catch (e) {
    console.error("[moq-token] mint failed", e);
    return null;
  }
}

// --- Viewing sessions -------------------------------------------------------------------
//
// How often a watching client says "still here". Browsers throttle background timers to
// roughly one per minute, so this has to stay well under SESSION_STALE_SECONDS or a viewer
// who switches tabs gets reaped while still watching.
const SESSION_HEARTBEAT_SECONDS = 30;

// Silence after which the reaper closes a session. Deliberately several missed beats: a
// dropped heartbeat is normal on mobile, and closing early under-reports real viewing.
const SESSION_STALE_SECONDS = 150;

// "Currently watching", computed without trusting the reaper to have run recently.
//
// COALESCE onto started_at is what excludes the pre-0014 ghosts: rows opened before
// heartbeats existed have no last_seen_at and would otherwise count forever. New rows always
// carry one from the moment they are inserted.
const liveSessionSql = (t = "") =>
  `${t}ended_at IS NULL AND COALESCE(${t}last_seen_at, ${t}started_at) > datetime('now', '-${SESSION_STALE_SECONDS} seconds')`;

/** Unqualified form, for single-table queries. */
const LIVE_SESSION_SQL = liveSessionSql();

// A session we never measured: closed by the reaper with no heartbeat to close it at, which
// can only be a row created before migration 0014. Real, but of unknown length.
const UNMEASURED_SQL = `end_reason = 'unmeasured'`;

// A finished session whose length we actually observed — the only kind worth averaging.
const MEASURED_SQL = `ended_at IS NOT NULL AND COALESCE(end_reason, '') <> 'unmeasured'`;

/**
 * Parse a JSON body that may have arrived via sendBeacon.
 *
 * sendBeacon sends a Blob, and the only content type it can send without turning the request
 * into a CORS preflight is text/plain — so the page-close path cannot use request.json().
 * Tolerant on purpose: a body we cannot parse is a request we answer, not one we 500 on.
 */
async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

/** Advance a session's heartbeat. False when it does not exist, is closed, or the token is wrong. */
async function touchSession(env: Env, id: number, token: string): Promise<boolean> {
  if (!Number.isFinite(id) || !token) return false;
  const row = await env.DB
    .prepare("SELECT session_hash FROM watch_events WHERE id = ? AND ended_at IS NULL")
    .bind(id)
    .first<{ session_hash: string | null }>();
  if (!row?.session_hash) return false;
  if (!constantTimeEqual(await sha256b64url(token), row.session_hash)) return false;

  await env.DB
    .prepare("UPDATE watch_events SET last_seen_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  return true;
}

/**
 * Close sessions whose heartbeat stopped, and optionally forget old ones.
 *
 * Closing uses last_seen_at rather than the current time: a viewer whose laptop lid closed
 * should be credited with the viewing we actually observed, not with the hours until the
 * next cron tick. Anything with no heartbeat at all (pre-0014) is closed at started_at,
 * which credits it with nothing — the honest answer for a row we never measured.
 *
 * Retention is opt-in via STATS_RETENTION_DAYS. Unset means keep everything, because the
 * point of this table is to be reportable. Setting it is worth considering anyway: session
 * rows are timestamps against stream ids, and the safest audience record is the one that is
 * no longer there to be compelled.
 */
async function reapSessions(env: Env): Promise<{ closed: number; purged: number }> {
  // 'unmeasured' vs 'reaped' matters to every average computed downstream. A row with no
  // heartbeat at all predates migration 0014: we know it existed and nothing else, so closing
  // it at started_at credits zero. That is the honest number to store and a lie to average —
  // it is not a viewer who watched for no time, it is a session we never measured. Marking
  // the two apart is what lets reports exclude the second kind. New rows always carry a
  // heartbeat from insert, so 'unmeasured' can only ever describe the legacy backlog.
  const closed = await env.DB
    .prepare(
      `UPDATE watch_events
          SET ended_at = COALESCE(last_seen_at, started_at),
              end_reason = CASE WHEN last_seen_at IS NULL THEN 'unmeasured' ELSE 'reaped' END
        WHERE ended_at IS NULL
          AND COALESCE(last_seen_at, started_at) <= datetime('now', '-${SESSION_STALE_SECONDS} seconds')`
    )
    .run();

  let purged = 0;
  const days = parseInt(env.STATS_RETENTION_DAYS ?? "", 10);
  if (Number.isFinite(days) && days > 0) {
    const res = await env.DB
      .prepare(`DELETE FROM watch_events WHERE started_at < datetime('now', '-${days} days')`)
      .run();
    purged = res.meta?.changes ?? 0;
  }

  return { closed: closed.meta?.changes ?? 0, purged };
}

/**
 * Close broadcast rows that can no longer be broadcasting.
 *
 * The problem this solves: a row with `ended_at IS NULL` makes nameIsAvailable() refuse the
 * next go-live under that stream id with 409, and the claim keypair is deliberately lost on a
 * reload while the id survives in ?stream= — so the person locked out is almost always the
 * broadcaster themselves, permanently, for closing a tab. /end now goes out by sendBeacon,
 * which covers an orderly close; this covers a crash, a dead battery, a killed tab. When this
 * was written production held 131 such rows blocking 131 ids, the oldest 16 days old.
 *
 * There is no heartbeat on a broadcast, so staleness is bounded by the only fact available:
 * PUBLISHER_TOKEN_TTL. The publisher token minted at go-live expires after it, and the relay
 * stops accepting the publisher at that point, so a row older than its own token's lifetime
 * cannot still be publishing. That makes this provably unable to close a live broadcast,
 * which matters more here than closing stale rows promptly — a broadcaster cut off mid-stream
 * by our own housekeeping would be a far worse bug than the one being fixed. Anyone who hits
 * a 409 inside the window is offered a new link on the spot, which is the fast path out.
 *
 * Deliberately does NOT call releaseRelay(). A relay assignment tied to an expired publisher
 * token is already dead, and firing a release per row would put an unbounded burst of broker
 * calls inside a one-minute cron. Nothing is made worse: today none of these rows release
 * anything at all.
 */
async function reapBroadcasts(env: Env): Promise<number> {
  const res = await env.DB
    .prepare(
      `UPDATE broadcast_events
          SET ended_at = datetime('now')
        WHERE ended_at IS NULL
          AND started_at <= datetime('now', '-${PUBLISHER_TOKEN_TTL} seconds')`
    )
    .run();
  return res.meta?.changes ?? 0;
}

async function handleStatsRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // GET /api/stats/stream/:stream_id/viewers - Live sessions on one stream.
  //
  // Gated on the proof-of-link tag, like /route and the session open. Audience size is
  // metadata about a broadcaster — "how many people are watching this right now" is worth
  // knowing to someone deciding whether a journalist's stream matters — and before this it
  // was readable by anyone who guessed a five-character id. The broadcaster derives the tag
  // from the same link secret its viewers use, so it can still read its own badge.
  const streamViewersMatch = path.match(/^\/api\/stats\/stream\/([a-z0-9]{5})\/viewers$/);
  if (method === "GET" && streamViewersMatch) {
    const streamId = streamViewersMatch[1];

    // Only gate once a live broadcast has registered a tag. Nothing to protect before then:
    // with no live row there is no audience, and the badge must still render 0 while the
    // broadcaster is setting up.
    const live = await env.DB
      .prepare(
        "SELECT route_tag FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
      )
      .bind(streamId)
      .first<{ route_tag: string | null }>();
    if (live?.route_tag) {
      const presented = url.searchParams.get("tag") ?? "";
      if (!constantTimeEqual(presented, live.route_tag)) {
        return Response.json({ stream_id: streamId, viewers: [] }, { status: 404 });
      }
    }

    const viewers = await env.DB
      .prepare(`
        SELECT
          w.id, w.stream_id, w.started_at, w.last_seen_at,
          u.id as user_id, u.name as user_name, u.email as user_email, u.avatar_url
        FROM watch_events w
        LEFT JOIN users u ON w.user_id = u.id
        WHERE w.stream_id = ? AND ${liveSessionSql("w.")}
        ORDER BY w.started_at DESC
      `)
      .bind(streamId)
      .all();

    return Response.json({
      stream_id: streamId,
      viewers: viewers.results,
    });
  }

  // GET /api/stats/live - Get live broadcasts and viewers (requires auth)
  if (method === "GET" && path === "/api/stats/live") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    // Get active broadcasts (started but not ended)
    const broadcasts = await env.DB
      .prepare(`
        SELECT
          b.id, b.stream_id, b.started_at,
          u.id as user_id, u.name as user_name, u.email as user_email, u.avatar_url
        FROM broadcast_events b
        JOIN users u ON b.user_id = u.id
        WHERE b.ended_at IS NULL
        ORDER BY b.started_at DESC
      `)
      .all();

    // Get active viewers (started but not ended)
    const viewers = await env.DB
      .prepare(`
        SELECT
          w.id, w.stream_id, w.started_at,
          u.id as user_id, u.name as user_name, u.email as user_email, u.avatar_url
        FROM watch_events w
        LEFT JOIN users u ON w.user_id = u.id
        WHERE ${liveSessionSql("w.")}
        ORDER BY w.started_at DESC
      `)
      .all();

    return Response.json({
      broadcasts: broadcasts.results,
      viewers: viewers.results,
    });
  }

  // GET /api/publish/challenge - a short-lived nonce for a broadcaster to sign. Public: it
  // grants nothing on its own and is useless without the private half of a broadcast key.
  if (method === "GET" && path === "/api/publish/challenge") {
    const challenge = await mintChallenge(env);
    if (!challenge) {
      return Response.json({ error: "publisher authorization is not configured" }, { status: 503 });
    }
    return Response.json({ challenge, expires_in: CHALLENGE_TTL_SECONDS });
  }

  // POST /api/stats/broadcast - Start a broadcast
  if (method === "POST" && path === "/api/stats/broadcast") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await request.json() as {
      stream_id: string;
      publisher_cdn?: string;
      publish_key?: string;
      pubkey?: string;
      challenge?: string;
      signature?: string;
      // Proof-of-link tag for this broadcast, derived by the publisher from the link secret.
      // Independent of the content key by construction — see deriveRouteTag().
      route_tag?: string;
    };
    if (!body.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    // ── 1. Admission: may you publish at all? ────────────────────────────────────────
    // The shared PUBLISH_SECRET or a per-person code (see "Publish codes"). Fails CLOSED when
    // neither is configured. An earlier version of this check returned true unconditionally
    // while still being called, so the code read as though it gated something; the whole
    // endpoint was open to anyone who knew the URL.
    const admission = await admissionVerdict(env, body.publish_key);
    if (!admission.ok) {
      const unconfigured = admission.reason.includes("not configured");
      return Response.json({ error: admission.reason }, { status: unconfigured ? 503 : 403 });
    }

    // ── 2. Has this stream been terminated? ──────────────────────────────────────────
    // Checked BEFORE ownership so a killed stream always reports the real reason. Ordered
    // after admission so an unauthenticated caller cannot probe which names are killed.
    if (await streamIsKilled(env, body.stream_id)) {
      return Response.json({ error: "This stream has been terminated." }, { status: 403 });
    }

    // ── 3. Ownership: is this broadcast name yours? ──────────────────────────────────
    if (!body.pubkey || !body.challenge || !body.signature) {
      return Response.json({ error: "signed claim required" }, { status: 400 });
    }
    if (!(await challengeIsValid(env, body.challenge))) {
      return Response.json({ error: "challenge expired or invalid" }, { status: 403 });
    }
    if (!(await claimIsValid(body.pubkey, body.stream_id, body.challenge, body.signature))) {
      return Response.json({ error: "claim signature does not verify" }, { status: 403 });
    }
    if (!(await nameIsAvailable(env, body.stream_id, body.pubkey))) {
      // Someone else is mid-broadcast under this name. Without this, anyone holding a share
      // link could publish over the stream it points at.
      return Response.json({ error: "that broadcast name is in use" }, { status: 409 });
    }

    // ── 4. Resolve the public salt this broadcast derives with. ──────────────────────
    const saltInfo = await derivationSalt(env, body.stream_id, true);
    if (!saltInfo) {
      return Response.json({ error: "could not resolve stream salt" }, { status: 500 });
    }

    // Geo is resolved for the broadcaster's OWN "close to <city>" display and returned in
    // the response below. It is deliberately never persisted and never logged: coordinates
    // plus a timestamp identify a broadcaster far more precisely than an IP, and a VPN does
    // not hide them.
    const geo = getGeoFromRequest(request);

    // moq.pro (Mode A): when MOQ_PRO_K is set, publish through cdn.moq.pro instead of the
    // self-hosted fleet. No /assign — relay_host="cdn.moq.pro" marks the broadcast live
    // (viewers key off it in /route). Unset the secret to fall back to the fleet path below
    // (see rollback.md).
    //
    // Relay-blind E2E is MANDATORY and this Worker plays NO part in it. The content key is
    // derived in the broadcaster's browser from a secret that lives only in the share link's
    // `#…` fragment, which browsers never transmit. We therefore have nothing to mint, store,
    // or hand out: `encrypted` is always true and `content_key` is always null.
    //
    // This is the difference between not looking and not being able to. A subpoena, a rogue
    // employee, or a breach of this database yields no way to decrypt any broadcast, past or
    // present, because the material required never existed on this side.
    const mp = await moqProAssign(env, body.stream_id, "publish", PUBLISHER_TOKEN_TTL);
    if (mp) {
      const result = await env.DB
        .prepare(`
          INSERT INTO broadcast_events (user_id, stream_id, relay_host, relay_port, publisher_pubkey, route_tag)
          VALUES (?, ?, ?, ?, ?, ?)
          RETURNING id
        `)
        .bind(user.id, body.stream_id, mp.relay, null, body.pubkey, body.route_tag ?? null)
        .first<{ id: number }>();
      return Response.json({
        id: result?.id,
        stream_id: body.stream_id,
        geo,
        relay: mp.relay, // "cdn.moq.pro"
        path: mp.path,   // "<root>/<stream>.hang"
        jwt: mp.jwt,
        encrypted: true,
        content_key: null,
        // Public HKDF input. Viewers receive the identical value from /route, so both sides
        // derive the same key; rotating it re-keys the stream.
        salt: saltInfo.salt,
      });
    }

    // Ask the fleet autoscaler which relay to publish to (sticky per broadcast name).
    // Geo-route to the publisher's nearest box (usw/use/eu) unless an explicit
    // publisher_cdn override is given (testing). Viewers co-locate via relay_host.
    // No static fallback: if /assign is down, relay is null and the client retries.
    const publisherBox = body.publisher_cdn || nearestBox(env);
    const assigned = await assignRelay(env, body.stream_id, publisherBox, undefined, env.TINYMOQ_PROVISION_KEY, undefined, undefined, request);
    const relayHost = assigned?.host ?? null;
    const relayPort = assigned?.port ?? null;

    // The fleet path is now on link-held keys too, like Mode A above. It previously minted a
    // content key server-side and stored it on the broadcast row; that column no longer
    // exists, so leaving it would have thrown on every insert. The client derives the key
    // from the share link's #k= fragment regardless of which transport carried the stream,
    // so `encrypted: true` with no key is the correct answer on every path.
    //
    // Still unreachable in production (MOQ_PRO_K is set, so Mode A returns first) and still
    // unexercised end-to-end — but it no longer contradicts the guarantee.
    const encrypted = true;
    const contentKey = null;

    const result = await env.DB
      .prepare(`
        INSERT INTO broadcast_events (user_id, stream_id, relay_host, relay_port, publisher_pubkey)
        VALUES (?, ?, ?, ?, ?)
        RETURNING id
      `)
      .bind(user.id, body.stream_id, relayHost, relayPort, body.pubkey)
      .first<{ id: number }>();

    // Mint a publisher token scoped to THIS broadcast (publish + read acks on its own
    // path only). Owner/auth already enforced above; the relay enforces the scope.
    // Signed with the relay's per-stream key when /assign returned one (managed mode),
    // else with the tenant's BYOK Ed25519 key.
    const publisherJwt = assigned
      ? await tryMintMoqToken(env, {
          put: [broadcastName(body.stream_id)],
          get: [broadcastName(body.stream_id)],
          exp: Math.floor(Date.now() / 1000) + PUBLISHER_TOKEN_TTL,
        }, assigned.key)
      : null;

    return Response.json({
      id: result?.id,
      stream_id: body.stream_id,
      geo,
      relay: assigned ? `${relayHost}:${relayPort}` : null,
      jwt: publisherJwt,
      encrypted,
      content_key: contentKey,
    });
  }

  // POST /api/stats/broadcast/:id/end - End a broadcast
  const broadcastEndMatch = path.match(/^\/api\/stats\/broadcast\/(\d+)\/end$/);
  if (method === "POST" && broadcastEndMatch) {
    const eventId = parseInt(broadcastEndMatch[1]);

    // Look up the stream (and the CDN it was assigned on) to free the assignment.
    const row = await env.DB
      .prepare("SELECT stream_id, relay_host FROM broadcast_events WHERE id = ?")
      .bind(eventId)
      .first<{ stream_id: string; relay_host: string | null }>();

    await env.DB
      .prepare("UPDATE broadcast_events SET ended_at = datetime('now') WHERE id = ?")
      .bind(eventId)
      .run();

    if (row?.stream_id) {
      await releaseRelay(env, row.stream_id, row.relay_host, env.TINYMOQ_PROVISION_KEY);
    }

    return Response.json({ success: true });
  }

  // POST /api/stats/watch - Open a viewing session.
  //
  // Gated on the same proof-of-link tag as /route. Before this it was an unauthenticated
  // INSERT that accepted any five-character stream id, so anyone could manufacture audience
  // for a stream they had never been given — inflating a broadcaster's viewer badge, and
  // burning unbounded D1 writes for free. The tag makes it a capability: you can only open
  // a session on a broadcast whose link you already hold.
  //
  // Enforced only when the live broadcast registered a tag, matching /route exactly. An
  // attacker cannot choose whether the row carries one; only the broadcaster can.
  if (method === "POST" && path === "/api/stats/watch") {
    const user = await getAuthenticatedUser(request, env);

    const body = await readJsonBody<{ stream_id?: string; tag?: string }>(request);
    if (!body?.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    const live = await env.DB
      .prepare(
        "SELECT route_tag FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
      )
      .bind(body.stream_id)
      .first<{ route_tag: string | null }>();

    // 404 for both "not live" and "wrong tag", so a stranger sweeping ids cannot use this
    // endpoint to discover which ones are broadcasting — the same reasoning as /route.
    if (!live) return new Response("offline", { status: 404 });
    if (live.route_tag && !constantTimeEqual(body.tag ?? "", live.route_tag)) {
      return new Response("offline", { status: 404 });
    }

    // The session token. Held in the viewer's page memory only, never persisted in the
    // browser and never reused across streams — it authorises heartbeat/end for THIS
    // session and is not an identifier for the person holding it.
    const token = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));

    // A viewer's location is never needed by anything and is never resolved or stored.
    const result = await env.DB
      .prepare(`
        INSERT INTO watch_events (user_id, stream_id, last_seen_at, session_hash)
        VALUES (?, ?, datetime('now'), ?)
        RETURNING id
      `)
      .bind(user?.id ?? null, body.stream_id, await sha256b64url(token))
      .first<{ id: number }>();

    return Response.json({
      id: result?.id,
      stream_id: body.stream_id,
      token,
      heartbeat_seconds: SESSION_HEARTBEAT_SECONDS,
    });
  }

  // POST /api/stats/watch/:id/heartbeat - "still watching".
  //
  // This is what makes a duration measured rather than assumed. Answers ok:false instead of
  // an error status when the session is gone (reaped after a backgrounded tab, say) so the
  // client can simply open a fresh one — a viewer who comes back is watching again, and
  // stitching that into the old row would credit them for the gap.
  const watchBeatMatch = path.match(/^\/api\/stats\/watch\/(\d+)\/heartbeat$/);
  if (method === "POST" && watchBeatMatch) {
    const sessionId = parseInt(watchBeatMatch[1]);
    const body = await readJsonBody<{ token?: string }>(request);
    const ok = await touchSession(env, sessionId, body?.token ?? "");
    return Response.json(ok ? { ok: true } : { ok: false, reason: "unknown" });
  }

  // POST /api/stats/watch/:id/end - Close a viewing session.
  //
  // Token-checked because ids are sequential integers: unauthenticated, this let anyone walk
  // the range and close sessions they had no part in, deleting other people's audience
  // figures. Idempotent, because it is called from pagehide and may race the reaper.
  const watchEndMatch = path.match(/^\/api\/stats\/watch\/(\d+)\/end$/);
  if (method === "POST" && watchEndMatch) {
    const body = await readJsonBody<{ token?: string }>(request);
    const row = await env.DB
      .prepare("SELECT session_hash FROM watch_events WHERE id = ?")
      .bind(parseInt(watchEndMatch[1]))
      .first<{ session_hash: string | null }>();
    if (!row) return Response.json({ success: true }); // already purged; nothing to close

    // Rows predating migration 0014 carry no hash and cannot be authenticated. They are
    // abandoned ghosts the reaper will close on its own; accept nothing for them.
    if (!row.session_hash) return Response.json({ success: true });
    if (!constantTimeEqual(await sha256b64url(body?.token ?? ""), row.session_hash)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    await env.DB
      .prepare(
        "UPDATE watch_events SET ended_at = datetime('now'), end_reason = 'client' WHERE id = ? AND ended_at IS NULL"
      )
      .bind(parseInt(watchEndMatch[1]))
      .run();

    return Response.json({ success: true });
  }

  return new Response("Not Found", { status: 404 });
}

// Helper to get authenticated user from request.
// OAUTH-DISABLED: always resolve to the anonymous user so broadcast/stream/stats
// writes work without sign-in. Restore the session lookup below to re-enable auth.
async function getAuthenticatedUser(_request: Request, _env: Env): Promise<User | null> {
  return ANON_USER;
  /* OAUTH-DISABLED — original:
  const cookieHeader = _request.headers.get("Cookie");
  const sessionToken = getSessionFromCookie(cookieHeader);
  if (!sessionToken) return null;
  const session = await verifySessionToken(sessionToken, _env.SESSION_SECRET);
  if (!session) return null;
  return getUserById(_env.DB, session.userId);
  */
}

// Broadcaster allow list check (default-deny).
// OAUTH-DISABLED: broadcasting is open to everyone while auth is off. Restore the
// allow-list query below to re-enable gating.
async function canBroadcast(_db: D1Database, _email: string): Promise<boolean> {
  return true;
  /* OAUTH-DISABLED — original:
  const row = await _db
    .prepare("SELECT status FROM broadcaster_access WHERE email = ?")
    .bind(_email)
    .first<{ status: string }>();
  return row?.status === "allowed";
  */
}

// ── Publisher authorization ───────────────────────────────────────────────────────────
// Two independent checks, because they answer different questions:
//
//   1. ADMISSION  — may you publish at all?  (PUBLISH_SECRET)
//   2. OWNERSHIP  — is this broadcast name yours?  (Ed25519 challenge-response)
//
// Neither involves an account, an email, or anything identifying. Ownership is proved with
// a keypair minted per broadcast in the browser whose private half never leaves it, and the
// binding lasts only while the broadcast is live — so a lost key strands no name.
//
// Before this, an unauthenticated request could obtain a publish token for ANY stream id,
// including one already in use by someone else.

const CLAIM_CONTEXT = "e2emoq-claim-v1";
const CHALLENGE_TTL_SECONDS = 120;

const b64urlToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const bytesToB64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Length-independent comparison, so a wrong credential leaks nothing through timing. */
function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToB64url(new Uint8Array(sig));
}

/**
 * A challenge is `<issued-at>.<hmac>` — self-authenticating, so no nonce table is needed and
 * the Worker stays stateless. The TTL bounds replay; a stolen challenge is useless without
 * the broadcaster's private key in any case.
 */
async function mintChallenge(env: Env): Promise<string | null> {
  if (!env.CHALLENGE_SECRET) return null;
  const issued = Math.floor(Date.now() / 1000).toString();
  return `${issued}.${await hmac(env.CHALLENGE_SECRET, issued)}`;
}

async function challengeIsValid(env: Env, challenge: string): Promise<boolean> {
  if (!env.CHALLENGE_SECRET) return false;
  const [issued, mac] = challenge.split(".");
  if (!issued || !mac) return false;
  const age = Math.floor(Date.now() / 1000) - Number(issued);
  if (!Number.isFinite(age) || age < -5 || age > CHALLENGE_TTL_SECONDS) return false;
  return constantTimeEqual(mac, await hmac(env.CHALLENGE_SECRET, issued));
}

/** Verify the broadcaster signed OUR challenge for THIS stream id with the key they claim. */
async function claimIsValid(
  pubkeyB64: string,
  streamId: string,
  challenge: string,
  signatureB64: string
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      b64urlToBytes(pubkeyB64),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const msg = new TextEncoder().encode(`${CLAIM_CONTEXT}|${streamId}|${challenge}`);
    return await crypto.subtle.verify("Ed25519", key, b64urlToBytes(signatureB64), msg);
  } catch {
    return false; // malformed key or signature — indistinguishable from a bad one, deliberately
  }
}

/**
 * Is this stream id free, or already claimed by this same key? A live row belonging to a
 * different key means someone else is mid-broadcast under that name.
 */
async function nameIsAvailable(env: Env, streamId: string, pubkey: string): Promise<boolean> {
  const row = await env.DB
    .prepare(
      "SELECT publisher_pubkey FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
    )
    .bind(streamId)
    .first<{ publisher_pubkey: string | null }>();
  if (!row) return true;
  // Rows predating this feature carry no key; treat them as claimable so an old live row
  // cannot permanently block a name.
  if (!row.publisher_pubkey) return true;
  return constantTimeEqual(row.publisher_pubkey, pubkey);
}

// ── Publish codes ─────────────────────────────────────────────────────────────────────
// A per-person alternative to the single shared PUBLISH_SECRET, which cannot be revoked for
// one person, is not attributable, and can be passed on freely.
//
// A code is a self-describing capability, not a database row:
//
//     wf1.<base64url payload>.<truncated HMAC>
//
// The payload is plaintext — anyone can read their own not-before, expiry and batch. The MAC
// is what makes those claims unforgeable: only this Worker holds ISSUE_KEY, so an abuser who
// edits `exp` from 2026 to 2036 cannot produce a MAC that matches the edited payload. That is
// why the expiry can safely ride INSIDE the credential instead of in a table.
//
// Issuing one therefore writes NOTHING down. There is no per-person row to subpoena and
// nothing to correlate against broadcast_events, which is the property that keeps a
// broadcaster's identity out of reach even from us. The cost, accepted deliberately: we
// cannot tell one person's tenth code from ten people's first. That is the same property
// viewed from the other side, and it cannot be had one way only.
//
// Cutting someone off is normally just declining to reissue when their code lapses. The two
// revocation tables exist for the impatient case and are identity-free by construction: a
// batch number, or a hash of a code.

const CODE_VERSION = "wf1";
const CODE_CONTEXT = "e2emoq-publish-code-v1";
const POW_CONTEXT = "e2emoq-pow-v1";
const POW_CHALLENGE_TTL_SECONDS = 15 * 60; // generous: the client spends real time on the PoW
const DEFAULT_CODE_TTL_DAYS = 30;
const DEFAULT_CODE_DELAY_HOURS = 24;
const DEFAULT_POW_BITS = 18;
/** MAC length in base64url chars. 22 chars ≈ 132 bits — far beyond forgeable, much shorter. */
const CODE_MAC_CHARS = 22;

interface CodePayload {
  nbf: number; // not-before (unix seconds)
  exp: number; // expiry (unix seconds)
  batch: number;
  n: string; // nonce, so two codes minted in the same second still differ
}

/** Verdicts are distinct internally for tests and logs; the API collapses them (see below). */
type CodeVerdict = "ok" | "not-a-code" | "bad-mac" | "too-early" | "expired" | "revoked";

const numVar = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

function codeConfig(env: Env) {
  return {
    batch: Math.floor(numVar(env.PUBLISH_CODE_BATCH, 1)),
    ttlDays: numVar(env.PUBLISH_CODE_TTL_DAYS, DEFAULT_CODE_TTL_DAYS),
    delayHours: numVar(env.PUBLISH_CODE_DELAY_HOURS, DEFAULT_CODE_DELAY_HOURS),
    powBits: Math.floor(numVar(env.PUBLISH_CODE_POW_BITS, DEFAULT_POW_BITS)),
  };
}

/** base64url SHA-256. */
async function sha256b64url(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return bytesToB64url(new Uint8Array(d));
}

/** The only form of a code we are ever willing to store. */
const codeHash = sha256b64url;

async function mintPublishCode(
  env: Env
): Promise<{ code: string; nbf: number; exp: number } | null> {
  if (!env.ISSUE_KEY) return null;
  const { batch, ttlDays, delayHours } = codeConfig(env);
  const now = Math.floor(Date.now() / 1000);
  const nbf = now + Math.round(delayHours * 3600);
  const exp = nbf + Math.round(ttlDays * 86400);
  const payload: CodePayload = {
    nbf,
    exp,
    batch,
    n: bytesToB64url(crypto.getRandomValues(new Uint8Array(9))),
  };
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = (await hmac(env.ISSUE_KEY, `${CODE_CONTEXT}|${body}`)).slice(0, CODE_MAC_CHARS);
  return { code: `${CODE_VERSION}.${body}.${mac}`, nbf, exp };
}

/**
 * Verify the MAC, and only then believe anything the payload says.
 *
 * The order is load-bearing: parsing first and checking the seal afterwards would mean acting
 * on attacker-chosen JSON, and any bug in between would be reachable by anyone.
 */
async function verifyPublishCode(env: Env, code: string): Promise<CodeVerdict> {
  if (!env.ISSUE_KEY) return "not-a-code";
  const parts = code.split(".");
  if (parts.length !== 3 || parts[0] !== CODE_VERSION) return "not-a-code";
  const [, body, mac] = parts;

  const expected = (await hmac(env.ISSUE_KEY, `${CODE_CONTEXT}|${body}`)).slice(0, CODE_MAC_CHARS);
  if (!constantTimeEqual(mac, expected)) return "bad-mac";

  let payload: CodePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
  } catch {
    return "bad-mac"; // authentic MAC over unparseable bytes can only be our own bug
  }
  if (typeof payload?.nbf !== "number" || typeof payload?.exp !== "number") return "bad-mac";

  const now = Math.floor(Date.now() / 1000);
  if (now < payload.nbf) return "too-early";
  if (now >= payload.exp) return "expired";

  const batchRow = await env.DB
    .prepare("SELECT batch FROM revoked_batches WHERE batch = ?")
    .bind(payload.batch)
    .first();
  if (batchRow) return "revoked";

  const codeRow = await env.DB
    .prepare("SELECT code_hash FROM revoked_codes WHERE code_hash = ?")
    .bind(await codeHash(code))
    .first();
  if (codeRow) return "revoked";

  return "ok";
}

/**
 * May this credential publish at all? Accepts either the shared PUBLISH_SECRET or a valid
 * per-person code, so the two can coexist while the shared secret is phased out.
 *
 * Fails CLOSED when nothing is configured. An earlier version of the admission check returned
 * true unconditionally while still being called, so the code read as though it gated something
 * and the endpoint was open to anyone who knew the URL.
 */
async function admissionVerdict(
  env: Env,
  credential: string | undefined
): Promise<{ ok: boolean; reason: string }> {
  if (!env.PUBLISH_SECRET && !env.ISSUE_KEY) {
    return { ok: false, reason: "publisher authorization is not configured" };
  }
  if (!credential) return { ok: false, reason: "A publish key is required to broadcast." };

  if (env.PUBLISH_SECRET && constantTimeEqual(credential, env.PUBLISH_SECRET)) {
    return { ok: true, reason: "shared" };
  }

  switch (await verifyPublishCode(env, credential)) {
    case "ok":
      return { ok: true, reason: "code" };
    case "too-early":
      // Worth naming precisely: someone waiting out the activation delay has done nothing
      // wrong, and "your key is invalid" would send them to request another one.
      return { ok: false, reason: "This code is not active yet. Check back shortly." };
    case "expired":
      return { ok: false, reason: "This code has expired. Request a new one." };
    default:
      // revoked / bad-mac / not-a-code collapse into one message on purpose: distinguishing
      // them turns this endpoint into an oracle for probing which codes exist.
      return { ok: false, reason: "That publish key was not accepted." };
  }
}

// ── Proof of work for code requests ───────────────────────────────────────────────────
// Friction, not identification. It stops a script minting ten thousand codes; it does not
// stop a determined person minting ten, and no setting would without punishing the phone
// users this app is for. PUBLISH_CODE_DELAY_HOURS is the lever that actually bites.

async function mintPowChallenge(env: Env): Promise<string | null> {
  if (!env.ISSUE_KEY) return null;
  const issued = Math.floor(Date.now() / 1000).toString();
  return `${issued}.${await hmac(env.ISSUE_KEY, `${POW_CONTEXT}|${issued}`)}`;
}

async function powChallengeIsValid(env: Env, challenge: string): Promise<boolean> {
  if (!env.ISSUE_KEY) return false;
  const [issued, mac] = challenge.split(".");
  if (!issued || !mac) return false;
  const age = Math.floor(Date.now() / 1000) - Number(issued);
  if (!Number.isFinite(age) || age < -5 || age > POW_CHALLENGE_TTL_SECONDS) return false;
  return constantTimeEqual(mac, await hmac(env.ISSUE_KEY, `${POW_CONTEXT}|${issued}`));
}

/** Does SHA-256(challenge|nonce) start with at least `bits` zero bits? */
async function powIsValid(challenge: string, nonce: string, bits: number): Promise<boolean> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${challenge}|${nonce}`))
  );
  let seen = 0;
  for (const byte of digest) {
    if (byte === 0) {
      seen += 8;
      continue;
    }
    seen += Math.clz32(byte) - 24; // leading zeros within this byte
    break;
  }
  return seen >= bits;
}

async function handlePublishCodeRoutes(request: Request, env: Env, url: URL): Promise<Response> {
  const { powBits, delayHours, ttlDays } = codeConfig(env);

  if (!env.ISSUE_KEY) {
    return Response.json({ error: "code issuance is not enabled" }, { status: 503 });
  }

  // GET /api/publish-code/challenge — a work target. Self-authenticating like the publish
  // challenge, so no nonce table is needed and this stays stateless.
  if (request.method === "GET" && url.pathname === "/api/publish-code/challenge") {
    const challenge = await mintPowChallenge(env);
    if (!challenge) {
      return Response.json({ error: "code issuance is not enabled" }, { status: 503 });
    }
    return Response.json({
      challenge,
      bits: powBits,
      delay_hours: delayHours,
      ttl_days: ttlDays,
      expires_in: POW_CHALLENGE_TTL_SECONDS,
    });
  }

  // POST /api/publish-code/request — spend the work, receive a code.
  //
  // Nothing about the requester is read, logged, or stored. That is the feature: we cannot be
  // compelled to identify a broadcaster we never learned anything about. Cloudflare still sees
  // the requesting IP on its way in, which is why the page tells people to use a VPN or Tor —
  // a limit we can name honestly rather than paper over.
  if (request.method === "POST" && url.pathname === "/api/publish-code/request") {
    const body = (await request.json().catch(() => null)) as {
      challenge?: string;
      nonce?: string;
    } | null;
    if (!body?.challenge || typeof body.nonce !== "string") {
      return Response.json({ error: "challenge and nonce required" }, { status: 400 });
    }
    if (!(await powChallengeIsValid(env, body.challenge))) {
      return Response.json({ error: "challenge expired — reload and try again" }, { status: 403 });
    }
    if (!(await powIsValid(body.challenge, body.nonce, powBits))) {
      return Response.json({ error: "proof of work is not valid" }, { status: 403 });
    }

    const minted = await mintPublishCode(env);
    if (!minted) {
      return Response.json({ error: "code issuance is not enabled" }, { status: 503 });
    }
    return Response.json({
      code: minted.code,
      active_at: new Date(minted.nbf * 1000).toISOString(),
      expires_at: new Date(minted.exp * 1000).toISOString(),
      active_immediately: delayHours === 0,
    });
  }

  return new Response("Not Found", { status: 404 });
}

// ── Rotatable salts and the kill switch ───────────────────────────────────────────────
// The salt is a PUBLIC HKDF input handed to publisher and viewers alike, not a secret.
// Rotating it changes the derived content key for everyone who derives afterwards — without
// the share link changing, and without this side ever holding the link secret.
//
// That is the whole point: it is the only moderation lever available to an operator who
// cannot see content. We can terminate a stream on an abuse report or a legal demand. We
// still cannot watch it, and cannot say what it contained.

const GLOBAL_SALT_ROW = "*";

const randomSalt = (): string => bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));

/** Mixed into EVERY stream's derivation; rotating it re-keys everything at once. */
async function globalSalt(env: Env): Promise<string> {
  const row = await env.DB
    .prepare("SELECT salt FROM stream_salts WHERE stream_id = ?")
    .bind(GLOBAL_SALT_ROW)
    .first<{ salt: string }>();
  return row?.salt ?? "genesis";
}

/**
 * Has this stream been terminated? Read-only, so it can be checked early without bringing a
 * salt row into existence for a stream that may be refused anyway.
 */
async function streamIsKilled(env: Env, streamId: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT killed_at FROM stream_salts WHERE stream_id = ?")
    .bind(streamId)
    .first<{ killed_at: string | null }>();
  return !!row?.killed_at;
}

/**
 * The composite salt a browser derives with, plus whether this stream has been killed.
 * `create` is true only on the publish path: a viewer must never be able to bring a salt row
 * into existence for a stream that was never broadcast.
 */
async function derivationSalt(
  env: Env,
  streamId: string,
  create: boolean
): Promise<{ salt: string; killed: boolean } | null> {
  let row = await env.DB
    .prepare("SELECT salt, killed_at FROM stream_salts WHERE stream_id = ?")
    .bind(streamId)
    .first<{ salt: string; killed_at: string | null }>();

  if (!row) {
    if (!create) return null;
    await env.DB
      .prepare("INSERT OR IGNORE INTO stream_salts (stream_id, salt) VALUES (?, ?)")
      .bind(streamId, randomSalt())
      .run();
    // Re-read rather than trusting what we just wrote: INSERT OR IGNORE is a no-op if a
    // concurrent go-live won the race, and both sides must end up with the SAME salt or the
    // publisher and its viewers derive different keys.
    row = await env.DB
      .prepare("SELECT salt, killed_at FROM stream_salts WHERE stream_id = ?")
      .bind(streamId)
      .first<{ salt: string; killed_at: string | null }>();
    if (!row) return null;
  }

  return { salt: `${await globalSalt(env)}|${row.salt}`, killed: !!row.killed_at };
}

// Helper to extract geolocation from Cloudflare request
interface GeoData {
  country: string | null;
  city: string | null;
  region: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string | null;
}

function getGeoFromRequest(request: Request): GeoData {
  const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
  return {
    country: cf?.country || null,
    city: cf?.city || null,
    region: cf?.region || null,
    latitude: cf?.latitude?.toString() || null,
    longitude: cf?.longitude?.toString() || null,
    timezone: cf?.timezone || null,
  };
}

// Handle admin routes
async function handleAdminRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // Admin password comes from the ADMIN_PASSWORD secret (wrangler secret put).
  // Never hardcoded. If unset, admin fails closed (locked).
  const adminPassword = env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return Response.json({ error: "admin disabled" }, { status: 503 });
  }

  // GET /api/admin/verify - Verify password (no auth required for this check)
  if (method === "GET" && path === "/api/admin/verify") {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${adminPassword}`) {
      return Response.json({ valid: false }, { status: 401 });
    }
    return Response.json({ valid: true });
  }

  // Verify admin password from Authorization header
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${adminPassword}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // POST /api/admin/kill - Terminate one stream.
  //
  // Two effects, both immediate for anyone not already connected: no further publish or
  // viewer token is issued, and the salt is rotated so anyone who re-derives gets a
  // different key than the publisher is using. Existing connections survive until their
  // relay token expires — we cannot reach into a QUIC session we are not part of.
  //
  // This is deliberately the most we can do. We cannot see what was streamed, cannot produce
  // a recording of it, and cannot tell a complainant what it contained — with one narrow
  // exception since migration 0018: if a reporter chose to attach a still frame, we hold that
  // one moment and nothing either side of it.
  if (method === "POST" && path === "/api/admin/kill") {
    const body = await request.json().catch(() => null) as { stream_id?: string; note?: string } | null;
    if (!body?.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }
    await env.DB
      .prepare(`
        INSERT INTO stream_salts (stream_id, salt, killed_at, note)
        VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(stream_id) DO UPDATE SET
          salt = excluded.salt,
          rotated_at = datetime('now'),
          killed_at = datetime('now'),
          note = excluded.note
      `)
      .bind(body.stream_id, randomSalt(), body.note ?? null)
      .run();
    return Response.json({ success: true, stream_id: body.stream_id, killed: true });
  }

  // POST /api/admin/unkill - Let a stream id be used again. The rotated salt is NOT undone,
  // so anyone holding a link from before the kill still cannot decrypt what follows.
  if (method === "POST" && path === "/api/admin/unkill") {
    const body = await request.json().catch(() => null) as { stream_id?: string } | null;
    if (!body?.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }
    await env.DB
      .prepare("UPDATE stream_salts SET killed_at = NULL WHERE stream_id = ?")
      .bind(body.stream_id)
      .run();
    return Response.json({ success: true, stream_id: body.stream_id, killed: false });
  }

  // POST /api/admin/kill-all - Rotate the GLOBAL salt. Every stream re-keys at once; every
  // share link in existence stops decrypting anything published afterwards. The blunt
  // instrument, for when something is badly wrong rather than one stream being a problem.
  if (method === "POST" && path === "/api/admin/kill-all") {
    await env.DB
      .prepare("UPDATE stream_salts SET salt = ?, rotated_at = datetime('now') WHERE stream_id = ?")
      .bind(randomSalt(), GLOBAL_SALT_ROW)
      .run();
    return Response.json({ success: true, message: "global salt rotated; all streams re-keyed" });
  }

  // GET /api/admin/killed - What has been terminated, and why.
  if (method === "GET" && path === "/api/admin/killed") {
    const rows = await env.DB
      .prepare("SELECT stream_id, killed_at, note FROM stream_salts WHERE killed_at IS NOT NULL ORDER BY killed_at DESC")
      .all();
    return Response.json({ killed: rows.results });
  }

  // POST /api/admin/revoke-batch - Cut off an entire issuance cohort before its codes expire.
  // Bump PUBLISH_CODE_BATCH first if you want new requests to keep working.
  if (method === "POST" && path === "/api/admin/revoke-batch") {
    const body = await request.json().catch(() => null) as { batch?: number; note?: string; undo?: boolean } | null;
    if (!Number.isInteger(body?.batch)) {
      return Response.json({ error: "batch (integer) required" }, { status: 400 });
    }
    // `undo` because revocation is a blunt instrument aimed at a cohort, and a mis-typed batch
    // number would otherwise strand every broadcaster in it until their codes expired.
    if (body?.undo) {
      await env.DB.prepare("DELETE FROM revoked_batches WHERE batch = ?").bind(body.batch).run();
      return Response.json({ success: true, batch: body.batch, revoked: false });
    }
    await env.DB
      .prepare("INSERT OR REPLACE INTO revoked_batches (batch, revoked_at, note) VALUES (?, datetime('now'), ?)")
      .bind(body!.batch, body?.note ?? null)
      .run();
    return Response.json({ success: true, batch: body!.batch, revoked: true });
  }

  // POST /api/admin/revoke-code - Cut off ONE code without learning whose it is.
  //
  // We store SHA-256 of the code, never the code. That is enough to reject it on presentation
  // and useless for anything else — in particular it does not become a way to start tracking
  // who broadcasts. Needing to revoke someone is not a reason to begin identifying everyone.
  if (method === "POST" && path === "/api/admin/revoke-code") {
    const body = await request.json().catch(() => null) as { code?: string; note?: string; undo?: boolean } | null;
    if (!body?.code) {
      return Response.json({ error: "code required" }, { status: 400 });
    }
    const hash = await codeHash(body.code.trim());
    if (body.undo) {
      await env.DB.prepare("DELETE FROM revoked_codes WHERE code_hash = ?").bind(hash).run();
      return Response.json({ success: true, code_hash: hash, revoked: false });
    }
    await env.DB
      .prepare("INSERT OR REPLACE INTO revoked_codes (code_hash, revoked_at, note) VALUES (?, datetime('now'), ?)")
      .bind(hash, body.note ?? null)
      .run();
    return Response.json({ success: true, code_hash: hash, revoked: true });
  }

  // POST /api/admin/mint-code - Issue a code directly, bypassing the proof of work.
  // For handing one to someone out of band (a partner org distributing a batch, say) without
  // making them grind through the request page.
  if (method === "POST" && path === "/api/admin/mint-code") {
    const minted = await mintPublishCode(env);
    if (!minted) {
      return Response.json({ error: "ISSUE_KEY is not configured" }, { status: 503 });
    }
    return Response.json({
      code: minted.code,
      active_at: new Date(minted.nbf * 1000).toISOString(),
      expires_at: new Date(minted.exp * 1000).toISOString(),
    });
  }

  // DELETE /api/admin/broadcasts - Clear all broadcast data
  if (method === "DELETE" && path === "/api/admin/broadcasts") {
    await env.DB.prepare("DELETE FROM broadcast_events").run();
    return Response.json({ success: true, message: "All broadcaster data cleared" });
  }

  // DELETE /api/admin/viewers - Clear all viewer data
  if (method === "DELETE" && path === "/api/admin/viewers") {
    await env.DB.prepare("DELETE FROM watch_events").run();
    return Response.json({ success: true, message: "All viewer data cleared" });
  }

  // GET /api/admin/broadcasters - List signed-in users + allow-list status, plus
  // any pre-authorized emails that have never signed in.
  if (method === "GET" && path === "/api/admin/broadcasters") {
    // Signed-in users joined with their allow-list status (default 'none' = blocked).
    const users = await env.DB
      .prepare(`
        SELECT u.email, u.name, u.avatar_url,
               COALESCE(a.status, 'none') AS status,
               (SELECT MAX(started_at) FROM broadcast_events b WHERE b.user_id = u.id) AS last_broadcast
        FROM users u
        LEFT JOIN broadcaster_access a ON a.email = u.email
        ORDER BY u.name COLLATE NOCASE
      `)
      .all<{ email: string; name: string | null; avatar_url: string | null; status: string; last_broadcast: string | null }>();

    // Allow-list emails that have never signed in (pre-authorized / suspended-by-email).
    const orphans = await env.DB
      .prepare(`
        SELECT a.email, a.status
        FROM broadcaster_access a
        LEFT JOIN users u ON u.email = a.email
        WHERE u.id IS NULL
        ORDER BY a.email COLLATE NOCASE
      `)
      .all<{ email: string; status: string }>();

    const list = [
      ...(users.results ?? []),
      ...(orphans.results ?? []).map((o) => ({
        email: o.email,
        name: null,
        avatar_url: null,
        status: o.status,
        last_broadcast: null,
        never_signed_in: true,
      })),
    ];

    return Response.json({ broadcasters: list });
  }

  // POST /api/admin/broadcasters - Allow or suspend an email (default-deny allow list).
  if (method === "POST" && path === "/api/admin/broadcasters") {
    const body = await request.json().catch(() => null) as { email?: string; status?: string } | null;
    const email = body?.email?.trim().toLowerCase();
    const status = body?.status;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return Response.json({ error: "Valid email required" }, { status: 400 });
    }
    if (status !== "allowed" && status !== "suspended") {
      return Response.json({ error: "status must be 'allowed' or 'suspended'" }, { status: 400 });
    }

    await env.DB
      .prepare(`
        INSERT INTO broadcaster_access (email, status, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(email) DO UPDATE SET
          status = excluded.status,
          updated_at = datetime('now')
      `)
      .bind(email, status)
      .run();

    return Response.json({ success: true, email, status });
  }

  // DELETE /api/admin/broadcasters?email=... - Remove an email (reverts to default-deny).
  if (method === "DELETE" && path === "/api/admin/broadcasters") {
    const email = url.searchParams.get("email")?.trim().toLowerCase();
    if (!email) {
      return Response.json({ error: "email required" }, { status: 400 });
    }
    await env.DB.prepare("DELETE FROM broadcaster_access WHERE email = ?").bind(email).run();
    return Response.json({ success: true, email });
  }

  return new Response("Not Found", { status: 404 });
}
