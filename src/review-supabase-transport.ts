import type { Page, Request, Route } from 'playwright';
import { normalizeReviewTargetOrigin, normalizeSupabaseAuthOrigin } from './supabase-auth-policy.js';

/** Runtime-only authorization and transport, never serialized into an inspection spec. */
export interface ProjectSupabaseAuth {
  targetOrigin: string;
  origin: string;
  canSend: () => boolean;
  fetchProvider?: typeof fetch;
}

export function isValidProjectSupabaseAuth(policy: ProjectSupabaseAuth, targetOrigin: string): boolean {
  return normalizeReviewTargetOrigin(policy.targetOrigin) === targetOrigin &&
    policy.targetOrigin === targetOrigin && normalizeSupabaseAuthOrigin(policy.origin) === policy.origin &&
    policy.origin !== targetOrigin;
}

export function isSupabasePasswordGrant(url: URL): boolean {
  return url.pathname === '/auth/v1/token' && url.search === '?grant_type=password';
}

const providerReadPaths = new Set([
  '/functions/v1/shared-profile-get',
  '/functions/v1/gru-product-list',
  '/functions/v1/shared-product-status-counts',
  '/functions/v1/pub-category-list',
]);
const requestedHeaders = ['accept', 'apikey', 'authorization', 'content-type', 'x-client-info', 'x-supabase-api-version'];
const responseHeaders = new Set([
  'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-expose-headers', 'content-type',
]);
const responseByteLimit = 8 * 1024 * 1024;

export interface SupabaseReviewPhase {
  canSubmitPassword?: () => boolean;
  accessToken?: string;
  credentials?: { username: string; password: string };
}

type AllowedRequest = { method: 'OPTIONS' | 'POST' | 'GET' | 'HEAD'; headers: Record<string, string>; body?: string };
type PasswordResult = { outcome: 'accepted'; accessToken: string } | { outcome: 'rejected' | 'timeout' };

function matchesPasswordPayload(body: string | null, credentials: NonNullable<SupabaseReviewPhase['credentials']>) {
  if (!body || Buffer.byteLength(body) > 16_384) return false;
  try {
    const json: unknown = JSON.parse(body);
    if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
    const values = json as Record<string, unknown>;
    if (values.email !== credentials.username.trim() || values.password !== credentials.password) return false;
    if (!Object.keys(values).every(key => ['email', 'password', 'gotrue_meta_security'].includes(key))) return false;
    const metadata = values.gotrue_meta_security;
    return metadata === undefined || (!!metadata && typeof metadata === 'object' && !Array.isArray(metadata) && Object.keys(metadata).length === 0);
  } catch { return false; }
}

async function approvedRequest(
  request: Request, url: URL, page: Page, policy: ProjectSupabaseAuth, phase: SupabaseReviewPhase,
): Promise<AllowedRequest | undefined> {
  if (request.isNavigationRequest() || request.frame() !== page.mainFrame() ||
      new URL(page.url()).origin !== policy.targetOrigin || url.origin !== policy.origin || url.username || url.password) return;
  const headers = await request.allHeaders();
  if (headers.origin !== policy.targetOrigin) return;
  const method = request.method();
  const isPreflight = method === 'OPTIONS';
  const effectiveMethod = isPreflight ? headers['access-control-request-method'] : method;
  const isPassword = effectiveMethod === 'POST' && isSupabasePasswordGrant(url);
  const isRead = ['GET', 'HEAD'].includes(effectiveMethod) && providerReadPaths.has(url.pathname) &&
    ![...url.searchParams.keys()].some(key => /^(?:access_token|refresh_token|password|token)$/i.test(key));
  if (!(isPassword && phase.canSubmitPassword?.() && phase.credentials) && !(isRead && phase.accessToken)) return;

  if (isPreflight) {
    const names = headers['access-control-request-headers']?.split(',').map(name => name.trim().toLowerCase()) ?? [];
    if (!names.every(name => requestedHeaders.includes(name))) return;
    return { method, headers: {
      origin: policy.targetOrigin, 'access-control-request-method': effectiveMethod,
      ...(names.length ? { 'access-control-request-headers': names.join(', ') } : {}),
    } };
  }

  const forwarded = Object.fromEntries(requestedHeaders.flatMap(header => headers[header] ? [[header, headers[header]]] : []));
  forwarded.origin = policy.targetOrigin;
  if (method === 'POST' && phase.credentials) {
    const body = request.postData();
    if (!body || headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
        !matchesPasswordPayload(body, phase.credentials)) return;
    return { method, headers: forwarded, body };
  }
  if ((method === 'GET' || method === 'HEAD') && headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] === phase.accessToken) {
    return { method, headers: forwarded };
  }
}

function readAccessToken(body: Buffer): string | undefined {
  try {
    const token: unknown = JSON.parse(body.toString()).access_token;
    if (typeof token === 'string' && token.length <= 16_384 && /^\S+$/.test(token)) return token;
  } catch {}
}

/** Forward only a live-authorized provider request over TLS, without redirects or browser cookies. */
export async function forwardReviewSupabaseRequest(
  route: Route, url: URL, page: Page, policy: ProjectSupabaseAuth, phase: SupabaseReviewPhase,
  signal: AbortSignal, timeoutMs: number, onPasswordDispatched?: () => void, onPasswordResult?: (result: PasswordResult) => void,
): Promise<boolean> {
  const abort = async () => { await route.abort('blockedbyclient').catch(() => {}); return false; };
  let passwordRequestDeadline: AbortSignal | undefined;
  try {
    const request = route.request();
    const approved = await approvedRequest(request, url, page, policy, phase);
    if (!approved || !policy.canSend() || signal.aborted || timeoutMs <= 0) return abort();
    const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
    if (approved.method === 'POST') {
      if (!phase.canSubmitPassword?.()) return abort();
      passwordRequestDeadline = deadline;
      onPasswordDispatched?.();
    }
    const response = await (policy.fetchProvider ?? fetch)(url, {
      ...approved, redirect: 'manual',
      signal: AbortSignal.any([signal, deadline]),
    });
    if ((response.status >= 300 && response.status < 400) || !policy.canSend() || signal.aborted) {
      await response.body?.cancel().catch(() => {});
      if (passwordRequestDeadline) onPasswordResult?.({ outcome: 'rejected' });
      return abort();
    }
    const headers = Object.fromEntries([...response.headers].filter(([name]) => responseHeaders.has(name)));
    // An omitted upstream header must remain a CORS denial; Playwright otherwise injects one.
    headers['access-control-allow-origin'] ??= '';
    const reader = response.body?.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > responseByteLimit) {
          await reader.cancel().catch(() => {});
          if (passwordRequestDeadline) onPasswordResult?.({ outcome: 'rejected' });
          return abort();
        }
        chunks.push(Buffer.from(chunk.value));
      }
    }
    if (!policy.canSend() || signal.aborted) {
      if (passwordRequestDeadline) onPasswordResult?.({ outcome: 'rejected' });
      return abort();
    }
    const body = Buffer.concat(chunks);
    if (passwordRequestDeadline) {
      const token = response.ok ? readAccessToken(body) : undefined;
      onPasswordResult?.(token ? { outcome: 'accepted', accessToken: token } : { outcome: 'rejected' });
      passwordRequestDeadline = undefined;
    }
    await route.fulfill({ status: response.status, headers, body });
    return true;
  } catch {
    if (passwordRequestDeadline) onPasswordResult?.({ outcome: passwordRequestDeadline.aborted ? 'timeout' : 'rejected' });
    return abort();
  }
}
