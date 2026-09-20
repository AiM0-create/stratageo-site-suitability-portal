// v2.7.1 — security sweep of the portal (20 Sep 2026).
//
// Frontend findings that can be pinned as text contracts:
//   * the zone-pin tooltip is the one innerHTML template on the map and it
//     embedded the zone name raw. Names come from the engine — or from a
//     shared analysis document another signed-in user wrote to Firestore and
//     sent as a link — so a crafted name ran in the viewer's session.
//   * the PDF library was loaded from a CDN with no subresource integrity;
//     html2canvas was loaded and never used.
//   * firestore.rules granted LIST on analyses/ to the world.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { escapeHtml } from '../components/MapView';

const root = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('zone-pin tooltip', () => {
  it('escapes every HTML-significant character in a zone name', () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">&'`)).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;');
    expect(escapeHtml('Priority 1')).toBe('Priority 1');
  });
  it('is applied to the name inside the innerHTML template', () => {
    const src = read('src/components/MapView.tsx');
    expect(src).toMatch(/\$\{escapeHtml\(name\)\}/);
    // no other raw interpolation of `name` into markup
    expect(src).not.toMatch(/<\/strong> \$\{name\}/);
  });
});

describe('third-party scripts', () => {
  const html = read('index.html');
  it('every CDN script carries subresource integrity', () => {
    const tags = html.match(/<script[^>]+src="https?:\/\/[^"]+"[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) {
      expect(t, t).toMatch(/integrity="sha(256|384|512)-/);
      expect(t, t).toMatch(/crossorigin="anonymous"/);
    }
  });
  it('does not load libraries nothing uses', () => {
    expect(html).not.toMatch(/html2canvas/);
  });
});

describe('firestore rules', () => {
  const rules = read('firestore.rules');
  it('shared analyses can be fetched by id but not enumerated', () => {
    const block = rules.slice(rules.indexOf('match /analyses/{id}'));
    expect(block).toMatch(/allow get:\s+if true;/);
    expect(block).toMatch(/allow list:\s+if isOwner\(resource\.data\.userId\) \|\| isAdmin\(\);/);
    expect(block).not.toMatch(/allow read:\s+if true;/);
  });
  it('users cannot grant themselves admin or reset their quota', () => {
    expect(rules).toMatch(/request\.resource\.data\.isAdmin == resource\.data\.isAdmin/);
    expect(rules).toMatch(/promptsUsed == resource\.data\.promptsUsed \+ 1/);
  });
});
