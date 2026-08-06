/**
 * v1.12.0 — fetch the Mapbox token at runtime instead of baking it into the bundle.
 *
 * The first cut of the Mapbox migration injected the token at build time via
 * VITE_MAPBOX_TOKEN. Vite inlines env vars as string literals, so the token
 * ended up in the shipped JS — and GitHub push protection rejected every
 * gh-pages deploy because of it. Fetching it from the engine at startup means:
 *
 *   • the token never enters the repo or any build artifact, so a deploy can
 *     never be blocked by secret scanning again;
 *   • it can be rotated by updating one Cloud Run env var — no frontend rebuild;
 *   • the backend refuses to serve anything but a public `pk.` token.
 *
 * It is still a public value (readable from the network tab) — that is inherent
 * to any browser map. Its real protection is the URL restriction on the Mapbox
 * account.
 */
import { config } from '../config';
import { publicMapboxToken } from './mapboxToken';

export interface MapConfig {
  token: string;
  /** A token IS configured on the backend but was rejected for not being public. */
  rejected: boolean;
}

const EMPTY: MapConfig = { token: '', rejected: false };

// One in-flight request shared by every caller (MapView + the PDF figure).
let inflight: Promise<MapConfig> | null = null;
let resolved: MapConfig | null = null;

/**
 * Cached fetch. Never rejects — a failure means "no map", not a broken app.
 * `baseUrl` defaults to the configured engine; it is a parameter only so tests
 * can drive it without reaching into the frozen config object.
 */
export function loadMapConfig(baseUrl: string = config.pyBackendUrl): Promise<MapConfig> {
  if (resolved) return Promise.resolve(resolved);
  if (inflight) return inflight;

  const base = baseUrl;
  if (!base) {
    resolved = EMPTY;
    return Promise.resolve(EMPTY);
  }

  inflight = fetch(`${base}/api/v2/map-config`, { method: 'GET' })
    .then(r => (r.ok ? r.json() : null))
    .then((body: any) => {
      const out: MapConfig = body
        // Re-validate client-side too: never trust that the far end kept its
        // promise about only sending public tokens.
        ? { token: publicMapboxToken(body.mapboxToken), rejected: !!body.mapboxTokenRejected }
        : EMPTY;
      resolved = out;
      return out;
    })
    .catch(() => {
      // Engine unreachable — degrade to no map, don't blow up the page. Not
      // cached, so a later attempt can still succeed.
      inflight = null;
      return EMPTY;
    });

  return inflight;
}

/** The token if already loaded, '' otherwise. For sync call sites. */
export function mapboxTokenSync(): string {
  return resolved?.token ?? '';
}

/** Test seam — clears the module-level cache. */
export function __resetMapConfigCache(): void {
  inflight = null;
  resolved = null;
}
