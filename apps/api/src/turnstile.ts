/**
 * Server-side Turnstile validation (spec §20 step 3).
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 * Tokens are single-use and expire after 300 s; Siteverify rejects replays with
 * `timeout-or-duplicate`, which we surface as CHALLENGE_INVALID before any inference.
 */

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Widget actions the browser must set when rendering the challenge, per route. */
export const TURNSTILE_ACTION = 'describe_image';
export const TURNSTILE_LINK_ACTION = 'describe_link';
/** Documented maximum token length. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;
const SITEVERIFY_TIMEOUT_MS = 10_000;

export interface TurnstileRequest {
  secret: string;
  token: string;
  /** Trusted CF-Connecting-IP, when present. */
  remoteIp?: string;
  allowedHostnames: ReadonlySet<string>;
  /** Expected widget action for this route (defaults to describe_image). */
  action?: string;
  /**
   * True only for Cloudflare's dummy secrets, which resolveConfig permits solely when
   * every allowed origin is loopback. Dummy secrets accept any token, so hostname and
   * action carry no signal: the docs say they return "localhost"/"test", but a live
   * check (2026-09-24) returned `hostname: "example.com"`, no `action`, and
   * `metadata.result_with_testing_key: true`. In test mode only `success` is required.
   */
  testMode: boolean;
}

/** `invalid`: the token was rejected. `unavailable`: Siteverify could not be reached. */
export type TurnstileOutcome = 'ok' | 'invalid' | 'unavailable';

export type TurnstileVerifier = (req: TurnstileRequest) => Promise<TurnstileOutcome>;

interface SiteverifyResponse {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  metadata?: { result_with_testing_key?: unknown };
}

export const verifyTurnstile: TurnstileVerifier = async (req) => {
  const body = new URLSearchParams({ secret: req.secret, response: req.token });
  if (req.remoteIp) body.set('remoteip', req.remoteIp);

  let data: SiteverifyResponse;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return 'unavailable';
    data = (await res.json()) as SiteverifyResponse;
  } catch {
    return 'unavailable';
  }

  if (data === null || typeof data !== 'object' || data.success !== true) return 'invalid';
  const testingKeyResult = data.metadata?.result_with_testing_key === true;
  if (req.testMode) return 'ok';
  // A testing-key result can never validate a production secret's request.
  if (testingKeyResult) return 'invalid';
  if (typeof data.hostname !== 'string' || !req.allowedHostnames.has(data.hostname)) return 'invalid';
  return data.action === (req.action ?? TURNSTILE_ACTION) ? 'ok' : 'invalid';
};
