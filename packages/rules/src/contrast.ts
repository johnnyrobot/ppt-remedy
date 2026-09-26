/**
 * WCAG text-contrast assessment (spec §16 CONTRAST_LOW). Channels are normalized to
 * 0–1, linearized, weighted to relative luminance, and compared as
 * (Llighter + 0.05) / (Ldarker + 0.05). The raw ratio is compared without rounding.
 */

export function relativeLuminance(hex: string): number {
  const n = parseInt(hex, 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Large text: ≥18 pt, or ≥14 pt bold. `size` is in hundredths of a point (OOXML sz). */
export function isLargeText(size: number, bold: boolean): boolean {
  return size >= 1800 || (bold && size >= 1400);
}

export type ContrastOutcome =
  | { result: 'pass' | 'fail'; ratio: number; required: number }
  | { result: 'indeterminate'; ratio?: number; reason: string };

/**
 * Assess one run. When the font size is unknown the result is still determinate if the
 * ratio clears the stricter 4.5:1 threshold or fails the looser 3:1 threshold.
 */
export function assessRun(fg: string, bg: string, size: number | undefined, bold: boolean | undefined): ContrastOutcome {
  const ratio = contrastRatio(fg, bg);
  if (size === undefined) {
    if (ratio >= 4.5) return { result: 'pass', ratio, required: 4.5 };
    if (ratio < 3) return { result: 'fail', ratio, required: 3 };
    return { result: 'indeterminate', ratio, reason: 'unknown font size' };
  }
  const required = isLargeText(size, bold ?? false) ? 3 : 4.5;
  return { result: ratio >= required ? 'pass' : 'fail', ratio, required };
}
