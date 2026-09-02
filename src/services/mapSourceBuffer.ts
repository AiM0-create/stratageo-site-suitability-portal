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

export function createSourceBuffer(getMap: () => BufferableMap | null): SourceBuffer {
  const pending: Record<string, GeoJSON.FeatureCollection> = {};
  /** True while an `idle` retry is already armed — one drain covers every id. */
  let flushArmed = false;

  const flush = (): void => {
    flushArmed = false;
    const map = getMap();
    if (!map) return;
    for (const [id, data] of Object.entries(pending)) {
      const src = map.getSource(id);
      if (isWritable(src)) src.setData(data);
    }
  };

  const armFlush = (map: BufferableMap): void => {
    if (flushArmed) return;
    flushArmed = true;
    map.once('idle', flush);
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
