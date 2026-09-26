/**
 * Rule evaluation over a DeckManifest (spec §5, §16). Detection is conservative:
 * unsupported or unresolvable evidence is reported as unsupported/indeterminate and
 * never as passed. Findings start `open`; only the user or a verified export changes that.
 */
import {
  FEATURES,
  RULES_VERSION,
  isGenericLinkText,
  looksLikeUrl,
  stableId,
  type CoverageRecord,
  type DeckManifest,
  type Finding,
  type ObjectRecord,
  type SlideRecord,
} from '@ppt-remedy/contracts';
import { assessRun } from './contrast.ts';

export interface RulesResult {
  findings: Finding[];
  coverage: CoverageRecord[];
  limitations: string[];
}

const ALT_KINDS = new Set(['picture', 'chart', 'smartart', 'video', 'audio']);

const GENERIC_LABEL = /^(picture|image|img|graphic|photo|photograph|screenshot|screen shot|chart|diagram|icon|logo|figure|fig|clipart|clip art|untitled|placeholder|alt text|alt|description)[\s_-]*\d*\.?$/i;
const FILE_NAME = /^[^\\/:*?"<>|\n]{1,120}\.(png|jpe?g|gif|bmp|svg|emf|wmf|tiff?|webp|heic|ico)$/i;
const CAMERA_NAME = /^(img|dsc|dscn|dcim|pxl|mvimg|photo|screenshot)[_\- ]?\d{2,}/i;
const AUTO_GENERATED = /description automatically generated|automatically generated description/i;

const PENDING = (): Finding['verification'] => ({ package: 'pending', rule: 'pending', human: 'not_reviewed' });

class Collector {
  readonly findings: Finding[] = [];
  private readonly coverage = new Map<string, CoverageRecord>();

  cover(ruleId: string, field: 'evaluated' | 'unsupported' | 'indeterminate', n = 1): void {
    const rec = this.coverage.get(ruleId) ?? { ruleId, evaluated: 0, unsupported: 0, indeterminate: 0 };
    rec[field] += n;
    this.coverage.set(ruleId, rec);
  }

  add(f: Omit<Finding, 'id' | 'ruleVersion' | 'state' | 'verification'>, evidenceKey: string): void {
    const locator = f.objectKey ?? f.slideKey;
    this.findings.push({
      id: stableId(`${f.ruleId}@${RULES_VERSION}|${locator}|${evidenceKey}`),
      ruleVersion: RULES_VERSION,
      state: 'open',
      verification: PENDING(),
      ...f,
    });
  }

  coverageList(): CoverageRecord[] {
    return [...this.coverage.values()];
  }
}

export function evaluate(manifest: DeckManifest): RulesResult {
  const c = new Collector();
  for (const id of [
    'IMG_MISSING_ALT', 'IMG_GENERIC_ALT', 'IMG_COMPLEX_VISUAL', 'SLIDE_MISSING_TITLE', 'SLIDE_DUPLICATE_TITLE', 'ORDER_REVIEW',
    'LINK_GENERIC_TEXT', 'TABLE_HEADER_REVIEW', 'TABLE_COMPLEX', 'CONTRAST_LOW', 'CONTRAST_INDETERMINATE', 'MEDIA_CAPTION_REVIEW', 'OBJECT_UNSUPPORTED',
  ]) {
    c.cover(id, 'evaluated', 0);
  }
  for (const slide of manifest.slides) {
    for (const obj of slide.objects) {
      altRules(c, slide, obj);
      linkRules(c, slide, obj);
      tableRules(c, slide, obj);
      mediaRules(c, slide, obj);
      unsupportedRule(c, slide, obj);
    }
    titleRule(c, slide);
    orderRule(c, slide);
    contrastRules(c, slide);
  }
  duplicateTitleRule(c, manifest.slides);
  return { findings: c.findings, coverage: c.coverageList(), limitations: deckLimitations(manifest) };
}

function altRules(c: Collector, slide: SlideRecord, obj: ObjectRecord): void {
  if (!ALT_KINDS.has(obj.kind)) return;
  const editable = obj.kind === 'picture' && obj.support === 'editable' && FEATURES.pictureDescription;
  const capability = editable ? 'approval_required' : 'manual_review';
  const description = obj.alt.description.trim();
  c.cover('IMG_MISSING_ALT', obj.support === 'unsupported' ? 'unsupported' : 'evaluated');

  if (obj.alt.decorative === true) {
    // Known decorative: no description required.
  } else if (description === '') {
    const evidence = [{ code: 'MISSING_DESCRIPTION', detail: `${kindLabel(obj)} “${obj.name || obj.shapeId}” has no description.` }];
    if (obj.alt.title.trim() !== '') evidence.push({ code: 'LEGACY_TITLE_ONLY', detail: `Only the legacy alt-text title is set (“${obj.alt.title.trim()}”); many screen readers ignore it.` });
    if (obj.alt.decorative === 'unknown') evidence.push({ code: 'DECORATIVE_UNKNOWN', detail: 'A decorative marker is present but could not be interpreted.' });
    if (obj.limitations.includes('GROUPED')) evidence.push({ code: 'GROUPED', detail: 'Inside a group; edit it in PowerPoint.' });
    if (obj.kind !== 'picture') evidence.push({ code: 'MANUAL_ONLY_KIND', detail: `${kindLabel(obj)} descriptions are edited in PowerPoint in this release.` });
    c.add({ ruleId: 'IMG_MISSING_ALT', slideKey: slide.key, objectKey: obj.key, severity: 'error', capability, evidence }, 'missing');
  } else if (obj.kind === 'picture') {
    const code = genericCode(description, obj.name);
    c.cover('IMG_GENERIC_ALT', 'evaluated');
    if (code) {
      c.add(
        {
          ruleId: 'IMG_GENERIC_ALT',
          slideKey: slide.key,
          objectKey: obj.key,
          severity: 'warning',
          capability,
          evidence: [{ code, detail: `Current description: “${truncate(description, 120)}”.` }],
        },
        code,
      );
    }
  }

  // Complex or unsupported visual appearance.
  const complex: { code: string; detail: string }[] = [];
  if (obj.kind === 'chart') complex.push({ code: 'CHART', detail: 'Charts need their data and key trend described; verify values against the chart data, not the picture.' });
  if (obj.kind === 'smartart') complex.push({ code: 'SMARTART', detail: 'SmartArt conveys structure; describe the relationships or provide the content as text.' });
  if (obj.kind === 'picture') {
    for (const b of obj.transform?.blockers ?? []) {
      if (b === 'GROUPED') continue;
      complex.push({ code: b, detail: blockerDetail(b, obj) });
    }
  }
  if (complex.length) {
    c.cover('IMG_COMPLEX_VISUAL', 'evaluated');
    c.add({ ruleId: 'IMG_COMPLEX_VISUAL', slideKey: slide.key, objectKey: obj.key, severity: 'review', capability: 'manual_review', evidence: complex }, complex.map((e) => e.code).join(','));
  }
}

export function genericCode(description: string, objectName: string): string | undefined {
  const d = description.trim();
  if (AUTO_GENERATED.test(d)) return 'AUTO_GENERATED';
  if (FILE_NAME.test(d)) return 'FILENAME';
  if (CAMERA_NAME.test(d)) return 'FILENAME';
  if (objectName && d.toLowerCase() === objectName.trim().toLowerCase()) return 'OBJECT_NAME';
  if (GENERIC_LABEL.test(d)) return 'GENERIC_LABEL';
  return undefined;
}

function blockerDetail(code: string, obj: ObjectRecord): string {
  const map: Record<string, string> = {
    NON_RASTER_OR_UNSUPPORTED_FORMAT: `This ${obj.media?.mime ?? 'image'} format cannot be previewed or sent for AI suggestions; describe it manually.`,
    CROP_PADDING: 'The picture has padding or an unusual crop the preview cannot show faithfully.',
    CROP_INVALID: 'The picture crop is invalid.',
    TILED_FILL: 'The picture is tiled; the preview cannot show it faithfully.',
    RECOLOR_OR_EFFECT: 'Recolouring or picture effects change its appearance; the preview cannot show it faithfully.',
    IMAGE_EFFECT_EXTENSION: 'Artistic or extension effects change its appearance.',
    SHAPE_MASK: 'The picture is masked to a shape.',
    ROTATION_OR_FLIP: 'The picture is rotated or flipped.',
    LINKED_IMAGE: 'The picture is linked to an external file and is never fetched.',
    MEDIA_UNRESOLVED: 'The picture data could not be found in the package.',
    NO_IMAGE_REFERENCE: 'The picture has no image reference.',
  };
  return map[code] ?? 'The visible appearance cannot be represented faithfully.';
}

function titleRule(c: Collector, slide: SlideRecord): void {
  const contentBearing = slide.objects.length > 0;
  if (!contentBearing) return;
  c.cover('SLIDE_MISSING_TITLE', 'evaluated');
  if (slide.title.text.trim() !== '') return;
  const evidence =
    slide.title.kind === 'none'
      ? [{ code: 'NO_TITLE_PLACEHOLDER', detail: 'No title placeholder found on this slide.' }]
      : [{ code: 'EMPTY_TITLE_PLACEHOLDER', detail: 'The title placeholder is empty.' }];
  c.add({ ruleId: 'SLIDE_MISSING_TITLE', slideKey: slide.key, severity: 'error', capability: 'manual_review', evidence }, evidence[0]!.code);
}

export function normalizeTitle(t: string): string {
  return t.normalize('NFC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
}

function duplicateTitleRule(c: Collector, slides: SlideRecord[]): void {
  const groups = new Map<string, SlideRecord[]>();
  for (const s of slides) {
    const key = normalizeTitle(s.title.text);
    if (!key) continue;
    c.cover('SLIDE_DUPLICATE_TITLE', 'evaluated');
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const s of group) {
      const others = group.filter((o) => o !== s).map((o) => o.ordinal);
      c.add(
        {
          ruleId: 'SLIDE_DUPLICATE_TITLE',
          slideKey: s.key,
          severity: 'warning',
          capability: 'manual_review',
          evidence: [{ code: 'DUPLICATE_OF', detail: `“${truncate(s.title.text, 80)}” is also the title of slide${others.length > 1 ? 's' : ''} ${others.join(', ')}.` }],
        },
        'duplicate',
      );
    }
  }
}

function orderRule(c: Collector, slide: SlideRecord): void {
  const top = slide.objects.filter((o) => !o.parentKey && !o.limitations.includes('CONNECTOR'));
  if (top.length < 2) return;
  c.cover('ORDER_REVIEW', 'evaluated');
  const evidence: { code: string; detail: string }[] = [
    { code: 'OBJECT_SEQUENCE', detail: `Object sequence — verify in PowerPoint: ${top.slice(0, 12).map((o, i) => `${i + 1}. ${o.name || kindLabel(o)}`).join('; ')}${top.length > 12 ? '; …' : ''}` },
  ];
  const titleIndex = top.findIndex((o) => o.key === slide.title.objectKey);
  if (titleIndex > 0) evidence.push({ code: 'TITLE_NOT_FIRST', detail: `The title is object ${titleIndex + 1} in the sequence, not first.` });
  const suspect = geometrySuspect(top);
  if (suspect) evidence.push({ code: 'GEOMETRY_ORDER_DIFFERS', detail: `“${suspect.later.name}” comes after “${suspect.earlier.name}” but sits entirely above it.` });
  const severity = evidence.length > 1 ? 'warning' : 'review';
  c.add({ ruleId: 'ORDER_REVIEW', slideKey: slide.key, severity, capability: 'manual_review', evidence }, 'order');
}

function geometrySuspect(objs: ObjectRecord[]): { earlier: ObjectRecord; later: ObjectRecord } | undefined {
  for (let i = 0; i < objs.length; i++) {
    const a = objs[i]!.boundsEmu;
    if (!a) continue;
    for (let j = i + 1; j < objs.length; j++) {
      const b = objs[j]!.boundsEmu;
      if (!b) continue;
      // Later object's bottom edge is above the earlier object's top edge.
      if (b.y + b.h <= a.y) return { earlier: objs[i]!, later: objs[j]! };
    }
  }
  return undefined;
}

function linkRules(c: Collector, slide: SlideRecord, obj: ObjectRecord): void {
  for (const link of obj.links ?? []) {
    if (link.scope !== 'run') continue;
    c.cover('LINK_GENERIC_TEXT', 'evaluated');
    const text = link.text.trim();
    let code: string | undefined;
    if (looksLikeUrl(text) || (link.target && text === link.target)) code = 'RAW_URL';
    else if (isGenericLinkText(text)) code = 'GENERIC_TEXT';
    if (!code) continue;
    const destination = link.external ? `external destination ${truncate(link.target ?? '(unknown)', 200)}` : `internal destination ${link.target ?? '(unknown)'}`;
    const editable = !!link.editable && FEATURES.linkText;
    const finding: Omit<Finding, 'id' | 'ruleVersion' | 'state' | 'verification'> = {
      ruleId: 'LINK_GENERIC_TEXT',
      slideKey: slide.key,
      objectKey: obj.key,
      severity: 'warning',
      capability: editable ? 'approval_required' : 'manual_review',
      evidence: [{ code, detail: `Link text “${truncate(text, 120)}” → ${destination}.` }],
    };
    if (link.key) finding.targetKey = link.key;
    c.add(finding, `${link.key ?? link.relationshipId}:${code}`);
  }
}

function tableRules(c: Collector, slide: SlideRecord, obj: ObjectRecord): void {
  if (obj.kind !== 'table' || !obj.table) return;
  c.cover('TABLE_HEADER_REVIEW', 'evaluated');
  c.cover('TABLE_COMPLEX', 'evaluated');
  if (!obj.table.firstRow) {
    c.add(
      {
        ruleId: 'TABLE_HEADER_REVIEW',
        slideKey: slide.key,
        objectKey: obj.key,
        severity: 'warning',
        capability: 'manual_review',
        evidence: [{ code: 'NO_HEADER_ROW_FLAG', detail: `Header Row is off. First row: ${obj.table.firstRowText.slice(0, 6).map((t) => `“${truncate(t, 30)}”`).join(', ') || '(empty)'}.` }],
      },
      'no-header',
    );
  }
  if (obj.table.merged) {
    c.add(
      {
        ruleId: 'TABLE_COMPLEX',
        slideKey: slide.key,
        objectKey: obj.key,
        severity: 'warning',
        capability: 'manual_review',
        evidence: [{ code: 'MERGED_CELLS', detail: `The ${obj.table.rows}×${obj.table.columns} table has merged or split cells.` }],
      },
      'merged',
    );
  }
}

function mediaRules(c: Collector, slide: SlideRecord, obj: ObjectRecord): void {
  if (obj.kind !== 'video' && obj.kind !== 'audio') return;
  c.cover('MEDIA_CAPTION_REVIEW', 'evaluated');
  const evidence = [{ code: 'MEDIA_OBJECT', detail: `${kindLabel(obj)} “${obj.name || obj.shapeId}” — check captions${obj.kind === 'audio' ? ' or a transcript' : ''}.` }];
  if (obj.limitations.includes('EXTERNAL_MEDIA')) evidence.push({ code: 'EXTERNAL_MEDIA', detail: 'The media is linked externally and was not inspected.' });
  c.add({ ruleId: 'MEDIA_CAPTION_REVIEW', slideKey: slide.key, objectKey: obj.key, severity: 'review', capability: 'manual_review', evidence }, 'media');
}

function unsupportedRule(c: Collector, slide: SlideRecord, obj: ObjectRecord): void {
  if (obj.support !== 'unsupported') return;
  c.cover('OBJECT_UNSUPPORTED', 'unsupported');
  const codes = obj.limitations.filter((l) => l !== 'GROUPED');
  c.add(
    {
      ruleId: 'OBJECT_UNSUPPORTED',
      slideKey: slide.key,
      objectKey: obj.key,
      severity: 'review',
      capability: 'manual_review',
      evidence: codes.map((code) => ({ code, detail: limitationDetail(code) })),
    },
    codes.join(','),
  );
}

function limitationDetail(code: string): string {
  const map: Record<string, string> = {
    SMARTART: 'SmartArt is preserved but not assessed.',
    OLE_OBJECT: 'Embedded (OLE) object is preserved but not assessed.',
    ALTERNATE_CONTENT: 'Markup-compatibility content is preserved as-is and not assessed.',
    INK_OR_CONTENT_PART: 'Ink or content part is preserved but not assessed.',
    UNKNOWN_GRAPHIC: 'Unknown graphic type is preserved but not assessed.',
    UNKNOWN_ELEMENT: 'Unknown element is preserved but not assessed.',
    DUPLICATE_SHAPE_ID: 'Its shape ID is shared with another object, so it cannot be targeted safely.',
    NO_SHAPE_ID: 'The object has no shape ID.',
  };
  return map[code] ?? code;
}

interface Bounds { x: number; y: number; w: number; h: number }

function intersects(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function contrastRules(c: Collector, slide: SlideRecord): void {
  const reasons = new Map<string, number>();
  let indeterminateObjects = 0;
  const note = (reason: string, n = 1) => reasons.set(reason, (reasons.get(reason) ?? 0) + n);
  slide.objects.forEach((obj, index) => {
    const runs = obj.runs ?? [];
    if (runs.length === 0) return;
    // Resolve background.
    let bg: string | undefined;
    let bgReason: string | undefined;
    if (obj.parentKey) bgReason = 'grouped text';
    else if (obj.fill?.kind === 'solid' && obj.fill.srgb) bg = obj.fill.srgb;
    else if (obj.fill?.kind === 'none') {
      const beneath = slide.objects.slice(0, index).some((o) => !o.parentKey && o.boundsEmu && obj.boundsEmu && intersects(o.boundsEmu, obj.boundsEmu));
      if (!obj.boundsEmu) bgReason = 'unknown position';
      else if (beneath) bgReason = 'overlapping objects';
      else if (slide.background?.resolved && slide.background.srgb) bg = slide.background.srgb;
      else bgReason = 'theme or image background';
    } else bgReason = obj.fill?.kind === 'inherited' ? 'theme shape fill' : 'gradient, picture or pattern fill';

    const failing: { code: string; detail: string }[] = [];
    let objIndeterminate = false;
    for (const run of runs) {
      if (!bg) {
        c.cover('CONTRAST_LOW', 'indeterminate');
        note(bgReason ?? 'unknown background');
        objIndeterminate = true;
        continue;
      }
      if (!run.srgb) {
        c.cover('CONTRAST_LOW', 'indeterminate');
        note(run.unresolved ?? 'unresolved text colour');
        objIndeterminate = true;
        continue;
      }
      const outcome = assessRun(run.srgb, bg, run.size, run.bold);
      if (outcome.result === 'indeterminate') {
        c.cover('CONTRAST_LOW', 'indeterminate');
        note(outcome.reason);
        objIndeterminate = true;
      } else {
        c.cover('CONTRAST_LOW', 'evaluated');
        if (outcome.result === 'fail') {
          failing.push({
            code: 'RATIO_BELOW_MINIMUM',
            detail: `“${truncate(run.text, 40)}”: #${run.srgb} on #${bg} is ${Math.floor(outcome.ratio * 100) / 100}:1; at least ${outcome.required}:1 is required.`,
          });
        }
      }
    }
    if (failing.length) {
      c.add({ ruleId: 'CONTRAST_LOW', slideKey: slide.key, objectKey: obj.key, severity: 'error', capability: 'manual_review', evidence: failing.slice(0, 5) }, 'low');
    }
    if (objIndeterminate) indeterminateObjects++;
  });
  if (indeterminateObjects > 0) {
    c.cover('CONTRAST_INDETERMINATE', 'indeterminate', indeterminateObjects);
    c.add(
      {
        ruleId: 'CONTRAST_INDETERMINATE',
        slideKey: slide.key,
        severity: 'review',
        capability: 'manual_review',
        evidence: [
          {
            code: 'UNASSESSED_TEXT',
            detail: `${indeterminateObjects} text object${indeterminateObjects > 1 ? 's' : ''} not assessed (${[...reasons.entries()].map(([r, n]) => `${r}: ${n}`).join('; ')}).`,
          },
        ],
      },
      'indeterminate',
    );
  }
}

function deckLimitations(manifest: DeckManifest): string[] {
  const out = [
    'This report lists supported checks only. It is not a certification of ADA, Section 508 or WCAG compliance.',
    'Reading order is shown as the object sequence in the file; verify it in PowerPoint’s Reading Order pane.',
    'Colour contrast is assessed only where explicit colours can be resolved; everything else is reported as not assessed.',
    'Text inside pictures, colour-only meaning, equations, instructional accuracy and caption quality require human review.',
  ];
  const seen = new Set<string>();
  for (const u of manifest.unsupported) {
    const line = u.part ? `${u.detail}` : u.detail;
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

function kindLabel(obj: ObjectRecord): string {
  return { picture: 'Picture', chart: 'Chart', smartart: 'SmartArt graphic', video: 'Video', audio: 'Audio', table: 'Table', text: 'Text box', group: 'Group', unknown: 'Object' }[obj.kind];
}

function truncate(s: string, n: number): string {
  const chars = [...s];
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
}
