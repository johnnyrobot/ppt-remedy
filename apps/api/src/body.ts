/**
 * Bounded body reading and multipart part extraction (spec §15 "Description request",
 * §18 "AI multipart body", §20 step 4). The body is streamed with a hard byte ceiling;
 * Content-Length is only used as an early rejection hint, never trusted. Multipart
 * parsing happens only on the already-bounded bytes.
 */
import { LIMITS } from '@ppt-remedy/contracts';
import { HttpError } from './http.ts';

/**
 * Read at most `limit` bytes from the request stream. Works for chunked bodies and
 * bodies whose Content-Length lies; stops reading as soon as the ceiling is crossed.
 */
export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) throw new HttpError('INVALID_REQUEST', { message: 'The request body is empty.' });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // Stop consuming the stream; the rest of the upload is discarded.
        reader.cancel().catch(() => {});
        throw new HttpError('PAYLOAD_TOO_LARGE');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError('INVALID_REQUEST', { message: 'The request body could not be read.' });
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface DescribeParts {
  image: { bytes: Uint8Array; declaredType: string };
  metadataText: string;
}

const ALLOWED_PARTS = new Set(['image', 'metadata']);

/**
 * Parse bounded multipart bytes and enforce exactly one `image` part and one
 * `metadata` part. Duplicate, unknown or missing parts are INVALID_REQUEST.
 */
export async function parseDescribeParts(bytes: Uint8Array, contentType: string): Promise<DescribeParts> {
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new HttpError('INVALID_REQUEST', { message: 'The multipart body could not be parsed.' });
  }

  const counts = new Map<string, number>();
  for (const [name] of form.entries()) {
    if (!ALLOWED_PARTS.has(name)) {
      throw new HttpError('INVALID_REQUEST', { message: 'The request contains an unexpected part.' });
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const name of ALLOWED_PARTS) {
    const n = counts.get(name) ?? 0;
    if (n !== 1) {
      throw new HttpError('INVALID_REQUEST', {
        message: n === 0 ? `The "${name}" part is missing.` : `The "${name}" part must appear exactly once.`,
        field: name,
      });
    }
  }

  const image = form.get('image');
  if (image === null || typeof image === 'string') {
    throw new HttpError('INVALID_REQUEST', { message: 'The "image" part must be a file.', field: 'image' });
  }
  // Check the declared size before buffering the file contents.
  if (image.size > LIMITS.aiImageBytes) throw new HttpError('IMAGE_LIMIT_EXCEEDED', { field: 'image' });

  const metadata = form.get('metadata');
  let metadataText: string;
  if (typeof metadata === 'string') {
    metadataText = metadata;
  } else if (metadata !== null) {
    const type = mediaType(metadata.type);
    if (type !== '' && type !== 'application/json') {
      throw new HttpError('INVALID_REQUEST', { message: 'The "metadata" part must be JSON.', field: 'metadata' });
    }
    if (metadata.size > LIMITS.aiMetadataBytes) {
      throw new HttpError('INVALID_REQUEST', { message: 'The metadata is too large.', field: 'metadata' });
    }
    metadataText = await metadata.text();
  } else {
    throw new HttpError('INVALID_REQUEST', { field: 'metadata' });
  }

  return {
    image: { bytes: new Uint8Array(await image.arrayBuffer()), declaredType: mediaType(image.type) },
    metadataText,
  };
}

/** Lower-cased media type without parameters. */
export function mediaType(value: string | null | undefined): string {
  return (value ?? '').split(';')[0]!.trim().toLowerCase();
}
