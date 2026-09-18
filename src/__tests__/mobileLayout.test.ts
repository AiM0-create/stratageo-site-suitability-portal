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

  it('the drawer is a bottom sheet with three heights, never a full-screen cover', () => {
    const drawer = ruleIn(block, '.drawer');
    expect(drawer).toMatch(/bottom:\s*0/);
    expect(drawer).toMatch(/top:\s*auto/);
    expect(ruleIn(block, '.drawer-sheet-peek')).toMatch(/translateY\(calc\(100% - var\(--sheet-peek\)\)\)/);
    expect(ruleIn(block, '.drawer-sheet-half')).toMatch(/translateY\(50%\)/);
    expect(ruleIn(block, '.drawer-sheet-full')).toMatch(/translateY\(0\)/);
    // "closed" on a phone still peeks — the map never loses the results
    expect(ruleIn(block, '.drawer-open, .drawer-closed')).toMatch(/var\(--sheet-peek\)/);
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
  it('everything a thumb has to hit is at least 44px on coarse pointers', () => {
    const start = css.indexOf('@media (hover: none) and (pointer: coarse)');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('\n}\n', start));
    for (const sel of ['.drawer-close', '.drawer-expand', '.spec-factor-remove', '.assistant-toggle', '.new-chat-btn']) {
      expect(block).toContain(sel);
    }
    expect(block).toMatch(/min-width:\s*44px;\s*min-height:\s*44px/);
    expect(block).toMatch(/\.spec-factor-slider\s*\{\s*height:\s*32px/);
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
