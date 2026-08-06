// v1.12.0 — a Mapbox SECRET token must never reach the browser bundle.
//
// Real incident during this migration: an `sk.` token was placed in the
// VITE_MAPBOX_TOKEN build secret. Mapbox issues `sk.` (not `pk.`) the moment
// any scope under "Secret scopes" is ticked on the create-token screen, and the
// two are one letter apart with an identical-looking `eyJ…` body. The bundle
// built fine and GitHub's push protection blocked the deploy — that block was
// the only thing preventing a secret token being published to a public repo.
//
// These tests pin the guard that now makes it un-shippable rather than relying
// on GitHub to notice. All token strings below are synthetic.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { isPublicMapboxToken, publicMapboxToken } from '../services/mapboxToken';

// Shapes only — not real credentials.
const PUBLIC_TOKEN = 'pk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbGV4YW1wbGUifQ.AbCdEfGhIjKlMnOpQr';
const SECRET_TOKEN = 'sk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbGV4YW1wbGUifQ.AbCdEfGhIjKlMnOpQr';

afterEach(() => vi.restoreAllMocks());

describe('isPublicMapboxToken', () => {
  it('accepts a public pk. token', () => {
    expect(isPublicMapboxToken(PUBLIC_TOKEN)).toBe(true);
  });

  it('rejects a secret sk. token', () => {
    expect(isPublicMapboxToken(SECRET_TOKEN)).toBe(false);
  });

  it('rejects empty, missing and non-string values', () => {
    expect(isPublicMapboxToken('')).toBe(false);
    expect(isPublicMapboxToken(undefined)).toBe(false);
    expect(isPublicMapboxToken(null)).toBe(false);
    expect(isPublicMapboxToken(123 as unknown as string)).toBe(false);
  });

  it('rejects placeholders that merely start with pk.', () => {
    expect(isPublicMapboxToken('pk.')).toBe(false);
    expect(isPublicMapboxToken('pk.TODO')).toBe(false);
    expect(isPublicMapboxToken('your-token-here')).toBe(false);
  });
});

describe('publicMapboxToken', () => {
  it('passes a public token straight through', () => {
    expect(publicMapboxToken(PUBLIC_TOKEN)).toBe(PUBLIC_TOKEN);
  });

  it('DISCARDS a secret token — the whole point of the guard', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(publicMapboxToken(SECRET_TOKEN)).toBe('');
  });

  it('explains loudly why the map was disabled by a secret token', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    publicMapboxToken(SECRET_TOKEN);
    expect(err).toHaveBeenCalledTimes(1);
    const msg = String(err.mock.calls[0][0]);
    expect(msg).toMatch(/SECRET/i);
    expect(msg).toMatch(/never ship/i);
  });

  it('never echoes the offending token value into the console', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    publicMapboxToken(SECRET_TOKEN);
    expect(String(err.mock.calls[0][0])).not.toContain(SECRET_TOKEN);
  });

  it('returns empty for an absent token without shouting', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(publicMapboxToken('')).toBe('');
    expect(publicMapboxToken(undefined)).toBe('');
    expect(err).not.toHaveBeenCalled();   // no token configured is a normal local build
  });

  it('trims incidental whitespace from a pasted secret', () => {
    expect(publicMapboxToken(`  ${PUBLIC_TOKEN}\n`)).toBe(PUBLIC_TOKEN);
  });

  it('never throws — a bad token disables the map, it does not break the app', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => publicMapboxToken(SECRET_TOKEN)).not.toThrow();
    expect(() => publicMapboxToken('garbage')).not.toThrow();
    expect(() => publicMapboxToken(null)).not.toThrow();
  });
});
