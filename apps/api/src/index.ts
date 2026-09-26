/**
 * PowerPoint Accessibility Remediator Worker (spec §15, §20). `/api/*` is routed here
 * first (`assets.run_worker_first`); everything else is served by static assets.
 * Unknown API routes return a JSON 404, never the SPA shell.
 */
import {
  API_VERSION,
  CapabilitiesSchema,
  FEATURES,
  LIMITS,
  SCHEMA_VERSION,
  type Capabilities,
} from '@ppt-remedy/contracts';
import { createMockAdapter, createWorkersAiAdapter, type ProviderAdapter } from './adapter.ts';
import { handleDescribe, type GatewayDeps } from './describe.ts';
import { handleDescribeLink } from './link.ts';
import { isAiEnabled, resolveConfig, MOCK_MODEL_LABEL, type Env, type GatewayConfig } from './env.ts';
import { errorResponse, jsonResponse } from './http.ts';
import { verifyTurnstile } from './turnstile.ts';

export type { Env } from './env.ts';

const API_PREFIX = `/api/${API_VERSION}/`;

type RouteHandler = (request: Request, env: Env, deps: GatewayDeps) => Promise<Response> | Response;
const ROUTES: Record<string, { method: string; handler: RouteHandler }> = {
  capabilities: { method: 'GET', handler: (_req, env) => capabilities(env) },
  'describe-image': { method: 'POST', handler: handleDescribe },
  'describe-link': { method: 'POST', handler: handleDescribeLink },
  health: { method: 'GET', handler: (_req, env) => health(env) },
};

export function defaultCreateAdapter(config: GatewayConfig, env: Env): ProviderAdapter {
  if (config.adapter === 'workers-ai' && config.model && env.AI) return createWorkersAiAdapter(env.AI, config.model);
  return createMockAdapter();
}

export function createHandler(overrides: Partial<GatewayDeps> = {}) {
  const deps: GatewayDeps = {
    verifyTurnstile,
    createAdapter: defaultCreateAdapter,
    deadlineMs: LIMITS.gatewayDeadlineMs,
    now: () => new Date(),
    randomUUID: () => crypto.randomUUID(),
    ...overrides,
  };

  return {
    async fetch(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

      const route = url.pathname.startsWith(API_PREFIX)
        ? Object.hasOwn(ROUTES, url.pathname.slice(API_PREFIX.length))
          ? ROUTES[url.pathname.slice(API_PREFIX.length)]
          : undefined
        : undefined;
      if (!route) return errorResponse('NOT_FOUND', deps.randomUUID());
      if (request.method !== route.method) {
        return errorResponse('METHOD_NOT_ALLOWED', deps.randomUUID(), { headers: { Allow: route.method } });
      }
      try {
        return await route.handler(request, env, deps);
      } catch {
        return errorResponse('AI_UNAVAILABLE', deps.randomUUID());
      }
    },
  };
}

/** Public configuration only: no secrets, account identifiers or model endpoints. */
function capabilities(env: Env): Response {
  const resolved = resolveConfig(env);
  const body: Capabilities = {
    schemaVersion: SCHEMA_VERSION,
    apiVersion: API_VERSION,
    promptVersion: resolved.ok ? resolved.config.promptVersion : (env.PROMPT_VERSION ?? ''),
    rulesVersion: resolved.ok ? resolved.config.rulesVersion : (env.RULES_VERSION ?? ''),
    aiEnabled: isAiEnabled(env) && resolved.ok,
    modelLabel: resolved.ok ? resolved.config.modelLabel : MOCK_MODEL_LABEL,
    ...(env.TURNSTILE_SITE_KEY ? { turnstileSiteKey: env.TURNSTILE_SITE_KEY } : {}),
    features: { ...FEATURES },
    imageMimeTypes: [...LIMITS.aiImageMimeTypes],
    limits: {
      aiImageBytes: LIMITS.aiImageBytes,
      aiImageMaxSide: LIMITS.aiImageMaxSide,
      aiMultipartBytes: LIMITS.aiMultipartBytes,
      slideTitleCodePoints: LIMITS.slideTitleCodePoints,
      contextCodePoints: LIMITS.contextCodePoints,
      existingAltCodePoints: LIMITS.existingAltCodePoints,
      rateLimitPerMinute: LIMITS.rateLimitPerMinute,
    },
  };
  return jsonResponse(CapabilitiesSchema.parse(body));
}

/** Build identity and readiness only; never runs inference. */
function health(env: Env): Response {
  return jsonResponse({ status: 'ok', build: env.BUILD_SHA ?? 'dev' });
}

export default createHandler() satisfies ExportedHandler<Env>;
