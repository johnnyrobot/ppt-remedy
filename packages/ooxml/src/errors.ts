/** Import/export error taxonomy for the package engine. Messages are user-facing. */
export type EngineErrorCode =
  | 'FILE_TOO_LARGE'
  | 'NOT_A_ZIP'
  | 'LEGACY_OR_ENCRYPTED'
  | 'ZIP_MALFORMED'
  | 'ZIP64_UNSUPPORTED'
  | 'MULTI_VOLUME_UNSUPPORTED'
  | 'ZIP_ENTRY_COUNT'
  | 'ZIP_PATH_UNSAFE'
  | 'ZIP_DUPLICATE_PATH'
  | 'ZIP_ENCRYPTED_ENTRY'
  | 'ZIP_UNSUPPORTED_COMPRESSION'
  | 'ZIP_EXPANDED_TOO_LARGE'
  | 'ZIP_ENTRY_TOO_LARGE'
  | 'ZIP_RATIO_EXCEEDED'
  | 'ZIP_CRC_MISMATCH'
  | 'XML_DTD_FORBIDDEN'
  | 'XML_MALFORMED'
  | 'XML_TOO_LARGE'
  | 'XML_TOO_DEEP'
  | 'XML_ENCODING'
  | 'NOT_A_PRESENTATION'
  | 'MACRO_ENABLED'
  | 'SIGNED_PACKAGE'
  | 'UNSUPPORTED_OOXML_DIALECT'
  | 'MISSING_PART'
  | 'TOO_MANY_SLIDES'
  | 'TOO_MANY_SHAPES'
  | 'SOURCE_MISMATCH'
  | 'PART_CHANGED'
  | 'PATCH_TARGET_NOT_FOUND'
  | 'PATCH_TARGET_AMBIGUOUS'
  | 'PATCH_UNSUPPORTED'
  | 'PATCH_CONFLICT'
  | 'PATCH_INVALID_VALUE'
  | 'PRESERVATION_FAILED'
  | 'VERIFICATION_FAILED'
  | 'CANCELLED';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly part: string | undefined;
  constructor(code: EngineErrorCode, message: string, part?: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.part = part;
  }
}

export function isEngineError(e: unknown): e is EngineError {
  return e instanceof EngineError;
}
