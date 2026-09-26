/**
 * `POST /api/v1/describe-link` (ADR 0004): propose descriptive text for one hyperlink.
 * Same §20 order as describe-image — kill switch/Origin/type/size, rate limit, Turnstile
 * (action `describe_link`), bounded body with strict schema — then one provider call with
 * a deadline and strict output validation. The destination is never fetched.
 */
import {
  LIMITS,
  LINK_PROMPT_VERSION,
  LinkSuggestionSchema,
  LinkTextRequestSchema,
  LinkTextSuccessSchema,
  SCHEMA_VERSION,
  SUPPORTED_LOCALES,
  parseStrictModelJson,
  sanitizeLinkDestination,
  type LinkTextRequest,
  type LinkTextSuccess,
} from '@ppt-remedy/contracts';
import { readBoundedBody } from './body.ts';
import { authorizeAiRequest, withDeadline, type GatewayDeps } from './describe.ts';
import type { Env } from './env.ts';
import { HttpError, errorResponse, jsonResponse } from './http.ts';
import { buildLinkPrompt } from './prompt.ts';
import { TURNSTILE_LINK_ACTION } from './turnstile.ts';

export async function handleDescribeLink(request: Request, env: Env, deps: GatewayDeps): Promise<Response> {
  const ctx = { requestId: deps.randomUUID() };
  try {
    return await describeLink(request, env, deps, ctx);
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.code, ctx.requestId, error.options);
    return errorResponse('AI_UNAVAILABLE', ctx.requestId);
  }
}

async function describeLink(request: Request, env: Env, deps: GatewayDeps, ctx: { requestId: string }): Promise<Response> {
  const { config } = await authorizeAiRequest(request, env, deps, {
    mediaType: 'application/json',
    maxBytes: LIMITS.aiMetadataBytes,
    action: TURNSTILE_LINK_ACTION,
  });

  const bytes = await readBoundedBody(request, LIMITS.aiMetadataBytes);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError('INVALID_REQUEST', { message: 'The request body is not valid JSON.', field: 'body' });
  }
  if (json !== null && typeof json === 'object' && 'requestId' in json) {
    const id = LinkTextRequestSchema.shape.requestId.safeParse(json.requestId);
    if (id.success) ctx.requestId = id.data;
  }
  const parsed = LinkTextRequestSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const first = issue?.code === 'unrecognized_keys' ? undefined : issue?.path[0];
    throw new HttpError('INVALID_REQUEST', { message: 'The request is not valid.', field: typeof first === 'string' ? first : 'body' });
  }
  const req: LinkTextRequest = parsed.data;
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(req.locale)) throw new HttpError('UNSUPPORTED_LOCALE', { field: 'locale' });
  if (req.promptVersion !== LINK_PROMPT_VERSION) {
    throw new HttpError('INVALID_REQUEST', { message: 'The prompt version is not current. Reload the application.', field: 'promptVersion' });
  }
  // Defence in depth: the browser already strips query/fragment; enforce it here too.
  const destination = sanitizeLinkDestination(req.destination);
  if (!destination) throw new HttpError('INVALID_REQUEST', { message: 'Only web (http/https) destinations are supported.', field: 'destination' });

  const adapter = deps.createAdapter(config, env);
  if (!adapter.completeText) throw new HttpError('AI_UNAVAILABLE');
  const complete = adapter.completeText.bind(adapter);
  const prompt = buildLinkPrompt({ ...req, destination });
  const raw = await withDeadline((signal) => complete({ prompt, data: { linkText: req.linkText, destination, contextText: req.contextText }, signal }), deps);

  const out = parseStrictModelJson(raw);
  const suggestion = out === null ? undefined : LinkSuggestionSchema.safeParse(out);
  if (!suggestion?.success) throw new HttpError('AI_OUTPUT_INVALID');

  const body: LinkTextSuccess = {
    schemaVersion: SCHEMA_VERSION,
    requestId: ctx.requestId,
    // Only when the model says it can infer neither the destination nor the context.
    status: suggestion.data.warnings.includes('DESTINATION_UNCLEAR') && suggestion.data.warnings.includes('CONTEXT_INSUFFICIENT') ? 'needs_manual_review' : 'suggested',
    suggestion: suggestion.data,
    model: config.modelLabel,
    promptVersion: LINK_PROMPT_VERSION,
  };
  return jsonResponse(LinkTextSuccessSchema.parse(body));
}
