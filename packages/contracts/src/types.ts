/**
 * Normative local data contracts (spec §14). Fields marked "additive" extend the §14
 * shapes without changing existing fields, so the schema minor version is retained.
 * Optional fields are omitted rather than populated with invented data.
 */

export type Sha256 = string; // lowercase 64-character hex
export type ObjectKey = string; // source hash + normalized slide part + shape ID

export type ObjectKind =
  | 'picture'
  | 'text'
  | 'table'
  | 'chart'
  | 'group'
  | 'audio'
  | 'video'
  | 'smartart'
  | 'unknown';

export type FindingState =
  | 'open'
  | 'suggested'
  | 'approved'
  | 'applied'
  | 'rechecked'
  | 'dismissed'
  | 'deferred'
  | 'failed';

export interface UnsupportedItem {
  part?: string;
  code: string;
  detail: string;
}

export interface DeckManifest {
  schemaVersion: '1.0';
  sourceSha256: Sha256;
  sourceName: string; // local only
  compressedBytes: number;
  inspectedExpandedBytes: number;
  engineVersion: string;
  slides: SlideRecord[];
  unsupported: UnsupportedItem[];
  /** Additive: every ZIP entry in source order, for preservation checks. */
  entries?: { path: string; expandedBytes: number }[];
}

export interface SlideRecord {
  key: string;
  part: string;
  presentationId: string;
  ordinal: number; // 1-based position from presentation relationships
  hidden: boolean;
  title: { text: string; objectKey?: ObjectKey; kind: 'title' | 'ctrTitle' | 'none' };
  text: string; // local extraction; not automatically sent to AI
  objects: ObjectRecord[];
  /** Additive: layout part used by this slide, when resolvable. */
  layoutPart?: string;
  /** Additive: number of genuine title placeholders found (ambiguity signal). */
  titlePlaceholderCount?: number;
  /** Additive: resolved slide background, only when a plain sRGB solid fill. */
  background?: { srgb?: string; resolved: boolean };
}

export interface PictureTransform {
  /** a:srcRect crop in 1/1000ths of a percent (OOXML ST_Percentage), when present. */
  srcRect?: { l: number; t: number; r: number; b: number };
  /** Reasons the local preview cannot faithfully represent the visible appearance. */
  blockers: string[];
}

export interface LinkRecord {
  text: string;
  relationshipId: string;
  target?: string;
  external: boolean;
  /** 'run' for a text hyperlink, 'object' for a click action on the whole shape. */
  scope: 'run' | 'object';
  /** Stable key for run links: `${objectKey}|link:${paragraph}:${ordinal}`. */
  key?: string;
  /** Table cell (text body) index, for links inside tables. */
  cellIndex?: number;
  /** Paragraph index within the shape's text body (run links). */
  paragraphIndex?: number;
  /** 0-based position of this link among the link groups in its paragraph. */
  linkOrdinal?: number;
  /** Element-child index of the first run within the paragraph, and number of runs. */
  runIndex?: number;
  runCount?: number;
  /** True when the link text can be replaced safely by this tool. */
  editable?: boolean;
  /**
   * "Label - address" lines: the plain runs before the link hold a label that should
   * become the link text (ADR 0004). Present only when the paragraph is exactly that.
   */
  label?: { runIndex: number; runCount: number; text: string; value: string };
}

export interface TableInfo {
  rows: number;
  columns: number;
  firstRow: boolean;
  merged: boolean;
  firstRowText: string[];
}

export interface TextRunStyle {
  text: string;
  /** Explicit sRGB colour without transforms, when resolvable. */
  srgb?: string;
  /** Font size in hundredths of a point, when explicit. */
  size?: number;
  bold?: boolean;
  /** Why the colour could not be resolved, when it could not. */
  unresolved?: string;
}

export interface ObjectRecord {
  key: ObjectKey;
  slideKey: string;
  shapeId: string;
  name: string;
  kind: ObjectKind;
  parentKey?: ObjectKey;
  sourceOrder: number;
  boundsEmu?: { x: number; y: number; w: number; h: number };
  alt: { description: string; title: string; decorative: boolean | 'unknown' };
  media?: { relationshipId: string; part: string; mime: string; sha256: Sha256 };
  text?: string;
  support: 'editable' | 'inspection_only' | 'unsupported';
  limitations: string[];
  /** Additive: placeholder type (resolved through the layout when inherited). */
  placeholder?: { type: string; idx?: string; inherited: boolean };
  /** Additive: picture appearance transforms relevant to preview/AI eligibility. */
  transform?: PictureTransform;
  /** Additive: hyperlinks discovered on this object. */
  links?: LinkRecord[];
  /** Additive: simple table structure summary. */
  table?: TableInfo;
  /** Additive: shape fill used as text background, only when a plain sRGB solid fill. */
  fill?: { srgb?: string; kind: 'solid' | 'none' | 'other' | 'inherited' };
  /** Additive: per-run style evidence for contrast checks. */
  runs?: TextRunStyle[];
  /** Additive: XML element local name (sp, pic, graphicFrame, grpSp, cxnSp, ...). */
  element: string;
}

export interface Finding {
  id: string; // stable hash of rule version, object/slide key and evidence key
  ruleId: string;
  ruleVersion: string;
  slideKey: string;
  objectKey?: ObjectKey;
  severity: 'error' | 'warning' | 'review';
  capability: 'automatic' | 'approval_required' | 'manual_review';
  evidence: { code: string; detail: string }[];
  state: FindingState;
  proposedPatchId?: string;
  /** Additive: sub-object target (e.g. one link) when the finding is narrower than an object. */
  targetKey?: string;
  resolution?: { reason: string; actor: 'user' | 'engine'; at: string };
  verification: {
    package: 'pending' | 'pass' | 'fail';
    rule: 'pending' | 'pass' | 'fail' | 'indeterminate';
    human: 'not_reviewed' | 'confirmed';
  };
}

export type EditOperation =
  | { kind: 'set_description'; value: string }
  | { kind: 'set_decorative'; value: boolean }
  | { kind: 'set_slide_title'; text: string; strategy: 'existing' | 'off_slide_placeholder' }
  | { kind: 'set_first_row_header'; value: boolean }
  | { kind: 'reorder_shapes'; orderedShapeIds: string[] }
  | {
      kind: 'set_link_text';
      relationshipId: string;
      paragraphIndex: number;
      runIndex: number;
      runCount: number;
      /** Current link text; the edit fails if the slide no longer matches. */
      expectedText: string;
      text: string;
      /** Fold these preceding label runs into the link ("CredLens - https://…" → "CredLens"). */
      label?: { runIndex: number; runCount: number; expectedText: string };
    };

export interface ApprovedPatch {
  id: string;
  sourceSha256: Sha256;
  slideKey: string;
  objectKey?: ObjectKey;
  part: string;
  expectedOriginalPartSha256: Sha256;
  operation: EditOperation;
  origin: 'manual' | 'ai_suggestion' | 'rule_suggestion';
  featureVersion: string;
  approvedAt: string;
  /** Additive: target shape ID within `part` (required for object operations). */
  shapeId?: string;
  /** Additive: applied by "Remediate All" without per-item human review (ADR 0003). */
  autoApplied?: boolean;
  /** Additive: the edited target within the object (a link key for link edits). */
  targetKey?: string;
}

export interface ChangeRecord {
  patchId: string;
  findingIds: string[];
  part: string;
  objectKey?: ObjectKey;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  applyStatus: 'applied' | 'failed';
  errorCode?: string;
  /** Additive: where the new value came from. */
  origin?: ApprovedPatch['origin'];
  /** Additive: applied automatically without per-item human review. */
  autoApplied?: boolean;
}

export interface CoverageRecord {
  ruleId: string;
  evaluated: number;
  unsupported: number;
  indeterminate: number;
}

export interface Report {
  schemaVersion: '1.0';
  engineVersion: string;
  rulesVersion: string;
  generatedAt: string;
  sourceSha256: Sha256;
  outputSha256?: Sha256;
  sourceName?: string; // local download only; omitted by default
  findings: Finding[];
  changes: ChangeRecord[];
  coverage: CoverageRecord[];
  limitations: string[];
}

/** Overall session flow (spec §14 "State and consistency rules"). */
export type SessionStage = 'idle' | 'validating' | 'scanning' | 'reviewing' | 'exporting' | 'complete';
