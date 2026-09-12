// v1.13.1 — the clarification turn, frontend half.
//
// The engine decided what each option MEANS before it reached the browser.
// What the frontend owns is narrow and worth pinning: exactly what goes back
// with the chat turn, when the customer may continue, and what the "So far"
// strip says after they answer. All of it is pure, so all of it is tested
// without React.

import { describe, it, expect } from 'vitest';
import {
  buildAnswers, incompleteFreeText, mergeUnderstanding, primaryLabel, isOptOut,
  type Picked,
} from '../services/clarification';
import type { ClarifyQuestion, ClarifyOption, UnderstandingItem } from '../types/chat';

const opt = (id: string, label: string, effect: Record<string, unknown>, free_text = false): ClarifyOption =>
  ({ id, label, effect, free_text });

const WHERE: ClarifyQuestion = {
  id: 'where', slot: 'study_scope', impact: 'high',
  question: 'Bengaluru is a big city — where should we look?', why: 'Changes every zone in the result.',
  options: [
    opt('o1', 'The whole city', { type: 'set_scope', kind: 'city' }),
    opt('o2', 'Specific areas — I\'ll name them', { type: 'set_scope', kind: 'localities' }, true),
    opt('none', 'Not sure — use your judgement', { type: 'none' }),
  ],
};
const WHO: ClarifyQuestion = {
  id: 'who', slot: 'customer_mode', impact: 'medium',
  question: 'Who mostly comes in?', why: 'Changes what we weigh most.',
  options: [
    opt('o1', 'People walking past', { type: 'emphasize', family: 'access' }),
    opt('none', 'Either is fine', { type: 'none' }),
  ],
};
const BASE: UnderstandingItem[] = [
  { slot: 'archetype',   label: 'What kind of business', value: 'Quick-service café', source: 'prompt', status: 'low_confidence' },
  { slot: 'study_scope', label: 'Where to look',         value: 'Bengaluru',          source: 'prompt', status: 'low_confidence' },
  { slot: 'top_n',       label: 'How many zones',        value: '4',                  source: 'prompt', status: 'filled' },
];

const pick = (question: ClarifyQuestion, optionId: string, freeText = ''): Picked =>
  ({ question, option: question.options.find(o => o.id === optionId)!, freeText });

describe('buildAnswers — what goes back to the backend', () => {
  it('carries the validated effect untouched, plus the words for the record', () => {
    const out = buildAnswers({ customer_mode: pick(WHO, 'o1') });
    expect(out).toEqual([{
      slot: 'customer_mode',
      effect: { type: 'emphasize', family: 'access' },
      free_text: null,
      question: 'Who mostly comes in?',
      label: 'People walking past',
    }]);
  });

  it('sends trimmed free text only for invitation options', () => {
    const out = buildAnswers({ study_scope: pick(WHERE, 'o2', '  Indiranagar, Koramangala  ') });
    expect(out[0].free_text).toBe('Indiranagar, Koramangala');
  });

  it('never sends stray text on a plain option', () => {
    const out = buildAnswers({ study_scope: pick(WHERE, 'o1', 'typed by accident') });
    expect(out[0].free_text).toBeNull();
  });

  it('an opt-out is a real answer, sent as such', () => {
    const out = buildAnswers({ customer_mode: pick(WHO, 'none') });
    expect(out[0].effect).toEqual({ type: 'none' });
    expect(out[0].label).toBe('Either is fine');
  });

  it('nothing picked is an empty list — "use your judgement" is valid', () => {
    expect(buildAnswers({})).toEqual([]);
  });
});

describe('incompleteFreeText — when the customer may continue', () => {
  it('an invitation with nothing typed blocks continue', () => {
    expect(incompleteFreeText({ study_scope: pick(WHERE, 'o2', '   ') })).toEqual(['study_scope']);
  });

  it('an invitation with text does not', () => {
    expect(incompleteFreeText({ study_scope: pick(WHERE, 'o2', 'Indiranagar') })).toEqual([]);
  });

  it('plain options never block', () => {
    expect(incompleteFreeText({ study_scope: pick(WHERE, 'o1'), customer_mode: pick(WHO, 'none') })).toEqual([]);
  });
});

describe('mergeUnderstanding — the "So far" strip', () => {
  it('an answered slot is overwritten and marked as the customer\'s', () => {
    const strip = mergeUnderstanding(BASE, { study_scope: pick(WHERE, 'o1') });
    const where = strip.find(u => u.slot === 'study_scope')!;
    expect(where).toMatchObject({ value: 'The whole city', source: 'you', status: 'filled' });
  });

  it('free text is shown with the invitation\'s short label', () => {
    const strip = mergeUnderstanding(BASE, { study_scope: pick(WHERE, 'o2', 'Indiranagar, Koramangala') });
    expect(strip.find(u => u.slot === 'study_scope')!.value).toBe('Specific areas: Indiranagar, Koramangala');
  });

  it('an opt-out shows as skipped, not as a gap', () => {
    const strip = mergeUnderstanding(BASE, { customer_mode: pick(WHO, 'none') });
    const who = strip.find(u => u.slot === 'customer_mode')!;
    expect(who).toMatchObject({ label: "Who it's for", value: 'Either is fine', source: 'you', status: 'skipped' });
  });

  it('keeps the engine\'s order and appends new slots after it', () => {
    const strip = mergeUnderstanding(BASE, { customer_mode: pick(WHO, 'o1') });
    expect(strip.map(u => u.slot)).toEqual(['archetype', 'study_scope', 'top_n', 'customer_mode']);
  });

  it('untouched lines are untouched', () => {
    const strip = mergeUnderstanding(BASE, { study_scope: pick(WHERE, 'o1') });
    expect(strip.find(u => u.slot === 'top_n')).toEqual(BASE[2]);
  });

  it('is a no-op with nothing picked', () => {
    expect(mergeUnderstanding(BASE, {})).toEqual(BASE);
  });
});

describe('primaryLabel — skipping is permission, not failure', () => {
  it('reads as skipping when nothing is answered', () => {
    expect(primaryLabel({}, 3)).toBe('Skip — use your judgement');
  });

  it('reads as continuing once anything is answered', () => {
    expect(primaryLabel({ customer_mode: pick(WHO, 'none') }, 3)).toBe('Continue');
  });

  it('is plain Continue when there was nothing to ask', () => {
    expect(primaryLabel({}, 0)).toBe('Continue');
  });
});

describe('isOptOut', () => {
  it('recognises the engine\'s way-out effect and nothing else', () => {
    expect(isOptOut(WHO.options[1])).toBe(true);
    expect(isOptOut(WHO.options[0])).toBe(false);
  });
});
