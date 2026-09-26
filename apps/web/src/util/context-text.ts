import { LIMITS, truncateCodePoints, type ObjectRecord, type SlideRecord } from '@ppt-remedy/contracts';

/** Bounded nearby slide text for an AI request: slide text minus the title and the object's own text. */
export function defaultContext(slide: SlideRecord, object: ObjectRecord): string {
  const lines = slide.text.split('\n').filter((l) => l.trim() && l.trim() !== slide.title.text.trim());
  const own = object.text?.trim();
  return truncateCodePoints(lines.filter((l) => l.trim() !== own).join('\n'), LIMITS.contextCodePoints);
}


/**
 * The line of shape text containing a link, with the link marked [[like this]], bounded.
 * Only this sentence (not the whole slide) is sent for link suggestions.
 */
export function linkContext(shapeText: string, linkText: string): string {
  const line = shapeText.split('\n').find((l) => l.includes(linkText)) ?? linkText;
  const marked = line.replace(linkText, `[[${linkText}]]`);
  return truncateCodePoints(marked, LIMITS.contextCodePoints);
}
