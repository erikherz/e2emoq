// Session management using HMAC-SHA256 signed cookies
// Uses Web Crypto API (native to Cloudflare Workers)

const ALGORITHM = { name: "HMAC", hash: "SHA-256" };
const SESSION_DURATION = 7 * 24 * 60 * 60; // 7 days in seconds

async function getSigningKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    ALGORITHM,
    false,
    ["sign", "verify"]
  );
}

export async function createSessionToken(
  userId: number,
  secret: string,
  expiresInSeconds: number = SESSION_DURATION
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = JSON.stringify({ userId, exp });
  const encoder = new TextEncoder();

  const key = await getSigningKey(secret);
  const signature = await crypto.subtle.sign(
    ALGORITHM.name,
    key,
    encoder.encode(payload)
  );

  // Format: base64(payload).base64(signature)
  const payloadB64 = btoa(payload);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

  return `${payloadB64}.${sigB64}`;
}

export async function verifySessionToken(
  token: string,
  secret: string
): Promise<{ userId: number } | null> {
  try {
    const [payloadB64, sigB64] = token.split(".");
    if (!payloadB64 || !sigB64) return null;

    const payload = atob(payloadB64);
    const signature = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));

    const key = await getSigningKey(secret);
    const encoder = new TextEncoder();

    const valid = await crypto.subtle.verify(
      ALGORITHM.name,
      key,
      signature,
      encoder.encode(payload)
    );

    if (!valid) return null;

    const { userId, exp } = JSON.parse(payload);
    if (exp < Math.floor(Date.now() / 1000)) return null; // Expired

    return { userId };
  } catch {
    return null;
  }
}

export function setSessionCookie(
  token: string,
  isProduction: boolean
): string {
  const parts = [
    `session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_DURATION}`,
  ];

  if (isProduction) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return "session=; Path=/; HttpOnly; Max-Age=0";
}

export function getSessionFromCookie(
  cookieHeader: string | null
): string | null {
  if (!cookieHeader) return null;

  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]*)/);
  return match ? match[1] : null;
}
