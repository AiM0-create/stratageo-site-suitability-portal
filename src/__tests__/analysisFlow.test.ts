// Regression tests for the v1.4.3/v1.4.4 flow bugs (pure logic, no React).
import { describe, it, expect } from 'vitest';
import {
  isAnalysisSpecWithPoints,
  isConfirmationPhrase,
  isFollowUpQuestion,
  CONFIRMATION_PHRASES,
} from '../services/analysisFlow';

const validSpec = {
  version: '2.0',
  objective: 'Find top 3 cafe zones',
  businessType: 'quick-service cafe',
  studyArea: { type: 'places', places: ['Ruby Crossing'] },
  grid: { type: 'h3', resolution: 8 },
  layers: [{ id: 'l1', name: 'Footfall', weight: 0.5, direction: 'positive' }],
};

describe('isAnalysisSpecWithPoints (v1.4.3 circular-JSON regression)', () => {
  it('accepts a valid SpecV2-shaped object', () => {
    expect(isAnalysisSpecWithPoints(validSpec)).toBe(true);
  });

  it('rejects a React SyntheticEvent / MouseEvent-shaped object', () => {
    // What onClick={onConfirmExecute} actually passed in the live bug:
    // an event whose target/currentTarget close a circular reference chain.
    const btn: any = { tagName: 'BUTTON' };
    btn.__reactFiber$abc = { stateNode: btn };   // circular, like real DOM nodes
    const syntheticEvent = {
      nativeEvent: { type: 'click' },
      currentTarget: btn,
      target: btn,
      preventDefault: () => {},
      stopPropagation: () => {},
      // Even if an event somehow carried spec-looking fields, the event-shape
      // check must win:
      objective: 'x', businessType: 'y', layers: [],
    };
    expect(isAnalysisSpecWithPoints(syntheticEvent)).toBe(false);
  });

  it('rejects primitives, null, arrays, and empty objects', () => {
    expect(isAnalysisSpecWithPoints(null)).toBe(false);
    expect(isAnalysisSpecWithPoints(undefined)).toBe(false);
    expect(isAnalysisSpecWithPoints('yes')).toBe(false);
    expect(isAnalysisSpecWithPoints(42)).toBe(false);
    expect(isAnalysisSpecWithPoints([])).toBe(false);
    expect(isAnalysisSpecWithPoints({})).toBe(false);
  });

  it('rejects a spec missing the layers array', () => {
    expect(isAnalysisSpecWithPoints({ objective: 'x', businessType: 'y' })).toBe(false);
  });
});

describe('isConfirmationPhrase (v1.4.4 local interception)', () => {
  it.each([...CONFIRMATION_PHRASES])('intercepts %j', (phrase) => {
    expect(isConfirmationPhrase(phrase)).toBe(true);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(isConfirmationPhrase('  YES ')).toBe(true);
    expect(isConfirmationPhrase('Start Analysis')).toBe(true);
    expect(isConfirmationPhrase('\tProceed\n')).toBe(true);
  });

  it('does NOT intercept sentences that merely contain a phrase', () => {
    expect(isConfirmationPhrase('yes please, but change the radius')).toBe(false);
    expect(isConfirmationPhrase('run it with 5 results instead')).toBe(false);
    expect(isConfirmationPhrase('okay so what about Sector V?')).toBe(false);
  });

  it('does NOT intercept a fresh business prompt', () => {
    expect(isConfirmationPhrase(
      'Find the top 3 locations for a quick-service cafe near Ruby crossing',
    )).toBe(false);
  });
});

describe('isFollowUpQuestion (v1.4.7 — results must survive follow-ups)', () => {
  it.each([
    'why is zone 2 lower?',
    'Why is zone 2 lower than zone 1',
    'explain the competition factor',
    'how did you compute the drive time?',
    'what about the second candidate?',
    'compare zone 1 and zone 3',
    'is the metro exclusion applied here?',
  ])('treats %j as a follow-up (keep results)', (q) => {
    expect(isFollowUpQuestion(q)).toBe(true);
  });

  it.each([
    'Find the top 3 locations for a dark kitchen in South Kolkata',
    'Identify the 3 best sites for a premium riverside restaurant',
    'Show me the 3 best locations for a discount supermarket in Sector V',
    'I need a dark kitchen location in South Kolkata',
  ])('treats %j as a NEW brief (clear results)', (q) => {
    expect(isFollowUpQuestion(q)).toBe(false);
  });

  it('a new brief phrased as a question still counts as a new brief', () => {
    expect(isFollowUpQuestion('can you find the best locations for a gym in Salt Lake?')).toBe(false);
  });

  it('confirmation phrases are not follow-ups (handled upstream)', () => {
    expect(isFollowUpQuestion('yes')).toBe(false);
    expect(isFollowUpQuestion('run')).toBe(false);
  });
});
