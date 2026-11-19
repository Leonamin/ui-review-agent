import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { closeBrowserLeases } from '../src/browser-lease.js';
import { inspect } from '../src/core.js';
import { canUseReviewCredentials, getAuthenticatedReviewState, ReviewAuthenticationError, ReviewLoginRequired } from '../src/review-auth.js';
import type { RunSpec } from '../src/types.js';

async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function spec(targetUrl: string): RunSpec {
  return {
    targetUrl, mode: 'quick', purpose: 'Synthetic authenticated review fixture',
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    allowedActions: [], allowedOrigins: [new URL(targetUrl).origin],
    hasMutationPermission: false, isHeaded: false, shouldWaitForLogin: false,
    limits: { maxDurationMs: 25_000, maxObservations: 2, maxActions: 0, maxToolCalls: 12, maxFindings: 5 },
    evaluator: 'rules-only',
  };
}

test('review credentials require HTTPS outside loopback and reject URL-embedded values', () => {
  for (const url of ['https://staging.example.test/admin', 'http://127.0.0.1:3000', 'http://localhost:4000', 'http://[::1]']) {
    assert.equal(canUseReviewCredentials(url), true);
  }
  for (const url of ['http://staging.example.test/admin', 'https://user:pass@staging.example.test/', 'ftp://localhost', 'invalid']) {
    assert.equal(canUseReviewCredentials(url), false);
  }
});

test('redirected guest login waits before capture and explicit guest review captures the same login page', async t => {
  let protectedLoads = 0;
  const loginForm = '<main><h1>Sign in to continue</h1><form method="post">' +
    '<label>Email <input type="email" autocomplete="username"></label>' +
    '<label>Password <input type="password" autocomplete="current-password"></label>' +
    '<button type="submit">Sign in</button></form></main>';
  const app = await listen((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const route = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (route === '/products') {
      res.end('<main><h1>Loading products</h1></main><script>setTimeout(() => location.replace("/auth?continue=opaque-fixture"), 700)</script>');
    } else if (route === '/auth') {
      res.end(loginForm);
    } else if (route === '/protected') {
      protectedLoads++;
      res.writeHead(302, {location: '/auth'}).end();
    } else if (route === '/passwordless') {
      res.writeHead(302, {location: '/challenge'}).end();
    } else if (route === '/challenge') {
      res.end('<main><h1>Verify your sign in</h1><form method="post"><label>One-time code <input autocomplete="one-time-code"></label><button>Verify</button></form></main>');
    } else if (route === '/login') {
      res.writeHead(302, {location: '/auth'}).end();
    } else if (route === '/catalog') {
      res.writeHead(302, {location: '/catalog/'}).end();
    } else {
      res.end('<main><h1>Public product catalog</h1><a href="/auth">Sign in</a></main>');
    }
  });
  const output = await mkdtemp(join(tmpdir(), 'ui-review-login-redirect-'));
  t.after(async () => {
    await closeBrowserLeases();
    app.server.close();
    await rm(output, {recursive: true, force: true});
  });
  const target = app.url + '/products';
  const loginUrl = app.url + '/auth';
  await assert.rejects(inspect(spec(target), output, {shouldDetectRedirectedLogin: true}), error => {
    assert(error instanceof ReviewLoginRequired);
    assert.equal(error.loginUrl, loginUrl);
    assert.deepEqual(error.methods, ['password']);
    return true;
  });
  await assert.rejects(inspect(spec(app.url + '/passwordless'), output, {shouldDetectRedirectedLogin: true}), error => {
    assert(error instanceof ReviewLoginRequired);
    assert.equal(error.loginUrl, app.url + '/challenge');
    assert.deepEqual(error.methods, ['code']);
    return true;
  });
  assert.deepEqual(await readdir(output), []);
  await assert.rejects(inspect(spec(target), output, {expectedRedirectedLoginUrl: app.url + '/old-auth'}), error => {
    assert(error instanceof ReviewAuthenticationError);
    assert.equal(error.code, 'redirect-changed');
    return true;
  });
  assert.deepEqual(await readdir(output), []);

  const guest = await inspect(spec(target), output, {expectedRedirectedLoginUrl: loginUrl});
  assert.equal(guest.result.targetUrl, target);
  assert.equal(guest.result.observations[0]?.url, loginUrl);
  assert.ok(guest.result.observations[0]?.screenshotRefs.length);

  const direct = await inspect(spec(app.url + '/login'), output, {shouldDetectRedirectedLogin: true});
  assert.equal(direct.result.observations[0]?.url, loginUrl);
  const publicReview = await inspect(spec(app.url + '/catalog'), output, {shouldDetectRedirectedLogin: true});
  assert.equal(publicReview.result.observations[0]?.url, app.url + '/catalog/');

  const previousSpec = {...spec(app.url + '/protected'), workspaceId: 'redirect-fixture-workspace'};
  const legacy = await inspect(previousSpec, output);
  assert.equal(legacy.result.observations[0]?.url, loginUrl);
  await assert.rejects(inspect({...previousSpec, followup: {
    requestId: 'redirect-fixture-followup', workspaceId: previousSpec.workspaceId, instruction: 'Inspect the product list',
    maxOptions: 1, source: {reportId: 'a'.repeat(64), reportSha256: 'b'.repeat(64), runId: legacy.result.runId},
  }}, output, {shouldDetectRedirectedLogin: true}), ReviewLoginRequired);
  assert.equal(protectedLoads, 1, 'a retained guest context is checked without opening the page again');
});

test('login choice remains bound to the captured document and ignores optional public login panels', async t => {
  const form = '<form><label>Email <input type="email" autocomplete="username"></label>' +
    '<label>Password <input type="password" autocomplete="current-password"></label><button>Sign in</button></form>';
  let shouldLeaveLogin=false;
  let notifyPublicReached!:()=>void;
  const publicReached=new Promise<void>(resolve=>{notifyPublicReached=resolve;});
  const app=await listen((req,res)=>{
    res.setHeader('content-type','text/html; charset=utf-8');
    const path=new URL(req.url??'/','http://localhost').pathname;
    switch(path){
      case '/brief-gate':res.writeHead(302,{location:'/auth-short'}).end();return;
      case '/auth-short':res.end('<main><h1>Sign in</h1>'+form+'</main><script>setTimeout(()=>location.replace("/catalog"),250)</script>');return;
      case '/late-gate':res.end('<main><h1>Product gateway</h1></main><script>setTimeout(()=>location.replace("/auth"),1850)</script>');return;
      case '/auth':res.end('<main><h1>Welcome to the account portal</h1><article>Account feature preview</article>'+form+'</main>');return;
      case '/review-gate':res.writeHead(302,{location:'/auth-review'}).end();return;
      case '/auth-review':res.end('<main><h1>Sign in</h1>'+form+'</main><script>setInterval(async()=>{if(await(await fetch("/leave-login")).json())location.replace("/catalog-after-review")},50)</script>');return;
      case '/leave-login':res.setHeader('content-type','application/json');res.end(JSON.stringify(shouldLeaveLogin));return;
      case '/catalog-after-review':notifyPublicReached();res.end('<main><h1>Different catalog</h1></main>');return;
      case '/optional':res.writeHead(302,{location:'/landing'}).end();return;
      case '/optional-inline':res.writeHead(302,{location:'/landing-inline'}).end();return;
      case '/landing':res.end('<main><h1>Public catalog</h1><ul><li>Products</li></ul></main><aside>'+form+'</aside>');return;
      case '/landing-inline':res.end('<main><section><h1>Public catalog</h1><ul><li>Products</li></ul></section><div><h2>Sign in for order history</h2>'+form+'</div></main>');return;
      default:res.end('<main><h1>Public catalog</h1></main>');
    }
  });
  const output=await mkdtemp(join(tmpdir(),'ui-review-login-capture-guard-'));
  t.after(async()=>{app.server.close();await rm(output,{recursive:true,force:true});});
  const evaluate:NonNullable<Parameters<typeof inspect>[2]>['evaluate']=async()=>{
    throw new Error('No model call is expected before a login choice or after a mismatched capture');
  };
  const isChanged=(error:unknown)=>error instanceof ReviewAuthenticationError&&error.code==='redirect-changed';
  await assert.rejects(inspect(spec(app.url+'/brief-gate'),output,{expectedRedirectedLoginUrl:app.url+'/auth-short',evaluate}),isChanged);
  await assert.rejects(inspect(spec(app.url+'/late-gate'),output,{shouldDetectRedirectedLogin:true,evaluate}),error=>
    error instanceof ReviewLoginRequired&&error.loginUrl===app.url+'/auth');
  assert.deepEqual(await readdir(output),[]);

  let evaluationCalls=0;
  await assert.rejects(inspect(spec(app.url+'/review-gate'),output,{
    expectedRedirectedLoginUrl:app.url+'/auth-review',
    evaluate:async input=>{
      evaluationCalls++;
      assert.equal(input.observations.at(-1)?.url,app.url+'/auth-review');
      shouldLeaveLogin=true;
      await publicReached;
      return {status:'partial',findings:[],screenMap:[],interpretations:[],limitations:[],
        observationRequests:[{type:'capture',observationId:input.observations.at(-1)!.observationId,reason:'Verify the same login page'}]};
    },
  }),isChanged);
  assert.equal(evaluationCalls,1);
  assert.deepEqual(await readdir(output),[]);

  for (const [path,landing] of [['/optional','/landing'],['/optional-inline','/landing-inline']]){
    const {result}=await inspect(spec(app.url+path),output,{shouldDetectRedirectedLogin:true});
    assert.equal(result.observations[0]?.url,app.url+landing);
  }
});

test('Chromium authenticates through only the approved Supabase password endpoint and returns to the requested product view', async t => {
  // The OAuth grant name is structural even when a synthetic password has the same text.
  const credentials = { method: 'password', username: 'fixture@example.test', password: 'password' } as const;
  const targetOrigin = 'https://review-app.example.test';
  const provider = 'https://approved-fixture.supabase.co';
  const tokenPath = '/auth/v1/token?grant_type=password';
  const profilePath = '/functions/v1/shared-profile-get';
  const requests: string[] = [];
  const forwarded: string[] = [];
  const pageScript = [
    "const form = document.querySelector('form');",
    "form.addEventListener('submit', async event => {",
    "  event.preventDefault();",
    "  const body = JSON.stringify({email: form.email.value, password: form.password.value, gotrue_meta_security: {}});",
    "  const options = {method:'POST', headers:{'content-type':'application/json','apikey':'fixture-publishable-key'},body};",
    "  fetch('/unexpected-same-origin-submit', options).catch(()=>{});",
    "  fetch('/auth', options).catch(()=>{});",
    "  fetch('" + provider + "/auth/v1/token?grant_type=refresh_token', options).catch(()=>{});",
    "  fetch('https://wrong-fixture.supabase.co" + tokenPath + "', options).catch(()=>{});",
    "  const responses = await Promise.allSettled([fetch('" + provider + tokenPath + "', options), fetch('" + provider + tokenPath + "', options)]);",
    "  const login = responses.find(result=>result.status==='fulfilled'&&result.value.ok);",
    "  if (!login) return;",
    "  const token = (await login.value.json()).access_token;",
    "  const headers = {authorization:'Bearer '+token};",
    "  fetch('" + provider + "/functions/v1/unapproved-read', {headers}).catch(()=>{});",
    "  fetch('" + provider + profilePath + "', {headers:{authorization:'Bearer other-token'}}).catch(()=>{});",
    "  const profile = await fetch('" + provider + profilePath + "', {headers});",
    "  if (!profile.ok) return;",
    "  document.cookie = 'fixture-session=authorized; Secure; Path=/';",
    "  location.replace('/home');",
    "});",
  ].join('\n');
  const app = await listen((req, res) => {
    requests.push((req.method ?? '') + ' ' + req.url);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/products' && !req.headers.cookie?.includes('fixture-session=authorized')) {
      res.end("<script>setTimeout(() => location.replace('/auth'), 80)</script>");
    } else if (req.url === '/auth' && req.method === 'GET') {
      res.end('<form><label>Email <input name="email" type="email" autocomplete="email"></label>' +
        '<label>Password <input type="password" name="password" autocomplete="current-password"></label>' +
        '<button type="submit">로그인</button></form><script>' + pageScript + '</script>');
    } else if (req.url === '/products') {
      setTimeout(() => res.end('<h1>상품 목록</h1><article>운영 검증 상품</article>'), 250);
    } else {
      res.end('<h1>Workspace home</h1>');
    }
  });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); app.server.close(); });
  // Keep Chromium's real virtual HTTPS origin/CORS, while sending fixture documents to a local server.
  // The production transport still decides whether requests pass and the provider host is never queried.
  const fixtureBrowser: Browser = Object.create(browser);
  fixtureBrowser.newContext = async options => {
    const context = await browser.newContext(options);
    const install = context.route.bind(context);
    context.route = (match, handle, routeOptions) => install(match, route => handle(new Proxy(route, {
      get(instance, key) {
        if (key === 'fetch') return async (requestOptions: Parameters<typeof route.fetch>[0]) => {
          const request = route.request();
          const url = new URL(request.url());
          assert.equal(url.origin, targetOrigin);
          return route.fetch({ ...requestOptions, url: app.url + url.pathname + url.search, headers: await request.allHeaders() });
        };
        const value = Reflect.get(instance, key, instance);
        return typeof value === 'function' ? value.bind(instance) : value;
      },
    }), route.request()), routeOptions);
    return context;
  };
  let hasDeniedPreflight = false;
  let hasRedirectedPassword = false;
  let hasSlowPassword = true;
  let hasMissingProfile = false;
  let hasTimedOutPassword = false;
  const fetchProvider: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? '';
    const headers = new Headers(init?.headers);
    assert.equal(url.origin, provider);
    assert.equal(init?.redirect, 'manual');
    assert.equal(headers.get('origin'), targetOrigin);
    assert.equal(headers.has('cookie'), false);
    forwarded.push(method + ' ' + url.pathname + url.search);
    if (method === 'OPTIONS') {
      assert.equal(headers.has('authorization'), false);
      assert.equal(headers.has('apikey'), false);
      const options = new Headers({
        'access-control-allow-origin': hasDeniedPreflight ? 'https://other.example.test' : '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'apikey, authorization, content-type',
      });
      return new Response(null, { status: 204, headers: options });
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, { email: credentials.username, password: credentials.password, gotrue_meta_security: {} });
      if (hasRedirectedPassword) return new Response(null, { status: 307, headers: { location: 'https://wrong.example.test/redirected' } });
      if (hasTimedOutPassword) await new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      if (hasSlowPassword) await new Promise(resolve => setTimeout(resolve, 4_650));
      return Response.json({ access_token: 'fixture-token' }, { headers: { 'access-control-allow-origin': '*' } });
    }
    assert.equal(headers.get('authorization'), 'Bearer fixture-token');
    if (hasMissingProfile) return Response.json({ success: false }, { status: 403, headers: { 'access-control-allow-origin': '*' } });
    await new Promise(resolve => setTimeout(resolve, 165));
    return Response.json({ success: true }, { headers: { 'access-control-allow-origin': '*' } });
  };
  const target = targetOrigin + '/products';
  const authenticate = (timeoutMs = 10_000) => getAuthenticatedReviewState(
    fixtureBrowser, target, credentials, { width: 800, height: 600 }, () => timeoutMs, AbortSignal.timeout(15_000),
    { targetOrigin, origin: provider, canSend: () => true, fetchProvider },
  );
  const result = await authenticate();
  assert.equal(result.targetUrl, target);
  assert(result.storageState.cookies.some(cookie => cookie.name === 'fixture-session' && cookie.domain === 'review-app.example.test'));
  assert.deepEqual(requests, ['GET /products', 'GET /auth', 'GET /home', 'GET /products']);
  assert.deepEqual(forwarded.filter(request => !request.startsWith('OPTIONS ')), ['POST ' + tokenPath, 'GET ' + profilePath]);
  assert(forwarded.includes('OPTIONS ' + tokenPath));
  assert(forwarded.includes('OPTIONS ' + profilePath));

  hasSlowPassword = false;
  forwarded.length = 0;
  hasDeniedPreflight = true;
  await assert.rejects(authenticate(), { name: 'ReviewAuthenticationError', code: 'provider-unreached' });
  assert(forwarded.includes('OPTIONS ' + tokenPath));
  assert(forwarded.every(request => request.startsWith('OPTIONS ')), 'denied server preflight must prevent password dispatch');

  forwarded.length = 0;
  hasDeniedPreflight = false;
  hasRedirectedPassword = true;
  await assert.rejects(authenticate(), { name: 'ReviewAuthenticationError', code: 'provider-rejected' });
  assert.deepEqual(forwarded.filter(request => request.startsWith('POST ')), ['POST ' + tokenPath]);

  hasRedirectedPassword = false;
  hasMissingProfile = true;
  await assert.rejects(authenticate(2_500), { name: 'ReviewAuthenticationError', code: 'provider-continuation' });

  hasMissingProfile = false;
  hasTimedOutPassword = true;
  forwarded.length = 0;
  await assert.rejects(authenticate(2_500), { name: 'ReviewAuthenticationError', code: 'provider-timeout' });
  assert.deepEqual(forwarded.filter(request => request.startsWith('POST ')), ['POST ' + tokenPath]);
});

test('real browser logs in with a same-origin password form or single code and captures only the protected target', async t => {
  const username = 'review-user-fixture';
  const password = 'sensitive-pass-fixture<&>';
  const code = '390284';
  const wrongCode = '718954';
  const requests: { method?: string; url?: string; body: string }[] = [];
  const outsideRequests: string[] = [];
  const other = await listen((req, res) => {
    outsideRequests.push(req.url ?? '');
    res.end('unexpected request');
  });
  const fixture = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({ method: req.method, url: req.url, body });
      const path = new URL(req.url ?? '/', 'http://fixture.test').pathname;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (path.startsWith('/protected/')) {
        const mode = path.slice('/protected/'.length);
        if (req.headers.cookie?.split('; ').includes(`review-session=${mode}`)) {
          res.end(`<h1>Protected review target</h1>${mode === 'echo' ? `<p>${code}</p>` : ''}
            <script>
              fetch("/unrelated-write",{method:"POST",body:"should-be-blocked"}).catch(()=>{});
              fetch("${other.url}/different-port").catch(()=>{});
              fetch("/session-redirect").catch(()=>{});
            </script>`);
        } else {
          res.writeHead(302, { location: `/login/${mode}` }).end();
        }
        return;
      }
      if (req.method === 'GET' && path.startsWith('/login/')) {
        const mode = path.slice('/login/'.length);
        const action = mode === 'foreign-form' ? `${other.url}/never-submit` : path;
        const fields = mode === 'password'
          ? '<label>Login ID <input name="username" autocomplete="username"></label><label>Password <input type="password" name="password" autocomplete="current-password"></label>'
          : '<label>인증 코드 <input name="code" inputmode="numeric"></label>';
        res.end(`<form method="post" action="${action}">${fields}<button type="submit" disabled>Sign in</button></form>
          <script>document.querySelector('form').addEventListener('input', event => {
            event.currentTarget.querySelector('button').disabled = false;
            if(event.target.name !== 'username') fetch('/trace?value='+encodeURIComponent(event.target.value)).catch(()=>{});
          });${mode === 'ajax-code' ? `document.querySelector('form').addEventListener('submit', event => {
            event.preventDefault();
            const code = event.target.elements.code.value;
            fetch('/api/auth/sign-in', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({code}) });
          });` : ''}</script>`);
        return;
      }
      if (req.method === 'POST' && path === '/api/auth/sign-in') {
        if (JSON.parse(body).code !== code) { res.writeHead(401).end(); return; }
        res.writeHead(204, { 'set-cookie': 'review-session=ajax-code; HttpOnly; Path=/' }).end();
        return;
      }
      if (path === '/next-hop') {
        res.writeHead(302, { location: `${other.url}/never-forward` }).end();
        return;
      }
      if (path === '/session-redirect') {
        res.writeHead(302, { location: `${other.url}/different-port-via-redirect` }).end();
        return;
      }
      if (req.method === 'POST' && path.startsWith('/login/')) {
        const mode = path.slice('/login/'.length);
        const data = new URLSearchParams(body);
        const isValid = mode === 'password'
          ? data.get('username') === username && data.get('password') === password
          : data.get('code') === code;
        if (!isValid) { res.writeHead(401).end('Invalid credential'); return; }
        if (mode === 'foreign-redirect') {
          res.writeHead(303, { location: '/next-hop' }).end();
          return;
        }
        if (mode === 'repeat-post') {
          res.writeHead(307, { location: '/unrelated-write' }).end();
          return;
        }
        res.writeHead(303, {
          location: `/protected/${mode}`,
          'set-cookie': `review-session=${mode}; HttpOnly; SameSite=Lax; Path=/`,
        }).end();
        return;
      }
      res.writeHead(404).end();
    });
  });
  const output = await mkdtemp(join(tmpdir(), 'review-auth-'));
  t.after(async () => {
    fixture.server.close();
    other.server.close();
    await rm(output, { recursive: true, force: true });
  });

  for (const mode of ['password', 'code', 'ajax-code'] as const) {
    const targetUrl = `${fixture.url}/protected/${mode}`;
    const { result, runDir } = await inspect(spec(targetUrl), output, {
      credentials: mode === 'password' ? { method: 'password', username, password } : { method: 'code', code },
    });
    assert.equal(result.observations[0].url, targetUrl);
    assert.match(result.observations[0].accessibilitySnapshot, /Protected review target/);
    const saved = (await Promise.all(['manifest.json', 'report.json', 'report.md'].map(file => readFile(join(runDir, file), 'utf8')))).join('\n');
    for (const value of [username, password, code, 'review-session=']) assert(!saved.includes(value));
  }
  const completedDirs = await readdir(output);

  for (const [mode, value] of [['code', wrongCode], ['foreign-form', code], ['foreign-redirect', code], ['repeat-post', code], ['echo', code]] as const) {
    await assert.rejects(inspect(spec(`${fixture.url}/protected/${mode}`), output, {
      credentials: { method: 'code', code: value },
    }), error => error instanceof ReviewAuthenticationError && !error.message.includes(value));
  }
  assert.deepEqual(await readdir(output), completedDirs, 'failed login must not create a report directory');
  assert.equal(outsideRequests.length, 0, 'foreign form actions, redirects and different-port requests must not receive browser requests');
  assert(!requests.some(request => request.url?.startsWith('/trace?')), 'typed credentials must not reach query strings');
  assert(!requests.some(request => request.url === '/unrelated-write'), 'read-only policy must remain active after login');
  assert.deepEqual(requests.filter(request => request.method === 'POST').map(request => request.url),
    ['/login/password', '/login/code', '/api/auth/sign-in', '/login/code', '/login/foreign-redirect', '/login/repeat-post', '/login/echo']);
});
