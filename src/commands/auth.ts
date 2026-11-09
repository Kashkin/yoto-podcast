import type { StoredTokens } from '../types.js';
import { loadConfig, loadTokens, saveTokens } from '../config.js';

const AUTH_DOMAIN = 'https://login.yotoplay.com';
const AUDIENCE = 'https://api.yotoplay.com';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function requestDeviceCode(
  clientId: string
): Promise<DeviceCodeResponse> {
  const res = await fetch(`${AUTH_DOMAIN}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      scope: 'offline_access',
      audience: AUDIENCE,
    }),
  });

  if (!res.ok) throw new Error(`Device code request failed: ${res.status}`);
  return res.json() as Promise<DeviceCodeResponse>;
}

export async function pollForToken(
  deviceCode: string,
  clientId: string,
  intervalSec: number,
  maxAttempts: number
): Promise<StoredTokens> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
    }

    const res = await fetch(`${AUTH_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: clientId,
        audience: AUDIENCE,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
    }

    const body = (await res.json()) as {
      error: string;
      error_description?: string;
    };
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      intervalSec += 5;
      continue;
    }
    throw new Error(
      `Auth failed: ${body.error}${body.error_description ? ` — ${body.error_description}` : ''}`
    );
  }

  throw new Error('Auth timed out — device code expired');
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string
): Promise<StoredTokens> {
  const res = await fetch(`${AUTH_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} — ${body}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

// Stored tokens, refreshed and saved if they expire within a minute.
// Null when there are none; throws if the refresh fails.
export async function getValidTokens(configPath: string, tokensPath: string): Promise<StoredTokens | null> {
  const tokens = loadTokens(tokensPath);
  if (!tokens || tokens.expiresAt >= Date.now() + 60000) return tokens;
  console.log('Refreshing Yoto token...');
  const refreshed = await refreshAccessToken(tokens.refreshToken, loadConfig(configPath).yoto.clientId);
  saveTokens(refreshed, tokensPath);
  return refreshed;
}

export async function runAuth(
  configPath: string,
  tokensPath: string
): Promise<void> {
  const config = loadConfig(configPath);
  const { clientId } = config.yoto;

  console.log('Starting Yoto authentication...');
  const deviceCode = await requestDeviceCode(clientId);

  console.log(`\nGo to: ${deviceCode.verification_uri_complete}`);
  console.log(`Enter code: ${deviceCode.user_code}\n`);
  console.log('Waiting for approval...');

  const tokens = await pollForToken(
    deviceCode.device_code,
    clientId,
    deviceCode.interval,
    60
  );

  saveTokens(tokens, tokensPath);
  console.log('Authenticated successfully. Tokens saved.');
}
