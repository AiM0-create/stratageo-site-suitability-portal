// v2.3.0 — the mobile pass.
//
// Live at 390px (17 Sep 2026): the results drawer was a full-screen sheet over
// the map — map and results were never on screen together — and the only way
// back to it was a 24px icon; "Sign out" was clipped off the top bar; five
// permanent marker labels covered the zoom controls; slider thumbs, the × on
// a factor and the expand chevrons were 14–24px targets; the previous
// analysis's pins stayed under a new brief's clarification.
//
// jsdom runs no layout, so — as in drawerLayout.test.ts — these assert the
// stylesheet contract and the pure sheet-state logic rather than pixels.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stepSheet, tapSheet, resolveSheetGesture, DRAG_THRESHOLD_PX, SHEET_PEEK_PX } from '../services/sheetState';
import { PHONE_MAX_WIDTH_PX } from '../services/phoneLayout';

const css = readFileSync(resolve(__dirname, '../styles/main.css'), 'utf-8');
const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf-8');

/** The body of the `@media (max-width: 640px)` block that holds the sheet. */
function phoneBlock(): string {
  const start = css.indexOf(`@media (max-width: ${PHONE_MAX_WIDTH_PX}px)`);
  expect(start).toBeGreaterThan(-1);
  // first block only — walk braces
  let depth = 0, i = css.indexOf('{', start);
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) break;
  }
  return css.slice(start, i);
}
function ruleIn(block: string, selector: string): string {
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const m = block.match(re);
  return m ? m[2] : '';
}

describe('sheet state machine', () => {
  it('steps one state at a time and clamps at the ends', () => {
    expect(stepSheet('peek', 'up')).toBe('half');
    expect(stepSheet('half', 'up')).toBe('full');
    expect(stepSheet('full', 'up')).toBe('full');
    expect(stepSheet('full', 'down')).toBe('half');
    expect(stepSheet('half', 'down')).toBe('peek');
    expect(stepSheet('peek', 'down')).toBe('peek');
  });
  it('a tap never collapses straight to peek (that is the close button)', () => {
    expect(tapSheet('peek')).toBe('half');
    expect(tapSheet('half')).toBe('full');
    expect(tapSheet('full')).toBe('half');
  });
  it('a short drag is a tap; a long drag steps in its direction', () => {
    expect(resolveSheetGesture('half', 0)).toBe('full');
    expect(resolveSheetGesture('half', DRAG_THRESHOLD_PX - 1)).toBe('full');
    expect(resolveSheetGesture('half', DRAG_THRESHOLD_PX)).toBe('peek');
    expect(resolveSheetGesture('half', -DRAG_THRESHOLD_PX)).toBe('full');
    expect(resolveSheetGesture('peek', -200)).toBe('half');
  });
});

describe('phone stylesheet contract', () => {
  const block = phoneBlock();

  it('the peek height in CSS matches SHEET_PEEK_PX', () => {
    expect(block).toMatch(new RegExp(`--sheet-peek:\\s*${SHEET_PEEK_PX}px`));
  });

  it('the drawer is a FIXED bottom sheet whose height changes, in dvh (v2.4.2)', () => {
    // A translated full-height panel inside a 100vh container put the peek
    // bar below a real phone's screen edge and ran the half state's scroll
    // body off the bottom (only Priority 1 reachable). Owner's phone, 18 Sep.
    const drawer = ruleIn(block, '.drawer');
    expect(drawer).toMatch(/position:\s*fixed/);
    expect(drawer).toMatch(/bottom:\s*0/);
    expect(drawer).toMatch(/top:\s*auto/);
    expect(drawer).toMatch(/transition:\s*height/);
    expect(drawer).not.toMatch(/100vh/);
    expect(ruleIn(block, '.drawer-sheet-peek')).toMatch(/height:\s*calc\(var\(--sheet-peek\)/);
    expect(ruleIn(block, '.drawer-sheet-half')).toMatch(/height:\s*50dvh/);
    expect(ruleIn(block, '.drawer-sheet-full')).toMatch(/height:\s*calc\(100dvh - 48px\)/);
    // the desktop slide-in transform must not apply on a phone
    expect(ruleIn(block, '.drawer-open, .drawer-closed')).toMatch(/transform:\s*none/);
    // the shell itself uses the visible viewport
    expect(ruleIn(css, '.portal')).toMatch(/height:\s*100dvh/);
  });

  it('the sheet header is a drag handle (touch-action none, grip visible)', () => {
    expect(ruleIn(block, '.drawer-sheet .drawer-header')).toMatch(/touch-action:\s*none/);
    expect(ruleIn(block, '.drawer-grip')).toMatch(/display:\s*block/);
    expect(ruleIn(css, '.drawer-grip')).toMatch(/display:\s*none/);   // desktop: no grip
  });

  it('the assistant sits above a peeking sheet and steps aside for an open one', () => {
    expect(ruleIn(block, '.assistant.assistant-above-sheet')).toMatch(/bottom:\s*calc\(var\(--sheet-peek\)/);
    expect(ruleIn(block, '.assistant.assistant-behind-sheet')).toMatch(/display:\s*none/);
  });

  it('the top bar swaps its action row for one menu', () => {
    expect(ruleIn(block, '.topbar-right-desktop')).toMatch(/display:\s*none/);
    expect(ruleIn(block, '.topbar-right-phone')).toMatch(/display:\s*flex/);
    expect(ruleIn(css, '.topbar-right-phone')).toMatch(/display:\s*none/);   // desktop: hidden
    expect(ruleIn(css, '.topbar-menu-item')).toMatch(/min-height:\s*44px/);
  });

  it('only the selected zone keeps its permanent map label', () => {
    expect(ruleIn(block, '.sg-marker-label')).toMatch(/display:\s*none/);
    expect(ruleIn(block, '.sg-marker-selected .sg-marker-label')).toMatch(/display:\s*block/);
  });

  it('the single Run button is primary on a phone', () => {
    expect(ruleIn(block, '.assistant-start-btn')).toMatch(/width:\s*100%/);
  });
});

describe('touch targets', () => {
  const start = css.indexOf('@media (hover: none) and (pointer: coarse)');
  const block = css.slice(start, css.indexOf('\n}\n', start));

  it('icon buttons are 44px on coarse pointers', () => {
    expect(start).toBeGreaterThan(-1);
    for (const sel of ['.drawer-close', '.drawer-expand', '.assistant-toggle', '.new-chat-btn']) {
      expect(block).toContain(sel);
    }
    expect(block).toMatch(/min-width:\s*44px;\s*min-height:\s*44px/);
  });

  it('the factor card stays two rows: name · % · × then the chips (v2.4.1)', () => {
    // 44px on the × and 40px on the direction chip made every card three
    // ragged rows on a real 375px emulation.
    expect(block).toMatch(/\.spec-factor-remove\s*\{\s*min-width:\s*36px;\s*min-height:\s*36px/);
    expect(block).toMatch(/\.spec-dir-toggle\s*\{\s*min-height:\s*30px/);
    expect(block).toMatch(/\.spec-factor-slider\s*\{\s*height:\s*30px/);
    expect(block).toMatch(/\.spec-factor-head::after\s*\{[^}]*flex-basis:\s*100%/);
    expect(block).toMatch(/\.spec-factor-name\s*\{\s*order:\s*1/);
    expect(block).toMatch(/\.spec-dir-toggle, \.spec-origin, \.spec-proxy-flag\s*\{\s*order:\s*5/);
  });
});

describe('phone width', () => {
  it('the assistant and the spot card span the full width below 480px (a 94% left-aligned panel left a gap)', () => {
    const start = css.indexOf('@media (max-width: 480px)');
    const block = css.slice(start, css.indexOf('\n}\n', start));
    expect(ruleIn(block, '.assistant')).toMatch(/width:\s*100%/);
    expect(ruleIn(block, '.spot-card')).toMatch(/width:\s*100%/);
  });
});

describe('installable', () => {
  it('index.html links a manifest and a theme colour with Pages-safe relative paths', () => {
    expect(html).toMatch(/<link rel="manifest" href="manifest\.webmanifest">/);
    expect(html).toMatch(/<meta name="theme-color"/);
    expect(html).not.toMatch(/href="\/manifest/);
  });
  it('the manifest is valid and standalone', () => {
    const m = JSON.parse(readFileSync(resolve(__dirname, '../../public/manifest.webmanifest'), 'utf-8'));
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('./');
    expect(m.icons.some((i: any) => i.sizes === '512x512')).toBe(true);
    expect(m.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
  });
});
