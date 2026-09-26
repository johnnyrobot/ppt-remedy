import type { Sha256 } from '@ppt-remedy/contracts';

/** Lowercase hex SHA-256 using Web Crypto (available in browsers, workers and Node 22). */
export async function sha256Hex(data: Uint8Array | string): Promise<Sha256> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}
