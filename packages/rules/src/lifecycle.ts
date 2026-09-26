/**
 * Finding lifecycle helpers (spec §14 "State and consistency rules"). `applied` means
 * bytes changed; `rechecked` means a supported automated check passed on the exported
 * copy. Neither implies human or assistive-technology verification.
 */
import type { DeckManifest, Finding, FindingState } from '@ppt-remedy/contracts';
import { evaluate } from './evaluate.ts';

/** Hash-independent locator: `part#shapeId` for objects, `part` for slides. */
export function locatorOf(key: string): string {
  const colon = key.indexOf(':');
  return colon >= 0 ? key.slice(colon + 1) : key;
}

/**
 * Re-evaluate rules on the exported package and update findings whose patches were
 * applied: `rechecked` with rule=pass when the rule no longer fires on that object,
 * otherwise rule=fail (state stays `applied`).
 */
export function recheck(findings: Finding[], exported: DeckManifest, appliedFindingIds: ReadonlySet<string>): Finding[] {
  const where = (f: Finding) => `${f.ruleId}|${locatorOf(f.targetKey ?? f.objectKey ?? f.slideKey)}`;
  const remaining = new Set(evaluate(exported).findings.map(where));
  return findings.map((f) => {
    if (!appliedFindingIds.has(f.id)) return f;
    const still = remaining.has(where(f));
    return {
      ...f,
      state: still ? 'applied' : 'rechecked',
      verification: { ...f.verification, package: 'pass', rule: still ? 'fail' : 'pass' },
    };
  });
}

export const FINAL_STATES: FindingState[] = ['open', 'suggested', 'approved', 'applied', 'rechecked', 'dismissed', 'deferred', 'failed'];

/** Count each finding once by its final state. */
export function countByState(findings: Finding[]): Record<FindingState, number> {
  const out = Object.fromEntries(FINAL_STATES.map((s) => [s, 0])) as Record<FindingState, number>;
  for (const f of findings) out[f.state]++;
  return out;
}

/** Findings that remain outstanding (not fixed, whatever the reason). */
export function isUnresolved(f: Finding): boolean {
  return f.state !== 'applied' && f.state !== 'rechecked';
}
