/**
 * v2.3.0 — the results panel on a phone is a bottom sheet with three states.
 *
 * Live (390 px, 17 Sep 2026): the results drawer was a full-screen sheet over
 * the map. To see the zones on the map you closed the drawer; to get it back
 * you found a 24 px icon in the assistant bar. Map and results were never on
 * screen together — on a map-first product.
 *
 *   peek  — the header only; the map has the screen
 *   half  — the answer and the first zones; pins still visible above
 *   full  — everything, scrollable
 *
 * The transitions are a pure function so the gesture code stays trivial and
 * the behaviour is unit-tested without a browser.
 */
export type SheetState = 'peek' | 'half' | 'full';

const ORDER: SheetState[] = ['peek', 'half', 'full'];

/** Drag up → one state larger; drag down → one state smaller; clamped. */
export function stepSheet(state: SheetState, dir: 'up' | 'down'): SheetState {
  const i = ORDER.indexOf(state);
  const j = dir === 'up' ? Math.min(ORDER.length - 1, i + 1) : Math.max(0, i - 1);
  return ORDER[j];
}

/** Tapping the header: peek → half → full → half (never straight back to peek —
 *  that is what the close button is for). */
export function tapSheet(state: SheetState): SheetState {
  if (state === 'peek') return 'half';
  if (state === 'half') return 'full';
  return 'half';
}

/** A vertical drag shorter than this is a tap, not a state change. */
export const DRAG_THRESHOLD_PX = 40;

/** Height of the peeking header, in CSS px — mirrored in main.css (`--sheet-peek`). */
export const SHEET_PEEK_PX = 56;

/** Interpret the end of a pointer gesture on the sheet header. */
export function resolveSheetGesture(state: SheetState, dy: number): SheetState {
  if (dy <= -DRAG_THRESHOLD_PX) return stepSheet(state, 'up');
  if (dy >= DRAG_THRESHOLD_PX) return stepSheet(state, 'down');
  return tapSheet(state);
}
