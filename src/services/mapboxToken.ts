/**
 * v1.12.0 — refuse to ship anything but a PUBLIC Mapbox token.
 *
 * Mapbox issues two kinds of token:
 *   `pk.…`  public — designed to be readable in a client bundle, protected by a
 *                    URL restriction on the account rather than by secrecy.
 *   `sk.…`  secret — can modify the account (styles, datasets, tokens). It must
 *                    NEVER reach a browser bundle.
 *
 * A secret token is what you get from Mapbox's "Create a token" screen the
 * moment any scope under *Secret scopes* is ticked, and the two look nearly
 * identical afterwards — same `eyJ…` body, one letter apart. During this
 * migration an `sk.` token was placed in the VITE_MAPBOX_TOKEN build secret;
 * GitHub's push protection caught it in the built bundle and blocked the
 * deploy, which is the only reason it was not published to a public repo.
 *
 * This guard makes that failure mode impossible to ship rather than relying on
 * GitHub to catch it: a non-public token is discarded, the map degrades to its
 * "Map unavailable" state, and a loud console error explains why.
 */

/** True only for a well-formed public (`pk.`) Mapbox token. */
export function isPublicMapboxToken(raw: string | undefined | null): boolean {
  if (typeof raw !== 'string') return false;
  const t = raw.trim();
  // pk. + a JWT-ish body. Length floor keeps obvious placeholders out.
  return /^pk\.[A-Za-z0-9_-]{10,}\./.test(t) || /^pk\.[A-Za-z0-9_.-]{20,}$/.test(t);
}

/**
 * Return the token only if it is safe to embed in the bundle; '' otherwise.
 * Never throws — a bad token must degrade the map, not break the whole app.
 */
export function publicMapboxToken(raw: string | undefined | null): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  if (t.startsWith('sk.')) {
    // eslint-disable-next-line no-console
    console.error(
      '[StrataGeo] VITE_MAPBOX_TOKEN is a Mapbox SECRET token (sk.). Secret tokens ' +
      'can modify your Mapbox account and must never ship in a browser bundle. ' +
      'The map has been disabled. Revoke this token in the Mapbox console and ' +
      'replace it with a public (pk.) token restricted to this site.',
    );
    return '';
  }
  if (!isPublicMapboxToken(t)) {
    // eslint-disable-next-line no-console
    console.error(
      '[StrataGeo] VITE_MAPBOX_TOKEN is not a valid public Mapbox token ' +
      '(expected it to start with "pk."). The map has been disabled.',
    );
    return '';
  }
  return t;
}
