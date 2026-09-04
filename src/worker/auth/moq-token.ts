// Per-broadcast MoQ relay tokens. Short-lived, scope-limited JWTs minted by the Worker
// and passed to the TinyMoQ relay as the `?jwt=` query param on the WebTransport URL.
// The relay verifies the signature, then enforces the `put`/`get` scopes + `exp`.
//
// TWO signing modes, selected by configuration (so this file is tenant-agnostic):
//
//   BYOK (asymmetric):  EdDSA (Ed25519) with the tenant's OWN private key
//                       (MOQ_AUTH_PRIVATE_JWK). Only the matching PUBLIC key is
//                       registered with TinyMoQ — the relay never holds a signing key.
//
//   Managed (symmetric): HS256 with a per-stream HMAC secret that /assign returns
//                       (`key` field). TinyMoQ keys the relay per broadcast; a
//                       reap/respawn rotates the key (old tokens die = revocation).
//                       Do NOT cache it — sign on demand with what /assign returned.
//
// Same claim contract either way (PER-BROADCAST-TOKENS.md): unpadded base64url
// everywhere, `exp` in unix SECONDS. Signing input is base64url(header) + "." +
// base64url(payload); the token is that + "." + base64url(signature).

// MoQplay's Ed25519 key id (RFC 7638 JWK thumbprint) — fallback if the private JWK
// secret omits its own `kid`. The relay selects the verifying key by this kid; it must
// match the `kid` on MoQplay's registered verify_jwk.
export const MOQ_KID = "guAuLGEyCksxcThOpOD5xvlCBfrwHEDkUc7n8fOXDHU";
// Managed HS256 mode: the relay has the per-stream key and ignores `kid`; keep it
// constant so tokens stay identical to the moq-token-cli tooling.
const HS256_KID = "9309ffde64e0bf0f";

const ED25519 = { name: "Ed25519" } as const;

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = new Uint8Array(buf as ArrayBuffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecodeToBytes = (s: string): Uint8Array => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export interface MoqClaims {
  put: string[]; // path prefixes the holder may publish to ([] = none)
  get: string[]; // path prefixes the holder may subscribe to
  exp: number; // expiry, unix SECONDS
  // Cross-cluster pull flag. Set only on the `&pull=` token handed to a viewer-CDN edge
  // relay so it may pull this broadcast from the publisher's origin relay across clusters.
  // Omitted (undefined) on ordinary publisher/viewer tokens, so they are byte-identical
  // to before — JSON.stringify drops undefined fields.
  cluster?: boolean;
}

const sign = async (header: object, claims: MoqClaims, signFn: (input: Uint8Array) => Promise<ArrayBuffer>): Promise<string> => {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const sig = await signFn(new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
};

/**
 * Parse a private OKP JWK, normalising the `alg` label.
 *
 * NOT cosmetic. Node's `crypto.subtle.exportKey("jwk", …)` stamps an Ed25519 private key with
 * `alg: "Ed25519"`; RFC 8037 §3.1 says the JWA algorithm name for Ed25519 signatures is
 * "EdDSA", and workerd enforces it — `importKey` throws
 *
 *   DataError: JSON Web Key Algorithm parameter "alg" ("Ed25519") does not match requested
 *   Ed25519 curve.
 *
 * …which surfaces as an unhandled exception and a Cloudflare 500 page, i.e. a go-live that
 * fails with no usable error. The key MATERIAL is fine; only the label disagrees, so this
 * corrects the label rather than rejecting the key. Anything already deployed keeps working
 * and no key has to be rotated.
 *
 * Deliberately permissive in one direction only: an `alg` that is absent or already "EdDSA"
 * is left alone, and any other value is replaced rather than trusted. There is exactly one
 * signature algorithm on this curve, so there is nothing a caller could mean by a third value.
 */
function parsePrivateOkpJwk(privateJwk: string): JsonWebKey & { kid?: string } {
  const jwk = JSON.parse(privateJwk) as JsonWebKey & { kid?: string };
  if (jwk.alg !== "EdDSA") jwk.alg = "EdDSA";
  return jwk;
}

// BYOK: sign with the tenant's Ed25519 private key. `privateJwk` is an OKP JWK (JSON
// string with `d`), e.g. env.MOQ_AUTH_PRIVATE_JWK.
export async function mintEd25519Token(privateJwk: string, claims: MoqClaims): Promise<string> {
  const jwk = parsePrivateOkpJwk(privateJwk);
  const key = await crypto.subtle.importKey("jwk", jwk, ED25519, false, ["sign"]);
  const header = { typ: "JWT", alg: "EdDSA", kid: jwk.kid ?? MOQ_KID };
  return sign(header, claims, (input) => crypto.subtle.sign(ED25519, key, input));
}

// The PUBLIC verify JWK for our BYOK signing key — what an operator installs/pastes as the
// relay's verify_jwk. Returns ONLY public material (the `x` coordinate is public; the
// private `d` is dropped), so this is safe to expose. The `kid` matches what
// mintEd25519Token() stamps on tokens (jwk.kid ?? MOQ_KID), so the relay selects this key.
export interface PublicVerifyJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  alg: "EdDSA";
  use: "sig";
  key_ops: ["verify"];
  kid: string;
}
export function publicVerifyJwk(privateJwk: string): PublicVerifyJwk {
  const jwk = JSON.parse(privateJwk) as { kty?: string; crv?: string; x?: string; kid?: string };
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
    throw new Error("MOQ_AUTH_PRIVATE_JWK is not an Ed25519 (OKP) JWK");
  }
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: jwk.x, // public coordinate only — never the private `d`
    alg: "EdDSA",
    use: "sig",
    key_ops: ["verify"],
    kid: jwk.kid ?? MOQ_KID,
  };
}

// Managed: sign with a per-stream HMAC secret (base64url "k") returned by /assign.
export async function mintHs256Token(secretK: string, claims: MoqClaims): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    b64urlDecodeToBytes(secretK),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const header = { typ: "JWT", alg: "HS256", kid: HS256_KID };
  return sign(header, claims, (input) => crypto.subtle.sign("HMAC", key, input));
}

// ── moq.pro (Luke Curley's hosted CDN) ───────────────────────────────────────
// moq.pro verifies HS256 tokens signed with the account's OWN symmetric key (the
// erik-erik.jwk moq.pro issued; base64url "k" stored as the MOQ_PRO_K secret) and uses a
// DIFFERENT claim shape than the fleet tokens above: a `root` account claim plus put/get
// scoped to "<stream>.hang". The kid is moq.pro's, fixed below.
export const MOQ_PRO_KID = "f865ebbc-4bb8-4a1f-834c-7d2fc0ae1d07";
export interface MoqProClaims {
  root: string; // account root, e.g. "erik"
  put: string[];
  get: string[];
  exp: number; // expiry, unix SECONDS
}
export async function mintMoqProToken(secretK: string, claims: MoqProClaims): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    b64urlDecodeToBytes(secretK),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const header = { typ: "JWT", alg: "HS256", kid: MOQ_PRO_KID };
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

/**
 * The same claims, signed with an ASYMMETRIC key imported through moq.pro's admin UI
 * ("Import Asymmetric"), where only the PUBLIC half was uploaded.
 *
 * This is the whole difference from mintMoqProToken above. HS256 verification requires the
 * identical secret used to sign, so moq.pro necessarily holds everything needed to mint any
 * token we could -- their Keys page even offers it back as a Download. With EdDSA they hold
 * only a verify key: they can check our tokens and cannot forge one, and a breach on their
 * side yields nothing that lets anyone publish or subscribe as us.
 *
 * The kid travels in the header so the relay selects the right verify key.
 */
export async function mintMoqProTokenEd25519(
  privateJwk: string,
  claims: MoqProClaims,
  kidOverride?: string
): Promise<string> {
  const jwk = parsePrivateOkpJwk(privateJwk);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  // The CDN selects its verifying key by `kid`, so this has to be whatever moq.pro calls the
  // key — NOT necessarily what we called it. Our keygen stamps the RFC 7638 thumbprint on both
  // halves, which is right only if moq.pro adopts it on import; moq.pro also names keys itself
  // (Wallflower's is "gentle-summer"), and a token stamped with the wrong one is refused with
  // no error a client can see — the session simply closes the moment it speaks MoQ.
  const header = { typ: "JWT", alg: "EdDSA", kid: kidOverride || jwk.kid };
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}
