/**
 * Proposed operating limits (spec §18). This is the single limits module shared by
 * the browser engine, the UI and the API gateway. These are application defaults,
 * not measured results or Cloudflare platform limits; raise them only with a benchmark.
 */
const MiB = 1024 * 1024;
const KiB = 1024;

export const LIMITS = {
  /** Input archive size, checked before any ZIP processing. */
  inputArchiveBytes: 25 * MiB,
  /** Total expanded bytes: directory preflight plus incremental inflation accounting. */
  expandedArchiveBytes: 150 * MiB,
  /** Any single expanded entry. */
  expandedEntryBytes: 40 * MiB,
  /** Any XML part we parse. */
  xmlPartBytes: 8 * MiB,
  xmlMaxDepth: 128,
  zipEntries: 5_000,
  /** Maximum per-entry expansion ratio. */
  expansionRatio: 200,
  /**
   * Entries smaller than this cannot meaningfully act as a bomb, so the ratio check is
   * skipped for them (a 2 KiB run of identical bytes legitimately compresses >200:1).
   */
  expansionRatioMinBytes: 64 * KiB,
  slides: 200,
  shapes: 20_000,
  rasterMegapixels: 20,
  rasterMaxDimension: 10_000,
  aiImageBytes: 1 * MiB,
  aiImageMaxSide: 1_024,
  aiImageMimeTypes: ['image/jpeg', 'image/png'] as const,
  aiMultipartBytes: 1.25 * MiB,
  aiMetadataBytes: 16 * KiB,
  slideTitleCodePoints: 200,
  contextCodePoints: 2_000,
  existingAltCodePoints: 2_000,
  modelDescriptionCodePoints: 600,
  manualDescriptionCodePoints: 2_000,
  /** Replacement link text (ADR 0004). */
  linkTextCodePoints: 120,
  /** Sanitized link destination sent to the AI (scheme + host + path only). */
  linkDestinationCodePoints: 500,
  rateLimitPerMinute: 10,
  clientQueueObjects: 20,
  clientInFlight: 1,
  gatewayDeadlineMs: 30_000,
  clientTimeoutMs: 35_000,
  modelMaxOutputTokens: 256,
  modelTemperature: 0.2,
} as const;

export type Limits = typeof LIMITS;
