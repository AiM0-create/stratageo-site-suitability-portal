// v1.12.0 — the Mapbox token is fetched at runtime, never bundled.
//
// Baking it in via VITE_MAPBOX_TOKEN put the token string in the shipped JS,
// and GitHub push protection rejected every gh-pages deploy because of it.
// Fetching from the engine keeps it out of the repo and every build artifact,
// and allows rotation without a frontend rebuild.
//
// A map that fails to load its token must degrade to "no map" — it must never
// take the page down, and it must never accept a secret (sk.) token even if a
// misconfigured backend offers one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadMapConfig, mapboxTokenSync, __resetMapConfigCache } from '../services/mapConfig';

const PUBLIC = 'pk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbGV4YW1wbGUifQ.AbCdEfGhIjKlMnOpQr';
const SECRET = 'sk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbGV4YW1wbGUifQ.AbCdEfGhIjKlMnOpQr';

const okJson = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });
// Tests have no VITE_PY_BACKEND_URL, so pass the engine base explicitly.
const ENGINE = 'https://engine.example';

beforeEach(() => __resetMapConfigCache());
afterEach(() => { vi.restoreAllMocks(); __resetMapConfigCache(); });

describe('loadMapConfig', () => {
  it('returns the public token the engine serves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJson({ mapboxToken: PUBLIC, mapboxConfigured: true, mapboxTokenRejected: false }),
    ));
    const cfg = await loadMapConfig(ENGINE);
    expect(cfg.token).toBe(PUBLIC);
    expect(cfg.rejected).toBe(false);
  });

  it('requests the map-config endpoint, not the token from a bundle', async () => {
    const f = vi.fn().mockResolvedValue(okJson({ mapboxToken: PUBLIC }));
    vi.stubGlobal('fetch', f);
    await loadMapConfig(ENGINE);
    expect(String(f.mock.calls[0][0])).toContain('/api/v2/map-config');
  });

  it('REJECTS a secret token even if the backend sends one', async () => {
    // Defence in depth: the backend already withholds sk. tokens, but the
    // client must not trust that.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ mapboxToken: SECRET })));
    expect((await loadMapConfig(ENGINE)).token).toBe('');
  });

  it('caches — one network call however many callers ask', async () => {
    const f = vi.fn().mockResolvedValue(okJson({ mapboxToken: PUBLIC }));
    vi.stubGlobal('fetch', f);
    await Promise.all([loadMapConfig(ENGINE), loadMapConfig(ENGINE), loadMapConfig(ENGINE)]);
    await loadMapConfig(ENGINE);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('degrades to no map when the engine is unreachable — never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(loadMapConfig(ENGINE)).resolves.toEqual({ token: '', rejected: false });
  });

  it('degrades on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }));
    expect((await loadMapConfig(ENGINE)).token).toBe('');
  });

  it('a failed fetch is not cached, so a later attempt can still succeed', async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce(okJson({ mapboxToken: PUBLIC }));
    vi.stubGlobal('fetch', f);
    expect((await loadMapConfig(ENGINE)).token).toBe('');
    expect((await loadMapConfig(ENGINE)).token).toBe(PUBLIC);
  });

  it('surfaces the rejected flag so the UI can explain itself', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJson({ mapboxToken: '', mapboxConfigured: false, mapboxTokenRejected: true }),
    ));
    expect((await loadMapConfig(ENGINE)).rejected).toBe(true);
  });
});

describe('no engine configured', () => {
  it('returns no map without attempting a request', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(loadMapConfig('')).resolves.toEqual({ token: '', rejected: false });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('mapboxTokenSync', () => {
  it('is empty before the fetch resolves, populated after', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ mapboxToken: PUBLIC })));
    expect(mapboxTokenSync()).toBe('');
    await loadMapConfig(ENGINE);
    expect(mapboxTokenSync()).toBe(PUBLIC);
  });

  it('stays empty when the token was refused (PDF then renders basemap-less)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ mapboxToken: SECRET })));
    await loadMapConfig(ENGINE);
    expect(mapboxTokenSync()).toBe('');
  });
});
