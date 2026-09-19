import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisResult, AnalysisStatus, TargetCell } from '../types';
import type { SpecV2 } from '../types/chat';
import { locationFromDevice, locationFromPhoto, VERDICT_LABEL, type LocationSource, type ResolvedLocation } from '../services/spotCheck';
import { SpecSummaryCard } from './SpecSummaryCard';

/**
 * v2.4.0 — "check a spot".
 *
 *   📷 photo  →  📍 confirm the pin + "what are you opening?"  →  verdict
 *
 * The photo is the trigger, not the evidence: its EXIF GPS (when a phone
 * keeps it) or the device's own location places the pin; the customer
 * confirms it on the map; the engine scores the 1.5 km around it and says
 * where THAT cell stands. Phase 1 never uploads the photo and never reads
 * its pixels.
 */
/** v2.5.0 — `planning` / `plan`: the factors are shown and agreed before the
 *  run, as on the desktop flow (owner: "no variables or any discussion of the
 *  context is done"). */
export type SpotStage = 'locate' | 'confirm' | 'planning' | 'plan' | 'running' | 'verdict' | 'error';

interface SpotCheckProps {
  pin: { lat: number; lng: number } | null;
  pinSource: LocationSource | null;
  pinAccuracyM?: number;
  /** a new fix (photo / device / tap) — `focus` asks the map to fly there */
  onPinChange: (pos: { lat: number; lng: number }, source: LocationSource, focus: boolean, accuracyM?: number) => void;
  /** compose the plan for the pin + business (stage → planning → plan) */
  onPlan: (lat: number, lng: number, business: string) => Promise<void>;
  /** the composed plan, editable (weights / direction / remove) before it runs */
  spec: SpecV2 | null;
  onSpecEdit: (updated: SpecV2) => void;
  /** start the agreed plan (stage → running → verdict) */
  onRun: () => Promise<void>;
  status: AnalysisStatus;
  result: AnalysisResult | null;
  stage: SpotStage;
  onStageChange: (s: SpotStage) => void;
  error: string | null;
  onShowZones: () => void;
  onCancel: () => void;
  onClose: () => void;
}

const SOURCE_TEXT: Record<LocationSource, string> = {
  photo: 'from your photo',
  device: 'from your phone’s location',
  pin: 'where you placed it',
};

const VERDICT_CLASS: Record<TargetCell['verdict'], string> = {
  good: 'is-good', fair: 'is-fair', weak: 'is-weak', excluded: 'is-excluded',
};

export const SpotCheck: React.FC<SpotCheckProps> = ({
  pin, pinSource, pinAccuracyM, onPinChange, onPlan, spec, onSpecEdit, onRun, status, result, stage, onStageChange,
  error, onShowZones, onCancel, onClose,
}) => {
  const [business, setBusiness] = useState('');
  const [locating, setLocating] = useState<null | 'photo' | 'device'>(null);
  const [locateNote, setLocateNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const place = useCallback((loc: ResolvedLocation | null, fallbackNote: string) => {
    if (loc) {
      onPinChange({ lat: loc.lat, lng: loc.lng }, loc.source, true, loc.accuracyM);
      setLocateNote(null);
      onStageChange('confirm');
    } else {
      setLocateNote(fallbackNote);
    }
  }, [onPinChange, onStageChange]);

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';                                   // same photo twice must re-fire
    if (!file) return;
    setLocating('photo');
    const fromPhoto = await locationFromPhoto(file);
    if (fromPhoto) { setLocating(null); return place(fromPhoto, ''); }
    // no GPS in the file (iOS strips it; forwards never have it) → the phone's own fix
    setLocating('device');
    const fromDevice = await locationFromDevice();
    setLocating(null);
    place(fromDevice, 'The photo carries no location and the phone did not share one — tap the map where the shop would be.');
  };

  const onDevice = async () => {
    setLocating('device');
    const loc = await locationFromDevice();
    setLocating(null);
    place(loc, 'Location is off or was refused — tap the map where the shop would be.');
  };

  // v2.4.1 — ask for the phone's location as soon as the flow opens. A person
  // standing at the spot is the case this exists for, and on a real 375px
  // emulation the alternative was "tap the map" on a view of the globe.
  // Silent on failure: the photo / tap paths stay on screen.
  const autoLocated = useRef(false);
  useEffect(() => {
    if (autoLocated.current || stage !== 'locate' || pin) return;
    autoLocated.current = true;
    let alive = true;
    setLocating('device');
    locationFromDevice(8000).then(loc => {
      if (!alive) return;
      setLocating(null);
      if (loc) place(loc, '');
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const plan = () => {
    const b = business.trim();
    if (!pin || b.length < 2) return;
    onStageChange('planning');
    onPlan(pin.lat, pin.lng, b).catch(() => { /* App sets the error + stage */ });
  };
  const run = () => {
    onStageChange('running');
    onRun().catch(() => { /* App sets the error + stage */ });
  };

  const target = result?.targetCell ?? null;
  const factors = useMemo(() => {
    const loc = target?.location;
    if (!loc) return [];
    return [...(loc.criteria_breakdown ?? [])]
      .filter(c => c.score !== null && c.score !== undefined)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 4);
  }, [target]);
  const nextChecks = target?.location?.nextValidation?.slice(0, 2) ?? [];

  return (
    <div className={`spot-card spot-stage-${stage}`} role="dialog" aria-label="Check a spot">
      <div className="spot-head">
        <span className="spot-title">Check a spot</span>
        <button type="button" className="spot-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      {stage === 'locate' && (
        <div className="spot-body">
          <p className="spot-lead">Standing at the spot? Take a photo of the street and we’ll place the pin.</p>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
          <button type="button" className="spot-primary" onClick={() => fileRef.current?.click()} disabled={!!locating}>
            {locating === 'photo' ? 'Reading the photo…' : locating === 'device' ? 'Getting your location…' : '📷 Take a photo'}
          </button>
          <div className="spot-alt">
            <button type="button" className="spot-secondary" onClick={onDevice} disabled={!!locating}>📍 Use my location</button>
            <span className="spot-or">or tap the map where the shop would be</span>
          </div>
          {locateNote && <div className="spot-note">{locateNote}</div>}
          <p className="spot-fine">The photo stays on your phone — only the position is used.</p>
        </div>
      )}

      {stage === 'confirm' && pin && (
        <div className="spot-body">
          <p className="spot-lead">
            Is this where the shop would be?
            {pinSource && <span className="spot-source"> Pin {SOURCE_TEXT[pinSource]}{pinSource === 'device' && pinAccuracyM ? ` (±${pinAccuracyM} m)` : ''}.</span>}
            {' '}Drag it or tap the map to adjust.
          </p>
          <label className="spot-label" htmlFor="spot-business">What are you opening?</label>
          <div className="spot-row">
            <input id="spot-business" className="spot-input" type="text" autoFocus placeholder="e.g. café, IVF clinic, high-end gym"
                   value={business} onChange={e => setBusiness(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter') plan(); }} />
          </div>
          <button type="button" className="spot-primary" onClick={plan} disabled={business.trim().length < 2}>See the factors</button>
          <div className="spot-alt">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
            <button type="button" className="spot-link" onClick={() => fileRef.current?.click()} disabled={!!locating}>
              {locating === 'photo' ? 'Reading the photo…' : '📷 Take a photo of the street instead'}
            </button>
          </div>
        </div>
      )}

      {stage === 'planning' && (
        <div className="spot-body">
          <p className="spot-lead">Composing the factors for a {business.trim() || 'business'} at this spot…</p>
          <div className="assistant-progress">
            <div className="assistant-progress-text">Reading the business, choosing the framework, adding what your words ask for</div>
            <div className="assistant-progress-track"><div className="assistant-progress-fill spot-indeterminate" /></div>
          </div>
        </div>
      )}

      {stage === 'plan' && spec && (
        <div className="spot-body spot-body-plan">
          <p className="spot-lead">This is what we’ll measure around your pin. Adjust a weight or drop a factor, then run.</p>
          <SpecSummaryCard
            spec={spec}
            specStatus="complete"
            readyToExecute
            isExecuting={false}
            onConfirmExecute={run}
            onSpecEdit={onSpecEdit}
          />
          <button type="button" className="spot-link" onClick={() => onStageChange('confirm')}>Change the spot or the business</button>
        </div>
      )}

      {stage === 'running' && (
        <div className="spot-body">
          <p className="spot-lead">Scoring the 1.5 km around your pin…</p>
          <div className="assistant-progress">
            <div className="assistant-progress-text">{status.message}</div>
            <div className="assistant-progress-track"><div className="assistant-progress-fill" style={{ width: `${status.progress}%` }} /></div>
            <div className="assistant-progress-pct">{Math.round(status.progress)}%</div>
          </div>
          <button type="button" className="spot-link" onClick={onCancel}>Cancel</button>
        </div>
      )}

      {stage === 'error' && (
        <div className="spot-body">
          <div className="assistant-error"><span>{error || 'The check could not be completed.'}</span></div>
          <button type="button" className="spot-secondary" onClick={() => onStageChange('confirm')}>Try again</button>
        </div>
      )}

      {stage === 'verdict' && target && (
        <div className="spot-body">
          <div className={`spot-verdict ${VERDICT_CLASS[target.verdict]}`}>
            <span className="spot-verdict-word">{VERDICT_LABEL[target.verdict]}</span>
            <span className="spot-verdict-for">for a {result?.business_type}{target.areaHint ? ` · near ${target.areaHint}` : ''}</span>
          </div>
          <p className="spot-verdict-text">{target.verdictText}</p>
          {target.verified?.note && <p className="spot-fine">{target.verified.note}.</p>}

          {factors.length > 0 && (
            <div className="spot-factors">
              {factors.map((c, i) => (
                <div key={i} className="spot-factor">
                  <div className="spot-factor-row">
                    <span className="spot-factor-name">{c.name}</span>
                    <span className="spot-factor-raw">{c.rawValue !== null && c.rawValue !== undefined ? `${c.rawValue} counted` : ''}</span>
                    <span className="spot-factor-score">{(c.score as number).toFixed(1)}</span>
                  </div>
                  <div className="criterion-bar-track">
                    <div className={`criterion-bar-fill ${c.direction === 'negative' ? 'bar-negative' : 'bar-positive'}`} style={{ width: `${(c.score as number) * 10}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {nextChecks.length > 0 && (
            <div className="spot-next">
              <div className="spot-next-title">Check on the ground</div>
              <ul>{nextChecks.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          )}
          <p className="spot-fine">Relative to the {target.cellsEligible} cells within {target.radiusM ? `${(target.radiusM / 1000).toFixed(1)} km` : 'the area'}; map data, not a site survey. Rent, availability and frontage are not scored.</p>

          <button type="button" className="spot-primary" onClick={onShowZones}>Show the best spots nearby</button>
          <button type="button" className="spot-link" onClick={() => { setBusiness(''); onStageChange('locate'); }}>Check another spot</button>
        </div>
      )}
    </div>
  );
};
