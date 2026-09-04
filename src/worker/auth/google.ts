// Google OAuth 2.0 implementation for Cloudflare Workers

export interface GoogleTokens {
  access_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
}

export interface GoogleUser {
  id: string;
  email: string;
  name: string;
  picture: string;
}

// Generate the Google OAuth authorization URL
export function getGoogleAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: state,
    access_type: "online",
    prompt: "select_account",
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Exchange authorization code for tokens
export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<GoogleTokens> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${response.status} - ${error}`);
  }

  return response.json();
}

// Fetch user info from Google
export async function getGoogleUserInfo(
  accessToken: string
): Promise<GoogleUser> {
  const response = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch user info: ${response.status}`);
  }

  return response.json();
}
