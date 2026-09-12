import React, { useMemo, useState } from 'react';
import type { ClarifyOption, ClarifyQuestion, ClarifyResponse, ClarificationAnswer } from '../types/chat';
import {
  buildAnswers, incompleteFreeText, mergeUnderstanding, primaryLabel, SOURCE_LABELS,
  type Picked,
} from '../services/clarification';

/**
 * v1.13.1 — the clarification turn, on screen.
 *
 * Sits where the plan card will sit, BEFORE it exists: after the brief, before
 * anything is spent. Shows what we already understood (the "So far" strip),
 * asks only the questions the engine accepted, and hands the answers back with
 * the chat turn. Every question is optional; one button leaves.
 *
 * Deliberately quiet. This is a consultant sharpening a brief, not a form.
 */
interface ClarificationCardProps {
  clarification: ClarifyResponse;
  onSubmit: (answers: ClarificationAnswer[]) => void;
  disabled?: boolean;
}

export const ClarificationCard: React.FC<ClarificationCardProps> = ({
  clarification, onSubmit, disabled = false,
}) => {
  const { questions, understanding } = clarification;
  const [picked, setPicked] = useState<Record<string, Picked>>({});

  const strip = useMemo(() => mergeUnderstanding(understanding, picked), [understanding, picked]);
  const missingText = incompleteFreeText(picked);
  const canContinue = !disabled && missingText.length === 0;

  const choose = (question: ClarifyQuestion, option: ClarifyOption) => {
    setPicked(prev => {
      const cur = prev[question.slot];
      if (cur && cur.option.id === option.id) {              // click again = unpick
        const next = { ...prev };
        delete next[question.slot];
        return next;
      }
      return { ...prev, [question.slot]: { question, option, freeText: cur?.freeText ?? '' } };
    });
  };

  const typeFor = (slot: string, text: string) =>
    setPicked(prev => (prev[slot] ? { ...prev, [slot]: { ...prev[slot], freeText: text } } : prev));

  return (
    <div className="clarify-card" data-testid="clarification-card">
      {strip.length > 0 && (
        <div className="clarify-strip" aria-label="What we understood so far">
          <span className="clarify-strip-head">So far</span>
          {strip.map(u => (
            <span key={u.slot} className={`clarify-strip-item is-${u.source}`} title={SOURCE_LABELS[u.source] ?? u.source}>
              <span className="clarify-strip-label">{u.label}</span>
              <span className="clarify-strip-value">{u.value}</span>
            </span>
          ))}
        </div>
      )}

      {questions.map(q => {
        const cur = picked[q.slot];
        return (
          <div key={q.id} className="clarify-q">
            <div className="clarify-question">{q.question}</div>
            {q.why && <div className="clarify-why">{q.why}</div>}
            <div className="clarify-options">
              {q.options.map(o => {
                const active = cur?.option.id === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    className={`clarify-option${active ? ' is-active' : ''}${o.effect?.type === 'none' ? ' is-optout' : ''}`}
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => choose(q, o)}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            {cur?.option.free_text && (
              <input
                className="clarify-freetext"
                type="text"
                placeholder={freeTextPlaceholder(q.slot)}
                value={cur.freeText}
                autoFocus
                disabled={disabled}
                onChange={e => typeFor(q.slot, e.target.value)}
                aria-label={`${q.question} — details`}
              />
            )}
          </div>
        );
      })}

      <div className="clarify-footer">
        <span className="clarify-hint">
          {questions.length ? 'Every question is optional.' : 'Nothing to clarify.'}
        </span>
        <button
          type="button"
          className="clarify-continue"
          disabled={!canContinue}
          title={missingText.length ? 'Say what you mean in the box above, or pick another option' : undefined}
          onClick={() => onSubmit(buildAnswers(picked))}
        >
          {primaryLabel(picked, questions.length)}
        </button>
      </div>
    </div>
  );
};

function freeTextPlaceholder(slot: string): string {
  switch (slot) {
    case 'study_scope':  return 'e.g. Indiranagar, Koramangala — or 12.9716, 77.5946';
    case 'keep_away':    return 'e.g. any metro station, 1 km';
    case 'must_be_near': return 'e.g. 10 min walk of Forum Mall';
    default:             return 'Say what you mean';
  }
}
