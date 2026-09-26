/**
 * "Remediate All" automation (ADR 0003, ADR 0004). Walks every target that can be fixed
 * automatically — picture descriptions and link text — one AI request at a time, and
 * decides per target whether the generated text may be applied without review:
 *  - pictures: a validated suggestion with non-empty text that the model did not flag for
 *    manual review or as possibly decorative (never fabricate text for decorative art);
 *  - links: validated descriptive text the model did not mark as unknowable;
 *  - anything else is skipped, with a reason shown in the results.
 * Rate limits are waited out (those requests never reached inference); a transient
 * AI_UNAVAILABLE gets one retry; quota exhaustion or AI being disabled halts the run.
 */
import type { LinkSuggestion, Suggestion } from '@ppt-remedy/contracts';
import type { AiInfo } from '../state/session.ts';

export interface RemediationTarget {
  targetKey: string;
  kind: 'picture' | 'link';
  /** Why the target cannot be sent for AI, when known up front. */
  ineligible?: string;
  /** Deterministic fix known without AI (e.g. a link's own label). */
  preset?: string;
}

export type Attempt =
  | { ok: false; code: string; message: string; retryAfterSeconds?: number }
  | { ok: true; kind: 'picture'; suggestion: Suggestion; status: 'suggested' | 'needs_manual_review'; model: string }
  | { ok: true; kind: 'link'; suggestion: LinkSuggestion; status: 'suggested' | 'needs_manual_review'; model: string };

export type ItemOutcome =
  | { targetKey: string; kind: 'applied'; text: string; ai?: AiInfo; origin: 'ai_suggestion' | 'rule_suggestion' }
  | { targetKey: string; kind: 'skipped'; code: string; message: string };

export interface RemediationDeps {
  /** One attempt for one target (prepare input, fresh challenge token, request). */
  attempt: (target: RemediationTarget, signal: AbortSignal) => Promise<Attempt>;
  onProgress: (done: number, total: number, current?: string) => void;
  onItem: (outcome: ItemOutcome) => void;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  maxRateLimitWaits?: number;
}

export interface RemediationSummary {
  applied: number;
  skipped: number;
  halted?: { code: string; message: string };
  cancelled: boolean;
}

const HALT = new Set(['AI_QUOTA_EXHAUSTED', 'AI_DISABLED']);

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Decide whether a successful suggestion may be applied without review. */
export function acceptance(a: Extract<Attempt, { ok: true }>): { text: string; ai: AiInfo } | { code: string; message: string } {
  if (a.kind === 'link') {
    if (a.status === 'needs_manual_review') return { code: 'NEEDS_PERSON', message: 'The AI could not tell where this link goes; a person should write its text.' };
    return { text: a.suggestion.linkText, ai: { status: a.status, model: a.model, warnings: a.suggestion.warnings } };
  }
  const s = a.suggestion;
  if (!s.altText.trim()) return { code: 'NO_TEXT', message: 'The AI could not describe this picture.' };
  if (s.decorativeSuggestion === 'yes') return { code: 'POSSIBLY_DECORATIVE', message: 'The AI thinks this picture may be decorative; a person should decide.' };
  if (a.status === 'needs_manual_review') {
    return { code: 'NEEDS_PERSON', message: 'This picture needs a longer or more careful description than the AI can safely write.' };
  }
  return {
    text: s.altText,
    ai: { status: a.status, model: a.model, warnings: s.warnings, needsLongDescription: s.needsLongDescription, decorativeSuggestion: s.decorativeSuggestion },
  };
}

export async function runRemediation(targets: RemediationTarget[], deps: RemediationDeps): Promise<RemediationSummary> {
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const maxWaits = deps.maxRateLimitWaits ?? 10;
  const summary: RemediationSummary = { applied: 0, skipped: 0, cancelled: false };
  const skip = (targetKey: string, code: string, message: string) => {
    summary.skipped++;
    deps.onItem({ targetKey, kind: 'skipped', code, message });
  };

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    if (deps.signal.aborted) {
      summary.cancelled = true;
      break;
    }
    deps.onProgress(i, targets.length, target.targetKey);
    if (target.preset) {
      summary.applied++;
      deps.onItem({ targetKey: target.targetKey, kind: 'applied', text: target.preset, origin: 'rule_suggestion' });
      continue;
    }
    if (summary.halted) {
      skip(target.targetKey, summary.halted.code, 'Not attempted: AI stopped for this session.');
      continue;
    }
    if (target.ineligible) {
      skip(target.targetKey, 'NOT_ELIGIBLE', target.ineligible);
      continue;
    }

    let result = await deps.attempt(target, deps.signal);
    let waits = 0;
    let retriedUnavailable = false;
    for (;;) {
      if (deps.signal.aborted || result.ok) break;
      if (result.code === 'RATE_LIMITED' && waits < maxWaits) {
        waits++;
        await sleep((result.retryAfterSeconds ?? 60) * 1000, deps.signal);
      } else if (result.code === 'AI_UNAVAILABLE' && !retriedUnavailable) {
        retriedUnavailable = true;
        await sleep(2000 + Math.floor(random() * 3000), deps.signal);
      } else {
        break;
      }
      if (deps.signal.aborted) break;
      result = await deps.attempt(target, deps.signal);
    }
    if (deps.signal.aborted) {
      summary.cancelled = true;
      break;
    }

    if (!result.ok) {
      if (HALT.has(result.code)) summary.halted = { code: result.code, message: result.message };
      skip(target.targetKey, result.code, result.message);
      continue;
    }
    const decision = acceptance(result);
    if ('code' in decision) {
      skip(target.targetKey, decision.code, decision.message);
    } else {
      summary.applied++;
      deps.onItem({ targetKey: target.targetKey, kind: 'applied', text: decision.text, ai: decision.ai, origin: 'ai_suggestion' });
    }
  }
  deps.onProgress(targets.length, targets.length);
  return summary;
}
