// v1.11.5 — the results drawer must never crush its own content.
//
// Regression introduced in v1.11.1: the answer-first reorder made
// `.drawer-body` a column flex container so blocks could be resequenced with
// `order` without moving their JSX. Flex items default to `flex-shrink: 1`, so
// once the panel's content exceeded the drawer height the browser SHRANK every
// child to fit instead of letting the container scroll. Measured in a browser
// against the real stylesheet: a 900px zone list rendered at 236px, and the
// "Technical diagnostics" / "Analysis Assumptions" / "Evidence Trail"
// expanders collapsed into near-invisible hairlines. Reported live as
// "there is no show more technical/confidence details".
//
// These assert the two CSS facts that must hold together. jsdom does not run
// flex layout, so this guards the stylesheet contract rather than re-measuring
// pixels (that measurement was done in a real browser at fix time).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const css = readFileSync(resolve(__dirname, '../styles/main.css'), 'utf-8');

/** Body of the first rule whose selector matches exactly. */
function ruleBody(selector: string): string {
  const re = new RegExp(
    `(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'm',
  );
  const m = css.match(re);
  return m ? m[2] : '';
}

describe('.drawer-body flex layout', () => {
  it('is a column flex container (the order-based reorder depends on it)', () => {
    const body = ruleBody('.drawer-body');
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  it('scrolls vertically rather than clipping', () => {
    expect(ruleBody('.drawer-body')).toMatch(/overflow-y:\s*auto/);
  });

  it('pins children to flex-shrink:0 so they keep their natural height', () => {
    // Without this the container silently crushes the zone list and the
    // collapsed diagnostic expanders instead of scrolling.
    expect(ruleBody('.drawer-body > *')).toMatch(/flex-shrink:\s*0/);
  });

  it('the shrink guard comes AFTER the flex declaration (cascade order)', () => {
    const flexAt = css.indexOf('.drawer-body {');
    const guardAt = css.indexOf('.drawer-body > * {');
    expect(flexAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(flexAt);
  });
});
