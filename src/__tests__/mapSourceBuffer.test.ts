// v1.12.3 — the H3 suitability surface must survive a write that lands while
// the Mapbox style is mid-settle.
//
// Live failure, measured in the browser on the deployed portal: a finished
// analysis pushed 53 hexGrid cells into MapView, the component built all 53
// features, and nothing rendered. Reading the page's own state showed the
// component buffer holding 53 features while the `sg-hex` source held 0.
//
// v1.12.0 DROPPED a payload written while `isStyleLoaded()` was false.
// v1.12.2 buffered it instead — but drained the buffer only from the `load` /
// `style.load` handlers, which fire once at startup and never again unless the
// basemap is swapped. An analysis finishes minutes later, during the camera
// move to the study area, when the style is busy: the payload was buffered and
// then stranded forever. Different mechanism, identical outcome.
//
// These tests pin the contract that fixes it: an unappliable write ARMS ITS
// OWN retry instead of trusting an event that may already be in the past.

import { describe, it, expect } from 'vitest';
import { createSourceBuffer } from '../services/mapSourceBuffer';

const fc = (n: number): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: Array.from({ length: n }, () => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [0, 0] },
  })) as GeoJSON.Feature[],
});

/** A fake map exposing only what the buffer touches, plus test controls. */
function fakeMap({ styleLoaded = true }: { styleLoaded?: boolean } = {}) {
  const applied: Record<string, GeoJSON.FeatureCollection> = {};
  const sources: Record<string, { setData: (d: GeoJSON.FeatureCollection) => void }> = {};
  const listeners: Record<string, Array<() => void>> = {};
  let loaded = styleLoaded;

  return {
    isStyleLoaded: () => loaded,
    getSource: (id: string) => sources[id],
    once: (ev: string, cb: () => void) => { (listeners[ev] ||= []).push(cb); },

    // ── test controls ──
    addSource(id: string) {
      sources[id] = { setData: (d) => { applied[id] = d; } };
    },
    setStyleLoaded(v: boolean) { loaded = v; },
    fire(ev: string) {
      const cbs = listeners[ev] || [];
      listeners[ev] = [];
      cbs.forEach((cb) => cb());
    },
    listenerCount: (ev: string) => (listeners[ev] || []).length,
    applied,
  };
}

describe('createSourceBuffer', () => {
  it('applies immediately when the style is settled and the source exists', () => {
    const map = fakeMap();
    map.addSource('sg-hex');
    const buf = createSourceBuffer(() => map);

    buf.setData('sg-hex', fc(53));

    expect(map.applied['sg-hex'].features).toHaveLength(53);
    expect(map.listenerCount('idle')).toBe(0);   // no retry needed
  });

  // ── THE REGRESSION ──
  it('delivers a payload written while the style is mid-settle, with no further load event', () => {
    const map = fakeMap({ styleLoaded: false });
    map.addSource('sg-hex');                      // sources exist; style is busy
    const buf = createSourceBuffer(() => map);

    buf.setData('sg-hex', fc(53));

    // v1.12.2 behaviour: buffered but not applied, and nothing would retry.
    expect(map.applied['sg-hex']).toBeUndefined();
    expect(buf.pending()['sg-hex'].features).toHaveLength(53);
    // v1.12.3: the write armed its own retry.
    expect(map.listenerCount('idle')).toBe(1);

    map.setStyleLoaded(true);
    map.fire('idle');

    expect(map.applied['sg-hex'].features).toHaveLength(53);
  });

  it('retries when the style is settled but the sources are not installed yet', () => {
    const map = fakeMap({ styleLoaded: true });   // no addSource() yet
    const buf = createSourceBuffer(() => map);

    buf.setData('sg-hex', fc(7));
    expect(map.applied['sg-hex']).toBeUndefined();
    expect(map.listenerCount('idle')).toBe(1);

    map.addSource('sg-hex');
    map.fire('idle');

    expect(map.applied['sg-hex'].features).toHaveLength(7);
  });

  it('arms a single retry no matter how many sources are buffered', () => {
    const map = fakeMap({ styleLoaded: false });
    ['sg-hex', 'sg-aoi', 'sg-catchment'].forEach((id) => map.addSource(id));
    const buf = createSourceBuffer(() => map);

    buf.setData('sg-hex', fc(53));
    buf.setData('sg-aoi', fc(1));
    buf.setData('sg-catchment', fc(2));

    expect(map.listenerCount('idle')).toBe(1);

    map.setStyleLoaded(true);
    map.fire('idle');

    expect(map.applied['sg-hex'].features).toHaveLength(53);
    expect(map.applied['sg-aoi'].features).toHaveLength(1);
    expect(map.applied['sg-catchment'].features).toHaveLength(2);
  });

  it('is last-write-wins per source', () => {
    const map = fakeMap({ styleLoaded: false });
    map.addSource('sg-hex');
    const buf = createSourceBuffer(() => map);

    buf.setData('sg-hex', fc(53));
    buf.setData('sg-hex', fc(4));                 // e.g. a weight-slider recolour

    map.setStyleLoaded(true);
    map.fire('idle');

    expect(map.applied['sg-hex'].features).toHaveLength(4);
  });

  it('flush() restores every layer after a basemap swap wipes the sources', () => {
    const map = fakeMap();
    map.addSource('sg-hex');
    map.addSource('sg-aoi');
    const buf = createSourceBuffer(() => map);

    buf.setData('sg-hex', fc(53));
    buf.setData('sg-aoi', fc(1));

    // A style swap wipes custom sources; installLayers() recreates them empty.
    const fresh = fakeMap();
    fresh.addSource('sg-hex');
    fresh.addSource('sg-aoi');
    const buf2 = createSourceBuffer(() => fresh);
    buf2.setData('sg-hex', fc(53));
    buf2.setData('sg-aoi', fc(1));
    fresh.applied['sg-hex'] = fc(0);
    fresh.applied['sg-aoi'] = fc(0);

    buf2.flush();

    expect(fresh.applied['sg-hex'].features).toHaveLength(53);
    expect(fresh.applied['sg-aoi'].features).toHaveLength(1);
  });

  it('buffers writes made before the map exists', () => {
    let map: ReturnType<typeof fakeMap> | null = null;
    const buf = createSourceBuffer(() => map);

    buf.setData('sg-hex', fc(53));                // no map yet — must not throw
    expect(buf.pending()['sg-hex'].features).toHaveLength(53);

    map = fakeMap();
    map.addSource('sg-hex');
    buf.flush();                                  // the load handler's flush

    expect(map.applied['sg-hex'].features).toHaveLength(53);
  });

  it('does not throw when a source id is unknown to the style', () => {
    const map = fakeMap();
    const buf = createSourceBuffer(() => map);

    expect(() => {
      buf.setData('sg-nope', fc(1));
      map.fire('idle');
    }).not.toThrow();
  });
});
