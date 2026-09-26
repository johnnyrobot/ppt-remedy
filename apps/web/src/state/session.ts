/**
 * Review session state (spec §14 "State and consistency rules", §17). Pure reducer so
 * lifecycle rules are unit-testable:
 *  - Suggested text is a draft; approval creates a patch; editing after approval
 *    invalidates it.
 *  - One description patch per object (last approved choice wins); undo removes the
 *    latest approval from the queue, never bytes from the source.
 *  - Approving one object never approves other instances of the same media.
 *  - Dismissal requires a reason; dismissed/deferred are not fixed.
 */
import {
  ENGINE_VERSION,
  LIMITS,
  normalizeDescription,
  type ApprovedPatch,
  type ChangeRecord,
  type DeckManifest,
  type Finding,
  type FindingState,
  type ObjectRecord,
  type SessionStage,
  type LinkRecord,
  type Suggestion,
  LinkSuggestionSchema,
} from '@ppt-remedy/contracts';
import type { ScanPayload } from '../engine/protocol.ts';

export const DESCRIPTION_RULES = new Set(['IMG_MISSING_ALT', 'IMG_GENERIC_ALT']);

/** What the AI said about a draft (pictures carry decorative/long-description hints). */
export interface AiInfo {
  status: 'suggested' | 'needs_manual_review';
  model: string;
  warnings: string[];
  needsLongDescription?: boolean;
  decorativeSuggestion?: Suggestion['decorativeSuggestion'];
}

/** Drafts and patches are keyed by target: an object key (pictures) or a link key. */
export interface Draft {
  text: string;
  origin: 'manual' | 'ai_suggestion' | 'rule_suggestion';
  /** True once the user changes AI-drafted text. */
  edited: boolean;
  ai?: AiInfo;
}

export function isLinkTarget(targetKey: string): boolean {
  return targetKey.includes('|link:');
}

/** Object key for a target (link keys start with their object key). */
export function targetObjectKey(targetKey: string): string {
  const i = targetKey.indexOf('|link:');
  return i >= 0 ? targetKey.slice(0, i) : targetKey;
}

export function patchTarget(p: ApprovedPatch): string {
  return p.targetKey ?? p.objectKey ?? p.id;
}

export function findLink(manifest: DeckManifest | undefined, targetKey: string): LinkRecord | undefined {
  return findObject(manifest, targetObjectKey(targetKey))?.links?.find((l) => l.key === targetKey);
}

export interface ExportOutcome {
  bytes: ArrayBuffer;
  outputSha256: string;
  unchanged: boolean;
  changes: ChangeRecord[];
  rescan: DeckManifest;
}

export type View = 'findings' | 'changes';

/** Progress and outcomes of a "Remediate All" run (ADR 0003). */
export interface RemediationRun {
  total: number;
  done: number;
  current?: string;
  applied: string[];
  skipped: { targetKey: string; code: string; message: string }[];
  halted?: { code: string; message: string };
  cancelled?: boolean;
}

export interface AppState {
  stage: SessionStage | 'rejected' | 'remediating';
  sessionId: number;
  fileName?: string;
  scan?: ScanPayload;
  findings: Finding[];
  drafts: Record<string, Draft>;
  /** Approved patches in approval order (the undo history). */
  patches: ApprovedPatch[];
  progress?: { stage: string; done: number; total: number };
  rejection?: { code: string; message: string };
  exportError?: { code: string; message: string };
  exportOutcome?: ExportOutcome;
  view: View;
  /** Present once "Remediate All" has run in this session. */
  remediation?: RemediationRun;
  selectedSlideKey?: string;
  selectedFindingId?: string;
  aiConsent: boolean;
  manualOnly: boolean;
  /** Last message for the polite live region. */
  announcement: { text: string; seq: number };
}

export const initialState: AppState = {
  stage: 'idle',
  sessionId: 0,
  findings: [],
  drafts: {},
  patches: [],
  view: 'findings',
  aiConsent: false,
  manualOnly: false,
  announcement: { text: '', seq: 0 },
};

export type Action =
  | { type: 'START_FILE'; name: string }
  | { type: 'PROGRESS'; stage: string; done: number; total: number }
  | { type: 'SCAN_OK'; payload: ScanPayload }
  | { type: 'SCAN_FAILED'; code: string; message: string }
  | { type: 'CANCEL_SCAN' }
  | { type: 'SELECT_SLIDE'; slideKey: string }
  | { type: 'SELECT_FINDING'; findingId: string | undefined }
  | { type: 'SET_DRAFT'; targetKey: string; text: string }
  | { type: 'AI_SUGGESTION'; targetKey: string; text: string; ai: AiInfo }
  | { type: 'REVERT_DRAFT'; targetKey: string }
  | { type: 'APPROVE'; targetKey: string; now: string; patchId: string }
  | { type: 'REVOKE'; targetKey: string }
  | { type: 'UNDO_LAST' }
  | { type: 'DISMISS'; findingId: string; reason: string; now: string }
  | { type: 'DEFER'; findingId: string; now: string }
  | { type: 'REOPEN'; findingId: string }
  | { type: 'SET_VIEW'; view: View }
  | { type: 'REMEDIATE_START'; total: number }
  | { type: 'REMEDIATE_PROGRESS'; done: number; current?: string }
  | { type: 'AUTO_APPLY'; targetKey: string; text: string; ai?: AiInfo; origin: 'ai_suggestion' | 'rule_suggestion'; now: string; patchId: string }
  | { type: 'REMEDIATE_SKIPPED'; targetKey: string; code: string; message: string }
  | { type: 'REMEDIATE_END'; halted?: { code: string; message: string }; cancelled: boolean }
  | { type: 'EXPORT_START' }
  | { type: 'EXPORT_OK'; outcome: ExportOutcome; findings: Finding[] }
  | { type: 'EXPORT_FAILED'; code: string; message: string; changes?: ChangeRecord[] }
  | { type: 'REVISE' }
  | { type: 'CLEAR' }
  | { type: 'SET_AI_CONSENT'; value: boolean }
  | { type: 'SET_MANUAL_ONLY'; value: boolean }
  | { type: 'ANNOUNCE'; text: string };

function announce(state: AppState, text: string): AppState['announcement'] {
  return { text, seq: state.announcement.seq + 1 };
}

export function findObject(manifest: DeckManifest | undefined, objectKey: string | undefined): ObjectRecord | undefined {
  if (!manifest || !objectKey) return undefined;
  for (const s of manifest.slides) for (const o of s.objects) if (o.key === objectKey) return o;
  return undefined;
}

/** Findings addressed by a patch on this target. */
export function isTargetFinding(f: Finding, targetKey: string): boolean {
  if (isLinkTarget(targetKey)) return f.ruleId === 'LINK_GENERIC_TEXT' && f.targetKey === targetKey;
  return f.objectKey === targetKey && DESCRIPTION_RULES.has(f.ruleId);
}

/** The edit target a finding can be fixed through, when it is fixable here. */
export function findingTarget(f: Finding): string | undefined {
  if (f.capability !== 'approval_required') return undefined;
  if (f.ruleId === 'LINK_GENERIC_TEXT') return f.targetKey;
  if (DESCRIPTION_RULES.has(f.ruleId)) return f.objectKey;
  return undefined;
}

function setTargetFindings(findings: Finding[], targetKey: string, state: FindingState, patchId?: string): Finding[] {
  return findings.map((f) => {
    if (!isTargetFinding(f, targetKey)) return f;
    if (f.state === 'dismissed' || f.state === 'deferred') return f;
    const next: Finding = { ...f, state };
    if (patchId) next.proposedPatchId = patchId;
    else delete next.proposedPatchId;
    return next;
  });
}

function stateWithoutApproval(draft: Draft | undefined): FindingState {
  return draft?.origin === 'manual' || !draft ? 'open' : 'suggested';
}

export function buildPatch(state: AppState, targetKey: string, now: string, patchId: string, autoApplied = false): ApprovedPatch | { error: string } {
  const manifest = state.scan?.manifest;
  const obj = findObject(manifest, targetObjectKey(targetKey));
  const draft = state.drafts[targetKey];
  if (!manifest || !obj || !draft) return { error: 'Nothing to approve.' };
  const slide = manifest.slides.find((s) => s.key === obj.slideKey)!;
  const partSha = state.scan!.partSha256[slide.part];
  if (!partSha) return { error: 'Slide integrity data is missing; reload the file.' };
  const common = {
    id: patchId,
    sourceSha256: manifest.sourceSha256,
    slideKey: slide.key,
    objectKey: obj.key,
    targetKey,
    part: slide.part,
    shapeId: obj.shapeId,
    expectedOriginalPartSha256: partSha,
    origin: draft.origin,
    approvedAt: now,
    ...(autoApplied ? { autoApplied: true } : {}),
  };
  if (isLinkTarget(targetKey)) {
    const link = obj.links?.find((l) => l.key === targetKey);
    if (!link?.editable || link.paragraphIndex === undefined || link.runIndex === undefined || link.runCount === undefined) {
      return { error: 'This link cannot be edited here.' };
    }
    const text = draft.text.replace(/\s+/g, ' ').trim();
    const valid = LinkSuggestionSchema.shape.linkText.safeParse(text);
    if (!valid.success) {
      return { error: text ? 'Use a few descriptive words (not a web address or “click here”), up to 120 characters.' : 'Enter link text.' };
    }
    if (text === link.text.trim()) return { error: 'The link text is unchanged.' };
    // Using the line's own label folds "Label - address" into a single linked label.
    const fold = link.label && text === link.label.value;
    return {
      ...common,
      operation: {
        kind: 'set_link_text',
        relationshipId: link.relationshipId,
        paragraphIndex: link.paragraphIndex,
        runIndex: link.runIndex,
        runCount: link.runCount,
        expectedText: link.text,
        text,
        ...(fold ? { label: { runIndex: link.label!.runIndex, runCount: link.label!.runCount, expectedText: link.label!.text } } : {}),
      },
      featureVersion: `LINK-01@${ENGINE_VERSION}`,
    };
  }
  if (obj.kind !== 'picture' || obj.support !== 'editable') return { error: 'This object cannot be edited here.' };
  const normalized = normalizeDescription(draft.text, LIMITS.manualDescriptionCodePoints);
  if (!normalized.ok) return { error: normalized.message };
  return { ...common, operation: { kind: 'set_description', value: normalized.value }, featureVersion: `ALT-01@${ENGINE_VERSION}` };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'START_FILE':
      return {
        ...initialState,
        manualOnly: state.manualOnly,
        stage: 'validating',
        sessionId: state.sessionId + 1,
        fileName: action.name,
        announcement: announce(state, `Checking ${action.name}.`),
      };
    case 'PROGRESS': {
      const stage = action.stage === 'scanning' && state.stage === 'validating' ? 'scanning' : state.stage;
      const next = { ...state, stage, progress: { stage: action.stage, done: action.done, total: action.total } } as AppState;
      if (stage !== state.stage) next.announcement = announce(state, 'Scanning slides.');
      return next;
    }
    case 'SCAN_OK': {
      const { payload } = action;
      const firstWithFindings = payload.manifest.slides.find((s) => payload.findings.some((f) => f.slideKey === s.key)) ?? payload.manifest.slides[0];
      const errors = payload.findings.filter((f) => f.severity === 'error').length;
      const next: AppState = {
        ...state,
        stage: 'reviewing',
        scan: payload,
        findings: payload.findings,
        view: 'findings',
        announcement: announce(
          state,
          `Scan complete: ${payload.manifest.slides.length} slides, ${payload.findings.length} findings, ${errors} errors.`,
        ),
      };
      delete next.progress;
      if (firstWithFindings) next.selectedSlideKey = firstWithFindings.key;
      return next;
    }
    case 'SCAN_FAILED': {
      const next: AppState = { ...state, stage: 'rejected', rejection: { code: action.code, message: action.message }, announcement: announce(state, 'The file could not be opened.') };
      delete next.progress;
      return next;
    }
    case 'CANCEL_SCAN':
      return { ...initialState, manualOnly: state.manualOnly, sessionId: state.sessionId + 1, announcement: announce(state, 'Scanning cancelled.') };
    case 'SELECT_SLIDE': {
      const next = { ...state, selectedSlideKey: action.slideKey, view: 'findings' as View };
      delete next.selectedFindingId;
      return next;
    }
    case 'SELECT_FINDING': {
      const next = { ...state };
      if (action.findingId) next.selectedFindingId = action.findingId;
      else delete next.selectedFindingId;
      return next;
    }
    case 'SET_DRAFT': {
      const prev = state.drafts[action.targetKey];
      const draft: Draft = prev
        ? { ...prev, text: action.text, edited: prev.origin === 'ai_suggestion' ? true : prev.edited }
        : { text: action.text, origin: 'manual', edited: true };
      const approved = state.patches.find((p) => patchTarget(p) === action.targetKey);
      if (!approved) return { ...state, drafts: { ...state.drafts, [action.targetKey]: draft } };
      // Changing text after approval invalidates that approval.
      return {
        ...state,
        drafts: { ...state.drafts, [action.targetKey]: draft },
        patches: state.patches.filter((p) => p !== approved),
        findings: setTargetFindings(state.findings, action.targetKey, stateWithoutApproval(draft)),
        announcement: announce(state, 'Approval removed because the description changed. Approve it again when ready.'),
      };
    }
    case 'AI_SUGGESTION': {
      const draft: Draft = { text: action.text, origin: 'ai_suggestion', edited: false, ai: action.ai };
      const approved = state.patches.find((p) => patchTarget(p) === action.targetKey);
      return {
        ...state,
        drafts: { ...state.drafts, [action.targetKey]: draft },
        patches: approved ? state.patches.filter((p) => p !== approved) : state.patches,
        findings: setTargetFindings(state.findings, action.targetKey, 'suggested'),
        announcement: announce(
          state,
          action.text ? 'AI draft ready for review. It is not applied until you approve it.' : 'The AI could not suggest text here. Please write it yourself.',
        ),
      };
    }
    case 'REVERT_DRAFT': {
      const drafts = { ...state.drafts };
      delete drafts[action.targetKey];
      const approved = state.patches.find((p) => patchTarget(p) === action.targetKey);
      return {
        ...state,
        drafts,
        patches: approved ? state.patches.filter((p) => p !== approved) : state.patches,
        findings: setTargetFindings(state.findings, action.targetKey, 'open'),
        announcement: announce(state, 'Draft cleared. The original description is unchanged.'),
      };
    }
    case 'APPROVE': {
      const patch = buildPatch(state, action.targetKey, action.now, action.patchId);
      if ('error' in patch) return { ...state, announcement: announce(state, patch.error) };
      return {
        ...state,
        patches: [...state.patches.filter((p) => patchTarget(p) !== action.targetKey), patch],
        findings: setTargetFindings(state.findings, action.targetKey, 'approved', patch.id),
        announcement: announce(state, 'Description approved. It will be written when you export.'),
      };
    }
    case 'REVOKE': {
      const draft = state.drafts[action.targetKey];
      return {
        ...state,
        patches: state.patches.filter((p) => patchTarget(p) !== action.targetKey),
        findings: setTargetFindings(state.findings, action.targetKey, stateWithoutApproval(draft)),
        announcement: announce(state, 'Approval removed.'),
      };
    }
    case 'UNDO_LAST': {
      const last = state.patches[state.patches.length - 1];
      if (!last) return state;
      const draft = state.drafts[patchTarget(last)];
      return {
        ...state,
        patches: state.patches.slice(0, -1),
        findings: setTargetFindings(state.findings, patchTarget(last), stateWithoutApproval(draft)),
        announcement: announce(state, 'Last approval undone.'),
      };
    }
    case 'DISMISS': {
      const reason = action.reason.trim();
      if (!reason) return { ...state, announcement: announce(state, 'Enter a reason to dismiss this finding.') };
      return {
        ...state,
        findings: state.findings.map((f) => (f.id === action.findingId ? { ...f, state: 'dismissed', resolution: { reason, actor: 'user', at: action.now } } : f)),
        announcement: announce(state, 'Finding dismissed. It will be listed as unresolved in the report.'),
      };
    }
    case 'DEFER':
      return {
        ...state,
        findings: state.findings.map((f) => (f.id === action.findingId ? { ...f, state: 'deferred', resolution: { reason: 'Deferred for later review', actor: 'user', at: action.now } } : f)),
        announcement: announce(state, 'Finding deferred.'),
      };
    case 'REOPEN':
      return {
        ...state,
        findings: state.findings.map((f) => {
          if (f.id !== action.findingId) return f;
          const next: Finding = { ...f, state: 'open' };
          delete next.resolution;
          return next;
        }),
        announcement: announce(state, 'Finding reopened.'),
      };
    case 'SET_VIEW':
      return { ...state, view: action.view };
    case 'REMEDIATE_START':
      return {
        ...state,
        stage: 'remediating',
        remediation: { total: action.total, done: 0, applied: [], skipped: [] },
        announcement: announce(state, `Remediating: writing descriptions for ${action.total} picture${action.total === 1 ? '' : 's'}.`),
      };
    case 'REMEDIATE_PROGRESS': {
      if (!state.remediation) return state;
      const run: RemediationRun = { ...state.remediation, done: action.done };
      if (action.current) run.current = action.current;
      else delete run.current;
      return { ...state, remediation: run };
    }
    case 'AUTO_APPLY': {
      if (!state.remediation) return state;
      const withDraft: AppState = {
        ...state,
        drafts: { ...state.drafts, [action.targetKey]: { text: action.text, origin: action.origin, edited: false, ...(action.ai ? { ai: action.ai } : {}) } },
      };
      const patch = buildPatch(withDraft, action.targetKey, action.now, action.patchId, true);
      if ('error' in patch) {
        return { ...state, remediation: { ...state.remediation, skipped: [...state.remediation.skipped, { targetKey: action.targetKey, code: 'INVALID_TEXT', message: patch.error }] } };
      }
      return {
        ...withDraft,
        patches: [...state.patches.filter((p) => patchTarget(p) !== action.targetKey), patch],
        findings: setTargetFindings(state.findings, action.targetKey, 'approved', patch.id),
        remediation: { ...state.remediation, applied: [...state.remediation.applied, action.targetKey] },
      };
    }
    case 'REMEDIATE_SKIPPED':
      if (!state.remediation) return state;
      return { ...state, remediation: { ...state.remediation, skipped: [...state.remediation.skipped, { targetKey: action.targetKey, code: action.code, message: action.message }] } };
    case 'REMEDIATE_END': {
      if (!state.remediation) return state;
      const run: RemediationRun = { ...state.remediation, cancelled: action.cancelled };
      if (action.halted) run.halted = action.halted;
      delete run.current;
      return {
        ...state,
        stage: action.cancelled ? 'reviewing' : state.stage,
        remediation: run,
        announcement: action.cancelled ? announce(state, 'Remediation stopped. Descriptions written so far are kept as approved changes.') : state.announcement,
      };
    }
    case 'EXPORT_START': {
      const next: AppState = { ...state, stage: 'exporting', announcement: announce(state, 'Exporting and verifying the presentation.') };
      delete next.exportError;
      delete next.exportOutcome;
      return next;
    }
    case 'EXPORT_OK':
      return {
        ...state,
        stage: 'complete',
        exportOutcome: action.outcome,
        findings: action.findings,
        announcement: announce(state, 'Export verified. Your downloads are ready.'),
      };
    case 'EXPORT_FAILED': {
      const next: AppState = {
        ...state,
        stage: 'reviewing',
        view: 'changes',
        exportError: { code: action.code, message: action.message },
        announcement: announce(state, `Export failed: ${action.message}`),
      };
      delete next.progress;
      return next;
    }
    case 'REVISE': {
      // Back to review with approvals intact; exported states revert to approved.
      const next: AppState = {
        ...state,
        stage: 'reviewing',
        view: 'changes',
        findings: state.findings.map((f) => {
          if (f.state !== 'applied' && f.state !== 'rechecked' && f.state !== 'failed') return f;
          return { ...f, state: 'approved', verification: { ...f.verification, package: 'pending', rule: 'pending' } };
        }),
        announcement: announce(state, 'Back to review. Your approved changes are kept.'),
      };
      delete next.exportOutcome;
      return next;
    }
    case 'CLEAR':
      return { ...initialState, sessionId: state.sessionId + 1, announcement: announce(state, 'Session cleared.') };
    case 'SET_AI_CONSENT':
      return { ...state, aiConsent: action.value };
    case 'SET_MANUAL_ONLY':
      return { ...state, manualOnly: action.value, aiConsent: action.value ? false : state.aiConsent };
    case 'ANNOUNCE':
      return { ...state, announcement: announce(state, action.text) };
  }
}

/** Finding IDs addressed by each patch, for the change ledger. */
export function findingIdsByPatch(state: AppState, patches: ApprovedPatch[] = state.patches): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of patches) {
    out[p.id] = state.findings.filter((f) => isTargetFinding(f, patchTarget(p)) && f.state === 'approved').map((f) => f.id);
  }
  return out;
}

export function hasUnsavedWork(state: AppState): boolean {
  return state.patches.length > 0 || Object.keys(state.drafts).length > 0 || state.findings.some((f) => f.state === 'dismissed' || f.state === 'deferred');
}
