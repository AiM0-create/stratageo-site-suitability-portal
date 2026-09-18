/**
 * v2.4.0 — read the GPS position out of a JPEG's EXIF, in the browser, with
 * no library. The photo never leaves the phone: only the two numbers do.
 *
 * Why hand-rolled: the whole need is four GPS IFD tags (1–4: latitude ref,
 * latitude, longitude ref, longitude). A full EXIF library is 30–60 KB for
 * that. Everything else in the file is skipped.
 *
 * Returns null when there is no EXIF, no GPS IFD, or the file is not a JPEG
 * (HEIC from an iPhone, a screenshot, a WhatsApp forward — all common, all
 * handled by the caller's fallback to the device's own location).
 */
export interface GpsFix { lat: number; lng: number }

const SOI = 0xffd8;
const APP1 = 0xffe1;
const SOS = 0xffda;
const TAG_GPS_IFD = 0x8825;
const TAG_LAT_REF = 0x0001, TAG_LAT = 0x0002, TAG_LNG_REF = 0x0003, TAG_LNG = 0x0004;

export function parseExifGps(buf: ArrayBuffer): GpsFix | null {
  const dv = new DataView(buf);
  if (dv.byteLength < 4 || dv.getUint16(0) !== SOI) return null;

  // walk the JPEG segments to the first APP1 "Exif\0\0"
  let off = 2;
  while (off + 4 <= dv.byteLength) {
    const marker = dv.getUint16(off);
    if (marker === SOS) return null;                   // image data starts: no EXIF ahead
    const len = dv.getUint16(off + 2);
    if (marker === APP1 && off + 10 <= dv.byteLength && dv.getUint32(off + 4) === 0x45786966 /* "Exif" */) {
      return readTiff(dv, off + 10, off + 2 + len);
    }
    if (len < 2) return null;
    off += 2 + len;
  }
  return null;
}

function readTiff(dv: DataView, tiff: number, end: number): GpsFix | null {
  if (tiff + 8 > end) return null;
  const bo = dv.getUint16(tiff);
  const le = bo === 0x4949; if (!le && bo !== 0x4d4d) return null;
  const u16 = (p: number) => dv.getUint16(p, le);
  const u32 = (p: number) => dv.getUint32(p, le);
  if (u16(tiff + 2) !== 42) return null;
  const ifd0 = tiff + u32(tiff + 4);

  // IFD0 → GPS IFD pointer
  const gpsOff = findTag(dv, tiff, ifd0, end, le, TAG_GPS_IFD);
  if (gpsOff === null) return null;
  const gps = tiff + gpsOff;
  if (gps + 2 > end) return null;

  let latRef = '', lngRef = '', lat: number | null = null, lng: number | null = null;
  const n = u16(gps);
  for (let i = 0; i < n; i++) {
    const e = gps + 2 + i * 12;
    if (e + 12 > end) break;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    if (tag === TAG_LAT_REF || tag === TAG_LNG_REF) {
      if (type !== 2) continue;                                  // ASCII
      const ch = String.fromCharCode(dv.getUint8(e + 8));
      if (tag === TAG_LAT_REF) latRef = ch; else lngRef = ch;
    } else if (tag === TAG_LAT || tag === TAG_LNG) {
      if (type !== 5 || count !== 3) continue;                   // 3 × RATIONAL
      const p = tiff + u32(e + 8);
      if (p + 24 > end) continue;
      const parts = [0, 1, 2].map(k => {
        const den = u32(p + k * 8 + 4);
        return den === 0 ? 0 : u32(p + k * 8) / den;
      });
      const deg = parts[0] + parts[1] / 60 + parts[2] / 3600;
      if (tag === TAG_LAT) lat = deg; else lng = deg;
    }
  }
  if (lat === null || lng === null) return null;
  if (latRef === 'S') lat = -lat;
  if (lngRef === 'W') lng = -lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;                       // a zeroed tag, not a fix
  return { lat, lng };
}

function findTag(dv: DataView, tiff: number, ifd: number, end: number, le: boolean, wanted: number): number | null {
  if (ifd + 2 > end) return null;
  const n = dv.getUint16(ifd, le);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return null;
    if (dv.getUint16(e, le) === wanted) return dv.getUint32(e + 8, le);
  }
  return null;
}

/** Read a photo File and return its GPS fix, or null. Never throws. */
export async function readPhotoGps(file: Blob): Promise<GpsFix | null> {
  try {
    // EXIF lives in the first few hundred KB; reading the whole photo is wasted work.
    const head = await file.slice(0, 512 * 1024).arrayBuffer();
    return parseExifGps(head);
  } catch {
    return null;
  }
}
