/**
 * Rule catalogue (spec §5, §16 "Rule definitions"). Each rule is mapped to the
 * PowerPoint Accessibility Checker category it relates to, with limitations recorded.
 */
export interface RuleDefinition {
  id: string;
  title: string;
  checkerCategory: 'Alt text' | 'Slide titles' | 'Reading order' | 'Links' | 'Tables' | 'Contrast' | 'Media' | 'Coverage';
  guidance: string;
  limitations: string[];
}

export const RULE_DEFINITIONS: RuleDefinition[] = [
  {
    id: 'IMG_MISSING_ALT',
    title: 'Missing alternative text',
    checkerCategory: 'Alt text',
    guidance: 'Describe what the visual contributes to this slide, or mark it decorative in PowerPoint if it adds nothing.',
    limitations: ['Missing metadata can be detected; whether a description is adequate needs human judgment.'],
  },
  {
    id: 'IMG_GENERIC_ALT',
    title: 'Alternative text looks generic',
    checkerCategory: 'Alt text',
    guidance: 'Replace file names, object names and auto-generated captions with a description of the content and its purpose.',
    limitations: ['Pattern-based; a short description can still be accurate. Existing text is never deleted automatically.'],
  },
  {
    id: 'IMG_COMPLEX_VISUAL',
    title: 'Complex visual needs manual description',
    checkerCategory: 'Alt text',
    guidance: 'Charts, diagrams and pictures with effects may need a longer description on the slide or in notes. Check values against source data, not pixels.',
    limitations: ['No claim is made that short alt text suffices for complex visuals.'],
  },
  {
    id: 'SLIDE_MISSING_TITLE',
    title: 'Slide has no title',
    checkerCategory: 'Slide titles',
    guidance: 'Give the slide a title using a genuine title placeholder (Home › Layout, or the Outline view). A title can be positioned off-slide if it should not be visible.',
    limitations: ['Only genuine title placeholders count; a large text box is not a title. Title editing arrives in release R1.1.'],
  },
  {
    id: 'SLIDE_DUPLICATE_TITLE',
    title: 'Duplicate slide title',
    checkerCategory: 'Slide titles',
    guidance: 'Make titles unique so people navigating by title can tell slides apart (for example, add “(continued)” or a part number).',
    limitations: ['Repeated section titles may be intentional.'],
  },
  {
    id: 'ORDER_REVIEW',
    title: 'Check reading order',
    checkerCategory: 'Reading order',
    guidance: 'Open the Reading Order pane in PowerPoint and confirm objects are read in a logical order, title first.',
    limitations: ['Shown as “Object sequence — verify in PowerPoint”. Geometry is only a hint; document order is not proof of what every client exposes.'],
  },
  {
    id: 'LINK_GENERIC_TEXT',
    title: 'Link text is not descriptive',
    checkerCategory: 'Links',
    guidance: 'Use link text that describes the destination, such as the page or document title.',
    limitations: ['Link destinations are never fetched; replacement text comes from the slide context and the address. Links in tables and grouped fields are fixed in PowerPoint.'],
  },
  {
    id: 'TABLE_HEADER_REVIEW',
    title: 'Table header row not designated',
    checkerCategory: 'Tables',
    guidance: 'If the first row contains column headings, turn on Header Row (Table Design › Table Style Options).',
    limitations: ['Only the table-level header row flag is inspected. Automatic header edits arrive in release R1.2 after assistive-technology verification.'],
  },
  {
    id: 'TABLE_COMPLEX',
    title: 'Table has merged or split cells',
    checkerCategory: 'Tables',
    guidance: 'Simplify the table structure so screen readers can relate cells to headers, or provide the data another way.',
    limitations: ['Tables are never flattened or restructured automatically.'],
  },
  {
    id: 'CONTRAST_LOW',
    title: 'Insufficient text contrast',
    checkerCategory: 'Contrast',
    guidance: 'Increase the difference between text and background colours: at least 4.5:1, or 3:1 for text ≥18 pt or ≥14 pt bold.',
    limitations: ['Only assessed where explicit sRGB text and solid background colours can be resolved; no automatic recolouring.'],
  },
  {
    id: 'CONTRAST_INDETERMINATE',
    title: 'Contrast could not be assessed',
    checkerCategory: 'Contrast',
    guidance: 'Check these text objects visually or with PowerPoint’s Accessibility Checker.',
    limitations: ['Theme colours, gradients, transparency, inherited sizes, image backgrounds and overlaps are not resolved in this release. Unassessed is not passed.'],
  },
  {
    id: 'MEDIA_CAPTION_REVIEW',
    title: 'Check captions for audio and video',
    checkerCategory: 'Media',
    guidance: 'Provide captions for video and a transcript for audio, and check caption accuracy.',
    limitations: ['Caption presence and quality are not detected; this is always a manual check.'],
  },
  {
    id: 'OBJECT_UNSUPPORTED',
    title: 'Object not assessed',
    checkerCategory: 'Coverage',
    guidance: 'Check this object manually in PowerPoint; the tool cannot assess or edit it safely.',
    limitations: ['SmartArt, OLE objects, ink, AlternateContent, duplicate shape IDs and unknown graphics are preserved but not assessed.'],
  },
];

export const RULE_BY_ID = new Map(RULE_DEFINITIONS.map((r) => [r.id, r]));
