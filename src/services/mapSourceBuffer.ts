// ─── GeoJSON source write buffer (v1.12.3) ───
//
// Live failure this exists for: a finished analysis pushed a 53-cell `hexGrid`
// into MapView, the component built all 53 features correctly, and the H3
// surface still never appeared. Measured in the browser on the live portal:
// the component's own buffer held 53 features while the Mapbox source
// `sg-hex` held 0.
//
// The cause is a write that lands while the style is mid-settle. Mapbox's
// `isStyleLoaded()` is false not only during first load but any time the style
// is busy — including right after the camera flies to a freshly-returned study
// area, which is exactly when results arrive. v1.12.0 dropped such a payload
// outright. v1.12.2 started BUFFERING it instead, but only ever flushed the
// buffer from the `load` / `style.load` handlers — both of which fired long
// before the analysis finished and never fire again unless the basemap is
// swapped. So the payload was buffered and then sat there forever: different
// mechanism, identical outcome (no grid).
//
// The rule that fixes it: a write that could not be applied must ARM ITS OWN
// retry rather than trust an event that may already be in the past. `idle`
// fires once the style has settled and is guaranteed to come after a busy
// style, so one armed listener drains the whole buffer. Writes remain
// last-write-wins per source id, and flush() is still exposed for the
// style-swap path, where every custom source is wiped and must be rebuilt.

/** The slice of a Mapbox GL map this module needs — narrow, so tests can fake it. */
export interface BufferableMap {
  isStyleLoaded(): boolean;
  getSource(id: string): any;
  once(type: string, listener: (...args: any[]) => void): any;
}

export interface SourceBuffer {
  /** Write (or re-write) a source's data, applying it as soon as it can land. */
  setData(id: string, data: GeoJSON.FeatureCollection): void;
  /** Re-apply every buffered payload — used after a style (re)load. */
  flush(): void;
  /** Snapshot of what is buffered. Test/diagnostic aid. */
  pending(): Record<string, GeoJSON.FeatureCollection>;
}

const isWritable = (src: any): boolean => !!src && typeof src.setData === 'function';

/** Timer fallback cadence and cap: ~30 s of retries, then stop trying. */
export const RETRY_INTERVAL_MS = 750;
export const RETRY_MAX_ATTEMPTS = 40;

export function createSourceBuffer(getMap: () => BufferableMap | null): SourceBuffer {
  const pending: Record<string, GeoJSON.FeatureCollection> = {};
  /** True while a retry is already armed — one drain covers every id. */
  let flushArmed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };

  const flush = (): void => {
    flushArmed = false;
    clearTimer();
    const map = getMap();
    if (!map) return;
    for (const [id, data] of Object.entries(pending)) {
      const src = map.getSource(id);
      if (isWritable(src)) src.setData(data);
    }
  };

  /** Apply everything that CAN be applied right now; true if nothing is left. */
  const tryApplyAll = (map: BufferableMap): boolean => {
    if (!map.isStyleLoaded()) return false;
    let allDone = true;
    for (const [id, data] of Object.entries(pending)) {
      const src = map.getSource(id);
      if (isWritable(src)) src.setData(data);
      else allDone = false;
    }
    return allDone;
  };

  const armFlush = (map: BufferableMap): void => {
    if (flushArmed) return;
    flushArmed = true;
    map.once('idle', flush);
    // v1.13.1 — `idle` lives inside the render loop, and browsers pause that
    // loop for a tab that is hidden or occluded. A customer who switches tabs
    // during the two-minute run — the most ordinary thing — would come back
    // to a source that only fills once frames resume and settle. setData
    // does not need a frame; only drawing does. So retry on a timer as well,
    // and the data is in the source the moment a frame does render.
    // Observed while automating a background tab: buffer 54, source 0,
    // requestAnimationFrame never firing, basemap blank until a forced paint.
    let attempts = 0;
    const tick = () => {
      timer = null;
      if (!flushArmed) return;                 // idle got there first
      const m = getMap();
      if (m && tryApplyAll(m)) { flushArmed = false; return; }
      if (++attempts < RETRY_MAX_ATTEMPTS) { timer = setTimeout(tick, RETRY_INTERVAL_MS); return; }
      flushArmed = false;                      // give up, but let the next write re-arm
    };
    timer = setTimeout(tick, RETRY_INTERVAL_MS);
  };

  const setData = (id: string, data: GeoJSON.FeatureCollection): void => {
    pending[id] = data;                    // always keep the latest
    const map = getMap();
    if (!map) return;                      // pre-map write; flushed on load
    // Both conditions matter: the style can be settled while our sources have
    // not been installed yet, and the sources can exist while the style is busy.
    const src = map.isStyleLoaded() ? map.getSource(id) : undefined;
    if (isWritable(src)) {
      src.setData(data);
      return;
    }
    armFlush(map);
  };

  return { setData, flush, pending: () => ({ ...pending }) };
}
