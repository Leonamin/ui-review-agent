import type { Browser, BrowserContext, ElementHandle, Page, Request, Route } from 'playwright';
import { canUseReviewCredentials, type ReviewCredentials } from './review-credentials.js';
import { forwardReviewSupabaseRequest, isSupabasePasswordGrant, isValidProjectSupabaseAuth, type ProjectSupabaseAuth } from './review-supabase-transport.js';
export { canUseReviewCredentials, type ReviewCredentials } from './review-credentials.js';
export type { ProjectSupabaseAuth } from './review-supabase-transport.js';

type AuthenticationFailure = 'destination' | 'form' | 'rejected' | 'target' | 'redirect-changed' |
  'provider-unreached' | 'provider-rejected' | 'provider-timeout' | 'provider-continuation';
const failureMessages: Record<AuthenticationFailure, string> = {
  destination: '로그인 정보는 HTTPS 대상 또는 로컬호스트에만 사용할 수 있습니다.',
  form: '지원되는 로그인 입력란과 제출 버튼을 하나로 확인하지 못했습니다.',
  rejected: '로그인에 실패했습니다. 로그인 정보를 확인하거나 로그인 없이 검토해 주세요.',
  target: '로그인 후 검토 대상 화면에 접근했는지 확인할 수 없습니다.',
  'redirect-changed': '선택한 로그인 화면을 다시 열지 못했습니다. 현재 URL로 새 검토를 시작해 주세요.',
  'provider-unreached': '허용된 Supabase 인증 요청이 시작되지 않았습니다. 로그인 입력 형식과 인증 출처를 확인해 주세요.',
  'provider-rejected': 'Supabase 인증 응답에서 로그인 세션을 받지 못했습니다. 로그인 정보와 계정 상태를 확인해 주세요.',
  'provider-timeout': 'Supabase 인증 응답을 기다리다 시간이 초과되었습니다.',
  'provider-continuation': 'Supabase 인증 뒤 로그인 화면을 벗어나지 못했습니다. 프로필 설정과 계정 권한을 확인해 주세요.',
};

export class ReviewAuthenticationError extends Error {
  constructor(readonly code: AuthenticationFailure) {
    super(failureMessages[code]);
    this.name = 'ReviewAuthenticationError';
  }
}

export class ReviewLoginRequired extends Error {
  constructor(readonly loginUrl: string, readonly methods: Array<ReviewCredentials['method']>) {
    super('요청한 화면을 열려면 로그인이 필요합니다.');
    this.name = 'ReviewLoginRequired';
  }
}

interface LoginSelection {
  username?: HTMLInputElement;
  secret: HTMLInputElement;
  submit: HTMLButtonElement | HTMLInputElement;
  action: string;
}

/** Runs in the top-level document. Return a single, semantically recognizable form. */
function readLoginSelection(method: string): LoginSelection | undefined {
  const loginText = /\b(?:log[\s_-]?in|sign[\s_-]?in)\b|로그인/i;
  const signupText = /\b(?:sign[\s_-]?up|register|create[\s_-]+account|reset[\s_-]+password)\b|가입|비밀번호\s*(?:변경|재설정)/i;
  const usernameText = /^(?:user(?:[\s_-]?name|[\s_-]?id)?|login(?:[\s_-]?id)?|email(?:[\s_-]?address)?|account(?:[\s_-]?id)?|id|아이디|이메일|계정)$/i;
  const codeText = /\b(?:(?:one[\s_-]?time|verification|security|login|access|auth(?:entication)?)\s*[\s_-](?:passcode|password|code|token)|otp|token|passcode)\b|일회용|인증\s*(?:번호|코드)|접근\s*코드/i;
  const codeSubmitText = /\b(?:verify|confirm|continue|submit)\b|인증|확인|계속/i;
  const authContext = /\b(?:log[\s_-]?in|sign[\s_-]?in|authentication|auth|verify)\b|로그인|인증/i;
  const explicitCode = /\b(?:one[\s_-]?time|otp|verification)\b|일회용|인증\s*(?:번호|코드)/i;
  const control = {
    isVisible(element: HTMLElement) {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility === 'visible' &&
        !element.closest('[inert],[aria-hidden="true"]');
    },
    labels(element: HTMLInputElement | HTMLButtonElement) {
      return [
        element.getAttribute('aria-label'),
        ...(element.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent) ?? []),
        ...Array.from(element.labels ?? [], label => label.textContent),
        element.name, element.id,
        element instanceof HTMLInputElement ? element.placeholder : element.textContent,
        ...(element instanceof HTMLInputElement && element.type === 'submit' ? [element.value] : []),
      ].flatMap(value => value?.trim() ? [value.trim()] : []);
    },
    tokens(input: HTMLInputElement) { return input.autocomplete.toLowerCase().split(/\s+/); },
  };
  const selections: LoginSelection[] = [];

  for (const form of document.forms) {
    const controls = Array.from(form.elements);
    const fields = controls.filter((element): element is HTMLInputElement => element instanceof HTMLInputElement &&
      ['text', 'email', 'tel', 'number', 'password'].includes(element.type) && !element.readOnly &&
      !element.matches(':disabled,[aria-disabled="true"]') && control.isVisible(element));
    const submitters = controls.filter((element): element is HTMLButtonElement | HTMLInputElement =>
      (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) &&
      (element.type === 'submit' || (element.type === 'button' && control.labels(element).some(label => loginText.test(label) || (method === 'code' && codeSubmitText.test(label))))) &&
      !control.labels(element).some(label => signupText.test(label)) && control.isVisible(element));
    const explicit = submitters.filter(element => control.labels(element).some(label => loginText.test(label)));
    const submit = (explicit.length === 1 ? explicit : submitters.length === 1 ? submitters : [])[0];
    if (!submit) continue;
    const target = submit.getAttribute('formtarget') ?? form.getAttribute('target');
    if (target && target.toLowerCase() !== '_self') continue;
    if ((submit.getAttribute('formmethod') ?? form.method).toLowerCase() === 'dialog') continue;
    const action = submit.hasAttribute('formaction') ? submit.formAction : form.action;
    const formLabels = [form.id, form.name, form.getAttribute('aria-label') ?? '', ...control.labels(submit)];
    if (formLabels.some(label => signupText.test(label))) continue;
    const purpose = [...formLabels, location.pathname, new URL(action, location.href).pathname];

    if (method === 'code') {
      const standard = fields.filter(input => control.tokens(input).includes('one-time-code'));
      const codes = standard.length ? standard : fields.filter(input => {
        const names = control.labels(input);
        return names.some(label => codeText.test(label)) &&
          (purpose.some(label => authContext.test(label)) || names.some(label => explicitCode.test(label)));
      });
      if (codes.length === 1 && fields.length === 1) selections.push({ secret: codes[0], submit, action });
      continue;
    }

    if (fields.some(input => control.tokens(input).includes('new-password') || control.tokens(input).includes('one-time-code'))) continue;
    const standard = fields.filter(input => control.tokens(input).includes('current-password'));
    const passwords = fields.filter(input => input.type === 'password' || standard.includes(input));
    if (passwords.length !== 1 || (!standard.length && !purpose.some(label => loginText.test(label)))) continue;
    if (control.labels(passwords[0]).some(label => signupText.test(label) || /confirm|repeat|new[\s_-]+password|비밀번호\s*확인/i.test(label))) continue;
    const possibleUsernames = fields.filter(input => input !== passwords[0] && ['email', 'tel', 'text', 'number'].includes(input.type));
    const standardUsernames = possibleUsernames.filter(input => control.tokens(input).includes('username'));
    const namedUsernames = possibleUsernames.filter(input => control.labels(input).some(label => usernameText.test(label)));
    const usernames = standardUsernames.length ? standardUsernames : namedUsernames.length ? namedUsernames : possibleUsernames;
    if (usernames.length === 1) selections.push({ username: usernames[0], secret: passwords[0], submit, action });
  }
  return selections.length === 1 ? selections[0] : undefined;
}

function expectedOrigin(raw: string, origin: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.origin === origin) return url;
  } catch {}
}

export function canDetectReviewLoginRedirect(targetUrl: string): boolean {
  if (!canUseReviewCredentials(targetUrl)) return false;
  // A URL explicitly naming a login route can be the screen the user wants to inspect.
  return !/(?:^|\/)(?:log[-_]?in|sign[-_]?in|auth)(?:\/|$)/i.test(new URL(targetUrl).pathname);
}

export async function readRedirectedReviewLogin(page: Page, target: URL): Promise<ReviewLoginRequired | undefined> {
  const visited = expectedOrigin(page.url(), target.origin);
  const normalizePath = (path: string) => path.replace(/\/+$/, '') || '/';
  if (!visited || normalizePath(visited.pathname) === normalizePath(target.pathname)) return;

  const methods: ReviewLoginRequired['methods'] = [];
  for (const method of ['password', 'code'] as const) {
    const selection = await page.evaluateHandle(readLoginSelection, method);
    try {
      const candidate = await selection.evaluate(match => {
        const control = {
          isVisible(element: Element) {
            return element.checkVisibility({opacityProperty: true, visibilityProperty: true}) &&
              !element.closest('[inert],[aria-hidden="true"]');
          },
        };
        if (!match || ![match.username, match.secret, match.submit].every(element =>
          !element || control.isVisible(element))) return;
        const form = match.submit.form;
        if (!form) return;
        // A storefront can offer an optional login beside a fully accessible main region.
        const hasSeparateMainContent = Array.from(document.querySelectorAll('main,[role="main"]')).some(main =>
          !main.contains(form) && !form.contains(main) && control.isVisible(main) && Boolean(main.textContent?.trim()));
        if (hasSeparateMainContent) return;
        const authLabel = /\b(?:log[\s_-]?in|sign[\s_-]?in|auth(?:entication)?|verify|verification|one[\s_-]?time|otp|passcode|access denied)\b|로그인|인증|접근\s*제한/i;
        const main = form.closest('main,[role="main"]') ?? document.body;
        const headings = Array.from(main.querySelectorAll('h1,h2,[role="heading"]')).filter(heading =>
          !heading.closest('header,nav,aside,footer,[role="complementary"]') && control.isVisible(heading));
        const primaryHeading = headings.find(heading => heading.matches('h1,[aria-level="1"]')) ?? headings[0];
        const hasLoginHeading = Boolean(primaryHeading && authLabel.test(primaryHeading.textContent ?? ''));
        const isLoginPath = authLabel.test(location.pathname);
        const hasIndependentContent = Array.from(main.querySelectorAll('article,table,[role="article"],[role="grid"],[role="table"]')).some(section =>
          !section.contains(form) && !form.contains(section) && control.isVisible(section) && Boolean(section.textContent?.trim()));
        if (!isLoginPath) {
          const hasPublicContent = Array.from(main.querySelectorAll('section,ul,ol,[role="list"]')).some(section =>
            !section.contains(form) && !form.contains(section) && !section.closest('header,nav,aside,footer') &&
            control.isVisible(section) && Boolean(section.textContent?.trim()) && !authLabel.test(section.textContent ?? ''));
          if (hasIndependentContent || hasPublicContent || (!hasLoginHeading &&
              (primaryHeading || form.closest('header,nav,aside,footer,[role="complementary"]')))) return;
        }
        return {action: match.action, documentUrl: match.submit.ownerDocument.URL};
      });
      if (candidate?.documentUrl === visited.href && expectedOrigin(candidate.action, target.origin)) methods.push(method);
    } finally {
      await selection.dispose().catch(() => {});
    }
  }
  if (methods.length && page.url() === visited.href) return new ReviewLoginRequired(visited.origin + visited.pathname, methods);
}

function credentialValues(credentials: ReviewCredentials): string[] {
  return credentials.method === 'password' ? [credentials.username, credentials.password] : [credentials.code];
}

function urlContainsCredential(url: URL, values: string[]): boolean {
  let parts = url.pathname.split('/');
  try {
    parts = parts.map(part => decodeURIComponent(part));
  } catch {}
  return [...parts, ...url.searchParams.values(), url.hash.slice(1)].some(part =>
    values.some(value => value && (part === value || (value.length > 3 && part.includes(value)))));
}

function hasLoginPayload(request: Request, values: string[]): boolean {
  try {
    if ((request.postDataBuffer()?.length ?? 0) > 65_536) return false;
    const body = request.postDataJSON() as unknown;
    const contains = (node: unknown, value: string, depth: number): boolean => {
      if (typeof node === 'string' || typeof node === 'number') return String(node) === value;
      return depth < 8 && node !== null && typeof node === 'object' &&
        Object.values(node).some(child => contains(child, value, depth + 1));
    };
    return values.every(value => contains(body, value, 0));
  } catch {
    return false;
  }
}

function isLoginEndpoint(url: URL): boolean {
  return /(?:^|\/)(?:sign[-_]?in|log[-_]?in|authenticate|verify[-_]?(?:otp|code))(?:\/|$)/i.test(url.pathname);
}

function isSameLoginAction(url: URL, action: URL): boolean {
  return url.pathname === action.pathname && url.search === action.search;
}

function isInterruptedNavigation(error: unknown): boolean {
  return error instanceof Error && /net::ERR_ABORTED\b|is interrupted by another navigation/.test(error.message);
}

function reviewStorageForOrigin(state: Awaited<ReturnType<BrowserContext['storageState']>>, origin: string) {
  const { hostname } = new URL(origin);
  const cookies = state.cookies.filter(cookie => cookie.domain === hostname ||
    (cookie.domain.startsWith('.') && (hostname === cookie.domain.slice(1) || hostname.endsWith(cookie.domain))));
  return {
    cookies: cookies.map(cookie => ({ ...cookie, domain: hostname })),
    origins: state.origins.filter(entry => entry.origin === origin),
  };
}

/** Use a temporary context so the login document and its listeners never reach capture or the evaluator. */
export async function getAuthenticatedReviewState(
  browser: Browser,
  targetUrl: string,
  credentials: ReviewCredentials,
  viewport: { width: number; height: number },
  remainingMs: () => number,
  signal: AbortSignal,
  projectSupabaseAuth?: ProjectSupabaseAuth,
) {
  if (!canUseReviewCredentials(targetUrl)) throw new ReviewAuthenticationError('destination');
  const origin = new URL(targetUrl).origin;
  const supabase = credentials.method === 'password' ? projectSupabaseAuth : undefined;
  if (supabase && (!isValidProjectSupabaseAuth(supabase, origin) || !supabase.canSend())) {
    throw new ReviewAuthenticationError('destination');
  }
  const timeout = () => {
    const time = Math.min(10_000, remainingMs());
    if (time <= 0 || signal.aborted) throw new ReviewAuthenticationError('rejected');
    return time;
  };
  const values = credentialValues(credentials);
  let stage: AuthenticationFailure = 'rejected';
  const { assertNativePreflightPatch, NATIVE_SUPABASE_REVIEW_CORS_CONTEXT } = supabase ? await import('./post-host-policy.js') : {};
  await assertNativePreflightPatch?.(undefined, NATIVE_SUPABASE_REVIEW_CORS_CONTEXT);
  const context = await browser.newContext({
    viewport, serviceWorkers: 'block', acceptDownloads: false,
    ...(supabase && { baseURL: NATIVE_SUPABASE_REVIEW_CORS_CONTEXT }),
  });
  const onAbort = () => { void context.close().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    timeout();
    const page = await context.newPage();
    context.on('page', openedPage => { if (openedPage !== page) void openedPage.close().catch(() => {}); });
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    await context.routeWebSocket('**/*', socket => { socket.close(); });
    let action: URL | undefined;
    let hasProvidedCredential = false;
    let hasSubmitted = false;
    let accessToken: string | undefined;
    const submission: { outcome: 'pending' | 'accepted' | 'rejected' | 'timeout'; redirect?: URL; providerDeadline?: number } = { outcome: 'pending' };
    const navigation: { redirect?: URL } = {};

    const handleAuthRequest = async (route: Route) => {
      const request = route.request();
      const providerDestination = supabase && expectedOrigin(request.url(), supabase.origin);
      if (supabase && providerDestination) {
        if (hasProvidedCredential && !isSupabasePasswordGrant(providerDestination) && urlContainsCredential(providerDestination, values)) {
          return route.abort('blockedbyclient');
        }
        await forwardReviewSupabaseRequest(route, providerDestination, page, supabase, {
          canSubmitPassword: () => Boolean(action) && !hasSubmitted,
          accessToken,
          credentials: credentials.method === 'password' ? credentials : undefined,
        }, signal, timeout(), () => {
          hasSubmitted = true;
          submission.providerDeadline = Date.now() + Math.min(10_000, remainingMs());
          stage = 'provider-timeout';
        }, result => {
          if (result.outcome === 'accepted') accessToken = result.accessToken;
          submission.outcome = result.outcome;
          stage = result.outcome === 'accepted' ? 'provider-continuation' :
            result.outcome === 'timeout' ? 'provider-timeout' : 'provider-rejected';
        });
        return;
      }
      const destination = expectedOrigin(request.url(), origin);
      if (!destination || (hasProvidedCredential && urlContainsCredential(destination, supabase ? values : [values.at(-1)!]))) {
        return route.abort('blockedbyclient');
      }
      if (supabase && hasProvidedCredential) {
        const headers = Object.values(await request.allHeaders());
        if (headers.some(header => values.some(value => header === value || (value.length > 3 && header.includes(value)) ||
          header.match(/^Bearer (.+)$/i)?.[1] === value))) return route.abort('blockedbyclient');
      }
      const method = request.method();
      const isTopNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
      if (method === 'POST') {
        if (supabase || !action || hasSubmitted || request.frame() !== page.mainFrame() || !hasLoginPayload(request, values) ||
          !(isSameLoginAction(destination, action) ||
            (['fetch', 'xhr'].includes(request.resourceType()) && isLoginEndpoint(destination)))) {
          return route.abort('blockedbyclient');
        }
        hasSubmitted = true;
      } else if (!['GET', 'HEAD'].includes(method)) {
        return route.abort('blockedbyclient');
      }
      // Handling each redirect ourselves also prevents Chromium from bypassing the route on later hops.
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: timeout() });
      try {
        const status = response.status();
        const headers = response.headers();
        const isRedirect = status >= 300 && status < 400 && status !== 304;
        const redirect = isRedirect && headers.location ? expectedOrigin(new URL(headers.location, destination).href, origin) : undefined;
        const isBlockedResponse = Boolean(headers.refresh) || Boolean(isRedirect && (!isTopNavigation || !redirect ||
          (hasProvidedCredential && urlContainsCredential(redirect, [values.at(-1)!])) || (method === 'POST' && [307, 308].includes(status))));
        if (isBlockedResponse) {
          if (method === 'POST') submission.outcome = 'rejected';
          return await route.abort('blockedbyclient');
        }
        if (redirect) {
          if (method === 'POST') submission.redirect = redirect;
          else navigation.redirect = redirect;
          await route.fulfill({ status: 200, contentType: 'text/html', body: '' });
        } else {
          await route.fulfill({ response });
        }
        if (method === 'POST') submission.outcome = status >= 200 && status < 400 ? 'accepted' : 'rejected';
      } finally {
        await response.dispose().catch(() => {});
      }
    };
    await context.route('**/*', async route => {
      try { await handleAuthRequest(route); }
      catch { await route.abort('blockedbyclient').catch(() => {}); }
    });

    const navigate = async (url: string, waitUntil: 'domcontentloaded' | 'load') => {
      for (let count = 0; count < 6; count++) {
        navigation.redirect = undefined;
        const response = await page.goto(url, { waitUntil, timeout: timeout() });
        const redirect = navigation.redirect as URL | undefined;
        if (!redirect) return response;
        url = redirect.href;
      }
      throw new ReviewAuthenticationError('target');
    };
    await navigate(targetUrl, 'domcontentloaded');
    stage = 'form';
    const selection = await page.waitForFunction(readLoginSelection, credentials.method, {
      timeout: Math.min(6500, timeout()), polling: 150,
    });
    // A protected Next.js page can initially respond 200 and redirect only after the document starts.
    // Use the URL of the document that actually supplied the selected login form.
    const formDocument = await selection.evaluate(match => match && ({
      action: match.action, url: match.submit.ownerDocument.URL,
    }));
    const loginUrl = formDocument && expectedOrigin(formDocument.url, origin);
    const selectedAction = formDocument?.action;
    const selectedDestination = selectedAction ? expectedOrigin(selectedAction, origin) : undefined;
    if (!selectedDestination || !loginUrl || page.url() !== loginUrl.href) throw new ReviewAuthenticationError('form');
    const field = async <T extends Element>(key: keyof LoginSelection) => {
      const handle = (await selection.getProperty(key)).asElement() as ElementHandle<T> | null;
      if (!handle) throw new ReviewAuthenticationError('form');
      return handle;
    };
    // Keep the POST gate closed until the submission click. Typing must not authorize other mutations.
    hasProvidedCredential = true;
    if (credentials.method === 'password') await (await field<HTMLInputElement>('username')).fill(credentials.username, { timeout: timeout() });
    await (await field<HTMLInputElement>('secret')).fill(values.at(-1)!, { timeout: timeout() });
    if (!expectedOrigin(page.url(), origin)) throw new ReviewAuthenticationError('form');
    const submit = await field<HTMLButtonElement | HTMLInputElement>('submit');
    const currentAction = await submit.evaluate(element => element.hasAttribute('formaction') ? element.formAction : element.form?.action);
    if (currentAction !== selectedDestination.href) throw new ReviewAuthenticationError('form');
    stage = supabase ? 'provider-unreached' : 'rejected';
    action = selectedDestination;
    await submit.click({ timeout: timeout() });
    const submissionDeadline = Date.now() + Math.min(4500, timeout());
    while (submission.outcome === 'pending' && Date.now() < (submission.providerDeadline ?? submissionDeadline)) {
      await page.waitForTimeout(75);
    }
    if (submission.outcome !== 'accepted') throw new ReviewAuthenticationError(stage);
    if (submission.redirect) await navigate(submission.redirect.href, 'load');
    if (supabase) {
      // Supabase's browser SDK saves the session, then the app checks profile access and leaves the login page.
      // Let this finish before revisiting the protected URL so guest/profile-setup gates are respected.
      await page.waitForURL(url => url.origin === origin && url.pathname !== loginUrl.pathname &&
        !/^\/profile\/setup\/?$/.test(url.pathname), { waitUntil: 'load', timeout: timeout() });
    } else {
      // Client handlers may update storage/cookies after an XHR completes.
      await page.waitForLoadState('load', { timeout: timeout() });
      await page.waitForTimeout(Math.min(350, timeout()));
    }
    stage = 'target';
    let targetResponse: Awaited<ReturnType<typeof navigate>>;
    try {
      targetResponse = await navigate(targetUrl, 'load');
    } catch (error) {
      // The application's post-login client navigation can overlap the review's first target GET.
      // Repeat only the original GET, once, on the same approved site. Never re-submit credentials.
      if (!supabase || signal.aborted || page.isClosed() || !expectedOrigin(page.url(), origin) || !isInterruptedNavigation(error)) throw error;
      targetResponse = await navigate(targetUrl, 'load');
    }
    await assertAuthenticatedReviewTarget(page, targetUrl, credentials, targetResponse);
    return { storageState: reviewStorageForOrigin(await context.storageState(), origin), targetUrl: page.url(), accessToken };
  } catch (error) {
    if (error instanceof ReviewAuthenticationError) throw error;
    throw new ReviewAuthenticationError(stage);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await context.close().catch(() => {});
  }
}

export async function assertAuthenticatedReviewTarget(
  page: Page,
  targetUrl: string,
  credentials: ReviewCredentials,
  response: { ok(): boolean } | null,
): Promise<void> {
  try {
    const target = new URL(targetUrl);
    const current = expectedOrigin(page.url(), target.origin);
    const withoutTrailingSlash = (path: string) => path.replace(/\/+$/, '') || '/';
    if (!response?.ok() || !current || withoutTrailingSlash(current.pathname) !== withoutTrailingSlash(target.pathname) ||
      current.hash !== target.hash || current.search !== target.search || urlContainsCredential(current, [credentialValues(credentials).at(-1)!])) {
      throw new ReviewAuthenticationError('target');
    }
    if (await page.evaluate(readLoginSelection, 'password') || await page.evaluate(readLoginSelection, 'code')) {
      throw new ReviewAuthenticationError('target');
    }
    await assertReviewCredentialIsHidden(page, credentialValues(credentials).at(-1)!);
  } catch {
    throw new ReviewAuthenticationError('target');
  }
}

export async function assertReviewCredentialIsHidden(page: Page, secret: string): Promise<void> {
  try {
    const url = new URL(page.url());
    const text = (await page.title()) + '\n' + (await page.locator('body').innerText({ timeout: 1500 }));
    const hasEcho = secret.length > 3 ? text.includes(secret) : text.split(/\s+/).includes(secret);
    if (urlContainsCredential(url, [secret]) || hasEcho) throw new ReviewAuthenticationError('target');
  } catch {
    throw new ReviewAuthenticationError('target');
  }
}
