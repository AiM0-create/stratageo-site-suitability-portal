/**
 * v2.4.0 — "check a spot": the client side of one pin, one business, one verdict.
 *
 * Location resolution order (all fail-soft, the customer confirms a pin
 * either way):
 *   1. the photo's EXIF GPS   — a fresh camera shot on Android keeps it;
 *                               iOS strips it in the Safari picker; forwards
 *                               and screenshots never have it
 *   2. the device's location  — one permission tap, 5–50 m on a phone
 *   3. the customer drags the pin
 */
import { config } from '../config';
import type { SpecV2 } from '../types/chat';
import { authJsonHeaders } from './chatService';
import { readPhotoGps, type GpsFix } from './exifGps';

export type { GpsFix } from './exifGps';

export type LocationSource = 'photo' | 'device' | 'pin';

/** Where the pin came from, so the confirm step can say so. */
export interface ResolvedLocation extends GpsFix { source: LocationSource; accuracyM?: number }

export async function locationFromPhoto(file: Blob): Promise<ResolvedLocation | null> {
  const fix = await readPhotoGps(file);
  return fix ? { ...fix, source: 'photo' } : null;
}

export function locationFromDevice(timeoutMs = 12000): Promise<ResolvedLocation | null> {
  return new Promise(resolve => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve({
        lat: pos.coords.latitude, lng: pos.coords.longitude,
        source: 'device', accuracyM: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : undefined,
      }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

/** Photo first, then the device. Null means: drop the pin by hand. */
export async function resolveLocation(photo: Blob | null): Promise<ResolvedLocation | null> {
  if (photo) {
    const fromPhoto = await locationFromPhoto(photo);
    if (fromPhoto) return fromPhoto;
  }
  return locationFromDevice();
}

/** POST /api/v2/spot → the composed plan (no credit consumed). v2.5.0 — the
 *  plan is shown and agreed first, then started through the ordinary
 *  chatService.startAnalysis, exactly like an area search. */
export async function planSpotCheck(lat: number, lng: number, business: string): Promise<SpecV2> {
  const r = await fetch(`${config.pyBackendUrl}/api/v2/spot`, {
    method: 'POST', headers: await authJsonHeaders(),
    body: JSON.stringify({ lat, lng, business }),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => null);
    const d = detail?.detail;
    const msg = typeof d === 'string' ? d : (d?.message || d?.error);
    throw new Error(msg || `Could not plan this check (HTTP ${r.status})`);
  }
  const j = await r.json();
  return j.spec as SpecV2;
}

export const VERDICT_LABEL: Record<'good' | 'fair' | 'weak' | 'excluded', string> = {
  good: 'Good spot', fair: 'Fair spot', weak: 'Weak spot', excluded: 'Not usable',
};
