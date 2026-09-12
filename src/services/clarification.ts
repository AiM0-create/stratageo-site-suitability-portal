// ─── v1.13.1 — pure helpers for the clarification turn ───
//
// Kept out of the component so the behaviour that matters — what goes back to
// the backend, and what the "So far" strip says — is testable without React.
// The engine already decided what each option MEANS; nothing here interprets
// an effect, it only carries it.

import type {
  ClarifyOption, ClarifyQuestion, ClarificationAnswer, UnderstandingItem,
} from '../types/chat';

/** The customer picked an option (and maybe typed the rest). */
export interface Picked {
  question: ClarifyQuestion;
  option: ClarifyOption;
  freeText: string;
}

export const isOptOut = (o: ClarifyOption): boolean => o.effect?.type === 'none';

/**
 * What goes back with the chat turn. One answer per slot; free text is trimmed
 * and only sent for invitation options, so a stray keystroke on a plain option
 * can never reach the parser.
 */
export function buildAnswers(picked: Record<string, Picked>): ClarificationAnswer[] {
  return Object.values(picked).map(({ question, option, freeText }) => ({
    slot: question.slot,
    effect: option.effect,
    free_text: option.free_text ? (freeText.trim() || null) : null,
    question: question.question,
    label: option.label,
  }));
}

/**
 * An invitation option with nothing typed is an answer we cannot act on. The
 * backend would disclose it as "chosen but nothing was named"; better to keep
 * the button disabled until the customer has said what they mean.
 */
export function incompleteFreeText(picked: Record<string, Picked>): string[] {
  return Object.values(picked)
    .filter(p => p.option.free_text && !p.freeText.trim())
    .map(p => p.question.slot);
}

/**
 * The "So far:" strip after answers. The engine's table is the base; an
 * answered slot is overwritten with what the customer said, marked `you`. An
 * opt-out is a real answer ("Either is fine") and is shown as such — it is
 * not a gap.
 */
export function mergeUnderstanding(
  base: UnderstandingItem[],
  picked: Record<string, Picked>,
  labels: Record<string, string> = SLOT_LABELS,
): UnderstandingItem[] {
  const bySlot = new Map(base.map(u => [u.slot, { ...u }]));
  for (const { question, option, freeText } of Object.values(picked)) {
    const value = option.free_text && freeText.trim()
      ? `${option.label.replace(/\s*—.*$/, '')}: ${freeText.trim()}`
      : option.label;
    bySlot.set(question.slot, {
      slot: question.slot,
      label: labels[question.slot] ?? question.slot,
      value,
      source: 'you',
      status: isOptOut(option) ? 'skipped' : 'filled',
    });
  }
  // Stable order: the engine's order first, then any newly-answered slots.
  const order = [...base.map(u => u.slot), ...Object.keys(picked).filter(s => !base.some(u => u.slot === s))];
  return order.map(s => bySlot.get(s)!).filter(Boolean);
}

/** Mirrors engine/clarification.SLOT_LABELS — what a customer sees. */
export const SLOT_LABELS: Record<string, string> = {
  archetype:     'What kind of business',
  study_scope:   'Where to look',
  customer_mode: "Who it's for",
  keep_away:     'Keep away from',
  must_be_near:  'Must be near',
  expectations:  "Can't check from map data",
  top_n:         'How many zones',
};

/** Plain wording for where a line of the strip came from. */
export const SOURCE_LABELS: Record<string, string> = {
  prompt:  'from your brief',
  you:     'you told us',
  assumed: 'assumed',
  default: 'default',
};

/**
 * The one primary button. "Continue" once anything is answered; otherwise the
 * customer is choosing to let us use our judgement, and the label says so —
 * skipping is permission, not failure.
 */
export function primaryLabel(picked: Record<string, Picked>, questionCount: number): string {
  if (questionCount === 0) return 'Continue';
  return Object.keys(picked).length > 0 ? 'Continue' : 'Skip — use your judgement';
}
