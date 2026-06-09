/**
 * Shared regex patterns used by both the backend (analyze.js) and the
 * frontend contextResolver.ts for consistent reset / follow-up detection.
 *
 * Single source of truth — update here, both paths get the fix.
 */

/**
 * Phrases that explicitly request a fresh start.
 * When any of these matches, discard prior session context entirely.
 */
export const RESET_PATTERNS = [
  /\bignore\s+(everything|all|that|the\s+(above|previous|last|prior))\b/i,
  /\bstart\s+(fresh|from\s+scratch|over|a\s+new)\b/i,
  /\bforget\s+(everything|all|that|the\s+(above|previous|last|prior)|previous\s+analysis)\b/i,
  /\bnew\s+(analysis|query|request|search|case)\b/i,
  /\bseparate\s+(analysis|case|query)\b/i,
  /\bdifferent\s+(business|case|query|analysis)\b/i,
  /\bfresh\s+(analysis|start|query)\b/i,
  /\bfrom\s+scratch\b/i,
  /\bdiscard\s+(prior|previous|the)\b/i,
  /\bnew\s+search\b/i,           // "new search for X" is clearly a reset
  /\bstart\s+again\b/i,          // common conversational reset
  /\breset\s+(the\s+)?(analysis|search|query|context)\b/i,
];

/**
 * Test a prompt against all reset patterns.
 * @param {string} prompt
 * @returns {boolean}
 */
export function isResetIntent(prompt) {
  return RESET_PATTERNS.some(p => p.test(prompt));
}
