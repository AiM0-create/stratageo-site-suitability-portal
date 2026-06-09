/**
 * Shared reset-intent patterns — single source of truth for the frontend.
 *
 * Backend equivalent lives in api/_lib/patterns.js (must be kept in sync).
 * When adding a new reset phrase, update BOTH files.
 */

export const RESET_PATTERNS: RegExp[] = [
  /\bignore\s+(everything|all|that|the\s+(above|previous|last|prior))\b/i,
  /\bstart\s+(fresh|from\s+scratch|over|a\s+new)\b/i,
  /\bforget\s+(everything|all|that|the\s+(above|previous|last|prior)|previous\s+analysis)\b/i,
  /\bnew\s+(analysis|query|request|search|case)\b/i,
  /\bseparate\s+(analysis|case|query)\b/i,
  /\bdifferent\s+(business|case|query|analysis)\b/i,
  /\bfresh\s+(analysis|start|query)\b/i,
  /\bfrom\s+scratch\b/i,
  /\bdiscard\s+(prior|previous|the)\b/i,
  /\bnew\s+search\b/i,
  /\bstart\s+again\b/i,
  /\breset\s+(the\s+)?(analysis|search|query|context)\b/i,
];

export function isResetIntent(prompt: string): boolean {
  return RESET_PATTERNS.some(p => p.test(prompt));
}
