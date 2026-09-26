import type { Finding, FindingState, ObjectRecord } from '@ppt-remedy/contracts';

export const SEVERITY_LABEL: Record<Finding['severity'], string> = { error: 'Error', warning: 'Warning', review: 'Needs review' };
/** Text symbols accompany (never replace) severity words, so status is not colour-only. */
export const SEVERITY_ICON: Record<Finding['severity'], string> = { error: '✖', warning: '▲', review: '●' };

export const STATE_LABEL: Record<FindingState, string> = {
  open: 'Open',
  suggested: 'Draft ready',
  approved: 'Approved',
  applied: 'Applied',
  rechecked: 'Applied and rechecked',
  dismissed: 'Dismissed',
  deferred: 'Deferred',
  failed: 'Failed',
};

export const CAPABILITY_LABEL: Record<Finding['capability'], string> = {
  automatic: 'Fixed automatically',
  approval_required: 'Can be fixed here',
  manual_review: 'Fix in PowerPoint',
};

export function objectLabel(o: ObjectRecord): string {
  const kind = { picture: 'Picture', chart: 'Chart', smartart: 'SmartArt', video: 'Video', audio: 'Audio', table: 'Table', text: 'Text', group: 'Group', unknown: 'Object' }[o.kind];
  return o.name ? `${o.name}` : `${kind} ${o.shapeId}`;
}

export function kindLabel(o: ObjectRecord): string {
  return { picture: 'Picture', chart: 'Chart', smartart: 'SmartArt', video: 'Video', audio: 'Audio', table: 'Table', text: 'Text', group: 'Group', unknown: 'Other object' }[o.kind];
}
