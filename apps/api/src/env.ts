/**
 * Worker bindings and variables (spec §20 "Deployment configuration") and the
 * resolution of that raw configuration into a validated gateway configuration.
 * Everything here comes from the operator's deployment, never from the request.
 */
import { PROMPT_VERSION, RULES_VERSION } from '@ppt-remedy/contracts';
import { isKnownPromptVersion } from './prompt.ts';
import { resolveModel, type AllowlistedModel } from './adapter.ts';

export interface Env {
  /** Workers AI binding. Only used by the `workers-ai` adapter. */
  AI?: Ai;
  /** Static asset binding for the frontend build. */
  ASSETS: Fetcher;
  /** Regional IP rate limiter (10 requests / 60 s, see wrangler.jsonc). */
  AI_RATE_LIMITER: RateLimit;
  /** Worker secret; set with `wrangler secret put` or `.dev.vars`. Never in wrangler.jsonc. */
  TURNSTILE_SECRET?: string;
  /** Public Turnstile widget site key, exposed through capabilities. */
  TURNSTILE_SITE_KEY?: string;
  /** Operator kill switch; only the exact string "true" enables AI. */
  AI_ENABLED?: string;
  /** 'mock' (default) or 'workers-ai'. */
  AI_ADAPTER?: string;
  /** Model ID; must be on the in-code allowlist. */
  AI_MODEL?: string;
  /** Comma-separated exact origins, e.g. "https://ppt-remedy.example.workers.dev". */
  ALLOWED_ORIGINS?: string;
  BUILD_SHA?: string;
  PROMPT_VERSION?: string;
  RULES_VERSION?: string;
}

export type AdapterKind = 'mock' | 'workers-ai';

/**
 * Cloudflare's documented Turnstile dummy secret keys
 * (https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
 * They are only acceptable when every allowed origin is a loopback origin.
 */
export const TURNSTILE_TEST_SECRETS = new Set([
  '1x0000000000000000000000000000000AA', // always passes
  '2x0000000000000000000000000000000AA', // always fails
  '3x0000000000000000000000000000000AA', // yields a "token already spent" error
]);

export interface GatewayConfig {
  allowedOrigins: string[];
  /** Hostnames of the allowed origins, compared with Turnstile's `hostname`. */
  allowedHostnames: Set<string>;
  promptVersion: string;
  rulesVersion: string;
  buildSha: string;
  adapter: AdapterKind;
  /** Resolved model for `workers-ai`; undefined for `mock`. */
  model?: AllowlistedModel;
  /** Public label returned in responses and capabilities. */
  modelLabel: string;
  turnstileSecret?: string;
  turnstileTestMode: boolean;
}

export type ConfigResult = { ok: true; config: GatewayConfig } | { ok: false; reason: string };

export const MOCK_MODEL_LABEL = 'mock-synthetic-v1';

/** Parse `ALLOWED_ORIGINS` into exact, normalized origins. Invalid entries are dropped. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const value = part.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      // Only accept a bare origin; a path, query or credentials indicates a typo.
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value.replace(/\/$/, '')) {
        out.push(url.origin);
      }
    } catch {
      // ignore malformed entries
    }
  }
  return out;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Resolve and sanity-check configuration. A failure here is an operator error and
 * is reported to callers as a generic AI_UNAVAILABLE without detail; the gateway fails
 * closed rather than, e.g., skipping Turnstile when the secret is missing.
 */
export function resolveConfig(env: Env): ConfigResult {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const allowedHostnames = new Set(allowedOrigins.map((o) => new URL(o).hostname));
  const promptVersion = env.PROMPT_VERSION ?? PROMPT_VERSION;
  const base = {
    allowedOrigins,
    allowedHostnames,
    promptVersion,
    rulesVersion: env.RULES_VERSION ?? RULES_VERSION,
    buildSha: env.BUILD_SHA ?? 'dev',
    turnstileSecret: env.TURNSTILE_SECRET || undefined,
    turnstileTestMode: env.TURNSTILE_SECRET !== undefined && TURNSTILE_TEST_SECRETS.has(env.TURNSTILE_SECRET),
  };

  const kind = env.AI_ADAPTER ?? 'mock';
  let config: GatewayConfig;
  if (kind === 'mock') {
    config = { ...base, adapter: 'mock', modelLabel: MOCK_MODEL_LABEL };
  } else if (kind === 'workers-ai') {
    const model = resolveModel(env.AI_MODEL);
    if (!model) return { ok: false, reason: 'AI_MODEL is not allowlisted' };
    config = { ...base, adapter: 'workers-ai', model, modelLabel: model.label };
  } else {
    return { ok: false, reason: 'AI_ADAPTER is not recognised' };
  }

  if (!isKnownPromptVersion(promptVersion)) return { ok: false, reason: 'PROMPT_VERSION has no template' };
  if (allowedOrigins.length === 0) return { ok: false, reason: 'ALLOWED_ORIGINS is empty' };
  if (!config.turnstileSecret) return { ok: false, reason: 'TURNSTILE_SECRET is not set' };
  if (config.turnstileTestMode && ![...allowedHostnames].every(isLoopbackHost)) {
    // Dummy secrets accept any token; never allow them on a public origin.
    return { ok: false, reason: 'Turnstile test secret used with a non-loopback origin' };
  }
  if (config.adapter === 'workers-ai' && !env.AI) return { ok: false, reason: 'AI binding missing' };
  return { ok: true, config };
}

/** Only the exact string "true" enables AI; anything else (including unset) disables it. */
export function isAiEnabled(env: Env): boolean {
  return env.AI_ENABLED === 'true';
}
