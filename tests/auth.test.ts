import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestDeviceCode, pollForToken, getValidTokens } from '../src/commands/auth.js';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('requestDeviceCode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns device code response from Yoto auth endpoint', async () => {
    const mockResponse = {
      device_code: 'test-device-code',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://login.yotoplay.com/activate',
      verification_uri_complete: 'https://login.yotoplay.com/activate?user_code=ABCD-EFGH',
      expires_in: 300,
      interval: 5,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 })
    );

    const result = await requestDeviceCode('test-client-id');
    expect(result.user_code).toBe('ABCD-EFGH');
    expect(result.device_code).toBe('test-device-code');
  });
});

describe('pollForToken', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns tokens on success', async () => {
    const tokenResponse = {
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      expires_in: 86400,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    );

    const result = await pollForToken('device-code', 'client-id', 1, 1);
    expect(result.accessToken).toBe('test-access');
    expect(result.refreshToken).toBe('test-refresh');
  });

  it('retries on authorization_pending', async () => {
    const pending = new Response(
      JSON.stringify({ error: 'authorization_pending' }),
      { status: 403 }
    );
    const success = new Response(
      JSON.stringify({
        access_token: 'ok',
        refresh_token: 'ok',
        expires_in: 86400,
      }),
      { status: 200 }
    );

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(success);

    const result = await pollForToken('device-code', 'client-id', 0.01, 5);
    expect(result.accessToken).toBe('ok');
  });
});

describe('getValidTokens', () => {
  const dir = join(import.meta.dirname, '.test-auth');
  const configPath = join(dir, 'config.json');
  const tokensPath = join(dir, 'tokens.json');
  const write = (expiresAt: number) =>
    writeFileSync(tokensPath, JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt }));

  beforeEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ yoto: { clientId: 'client' }, podcasts: [] }));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null when there are no stored tokens', async () => {
    expect(await getValidTokens(configPath, tokensPath)).toBeNull();
  });

  it('returns stored tokens that are still valid without refreshing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    write(Date.now() + 3600_000);
    expect((await getValidTokens(configPath, tokensPath))?.accessToken).toBe('old-access');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes and saves tokens that expire within a minute', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }), { status: 200 })
    );
    write(Date.now() + 30_000);
    expect((await getValidTokens(configPath, tokensPath))?.accessToken).toBe('new-access');
    expect(JSON.parse(readFileSync(tokensPath, 'utf8')).refreshToken).toBe('new-refresh');
  });

  it('throws when the refresh fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('denied', { status: 403 }));
    write(Date.now() - 1);
    await expect(getValidTokens(configPath, tokensPath)).rejects.toThrow(/Token refresh failed: 403/);
  });
});
