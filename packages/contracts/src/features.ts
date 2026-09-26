/**
 * Edit feature flags (spec §16 "Supported changes by release"). Each flag stays off
 * until its validation gate passes with PowerPoint-authored fixtures; a flag must not
 * be enabled to satisfy a ticket. Disabled features still expose manual-review guidance.
 */
export const FEATURES = {
  /** ALT-01: picture description (R1). */
  pictureDescription: true,
  /** LINK-01: replace non-descriptive link text (ADR 0004). */
  linkText: true,
  /** DEC-01: decorative toggle. Disabled until Office-authored true/false fixtures pass. */
  decorativeToggle: false,
  /** TITLE-01: edit an existing single-paragraph genuine title (R1.1). */
  titleEditExisting: false,
  /** TITLE-02: insert a genuine off-slide title placeholder (R1.1). */
  titleInsert: false,
  /** TABLE-01: first-row header designation (R1.2). */
  tableFirstRowHeader: false,
  /** ORDER-01: restricted reading-order edit (R1.2). */
  readingOrderEdit: false,
} as const;

export type FeatureName = keyof typeof FEATURES;

/** Gate identifiers used in reports and UI explanations. */
export const FEATURE_GATES: Record<FeatureName, string> = {
  pictureDescription: 'ALT-01',
  linkText: 'LINK-01',
  decorativeToggle: 'DEC-01',
  titleEditExisting: 'TITLE-01',
  titleInsert: 'TITLE-02',
  tableFirstRowHeader: 'TABLE-01',
  readingOrderEdit: 'ORDER-01',
};
