'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1].replace(/\nstart\(\);\s*$/, '\n');

function makePage(search, options = {}) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', value: '', disabled: false, setAttribute() {}, addEventListener() {}, replaceChildren() {}, classList: { add() {}, remove() {} } });
    return elements.get(id);
  };
  const stored = new Map();
  const storage = options.storage || {
    getItem(key) { return stored.has(key) ? stored.get(key) : null; },
    setItem(key, value) { stored.set(key, String(value)); },
    removeItem(key) { stored.delete(key); },
  };
  const location = { search, href: 'https://example.test/liff?authDiagnostics=DEV', reload: options.reload || (() => {}) };
  const context = vm.createContext({
    document: { getElementById: get },
    location, window: { location, sessionStorage: storage, confirm: () => true }, URLSearchParams, Set, Error, AbortController,
    setTimeout, clearTimeout, console,
  });
  vm.runInContext(script, context);
  return { context, get, storage, location };
}

test('DEV diagnostic code appears on the authentication error screen only with explicit opt-in', () => {
  const page = makePage('?authDiagnostics=DEV');
  vm.runInContext("showConnectionError('', 'AUTHENTICATION_FAILED', 'VERIFY_HTTP_ERROR', 400)", page.context);
  assert.equal(page.get('authDiagnosticCode').hidden, false);
  assert.equal(page.get('authDiagnosticCode').textContent, '診断コード：VERIFY_HTTP_ERROR');
  assert.equal(page.get('authHttpStatus').hidden, false);
  assert.equal(page.get('authHttpStatus').textContent, 'HTTPステータス：400');
  vm.runInContext("showConnectionError('', 'AUTHENTICATION_FAILED', 'VERIFY_HTTP_ERROR', '400')", page.context);
  assert.equal(page.get('authHttpStatus').hidden, true);
  vm.runInContext("showConnectionError('', 'AUTHENTICATION_FAILED', 'token-value', 400)", page.context);
  assert.equal(page.get('authDiagnosticCode').hidden, true);
  assert.equal(page.get('authHttpStatus').hidden, true);
});

test('diagnostic code stays hidden by default', () => {
  const page = makePage('');
  vm.runInContext("showConnectionError('', 'AUTHENTICATION_FAILED', 'VERIFY_HTTP_ERROR', 400)", page.context);
  assert.equal(page.get('authDiagnosticCode').hidden, true);
  assert.equal(page.get('authHttpStatus').hidden, true);
});

test('DEV trace preserves ordered stages with elapsed time and sanitized details on the error screen', () => {
  const page = makePage('?authDiagnostics=DEV');
  vm.runInContext("trace('liff_init','成功','initialized'); trace('post','失敗','token-value authorization-code'); showConnectionError()", page.context);
  const output = page.get('traceOutput').textContent;
  assert.match(output, /02  \+\d+ms  liff_init  成功  initialized/);
  assert.match(output, /03  \+\d+ms  post  失敗/);
  assert.equal(output.includes('token-value'), false);
  assert.equal(output.includes('authorization-code'), false);
  assert.doesNotMatch(script, /item\.detail/, 'server-supplied descriptions are not copied into the diagnostic panel');
  assert.equal(page.get('diagnostics').hidden, false);
  const standard = makePage('');
  vm.runInContext("trace('post','失敗','safe')", standard.context);
  assert.equal(standard.get('traceOutput').textContent, '');
});

test('authentication failure uses the existing error panel, reconnect control, and value-free diagnostics', async () => {
  const page = makePage('?authDiagnostics=DEV');
  page.get('workDate').value = '2026-11-11';
  page.context.initializeLiff = async () => {};
  page.context.liff = {
    isInClient: () => true,
    isLoggedIn: () => true,
    getIDToken: () => 'opaque-token',
    getDecodedIDToken: () => ({ exp: Math.floor(Date.now() / 1000) + 300, sub: 'sensitive-sub-value' }),
    login() { throw new Error('valid token must not trigger login'); },
  };
  page.context.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, code: 'AUTHENTICATION_FAILED', diagnosticCode: 'VERIFY_HTTP_ERROR', httpStatus: 400 }),
  });

  await page.context.start();

  assert.equal(page.get('connectionErrorHeading').textContent, '認証できませんでした');
  assert.equal(page.get('retry').hidden, false);
  assert.equal(page.get('authDiagnosticCode').textContent, '診断コード：VERIFY_HTTP_ERROR');
  assert.equal(page.get('authHttpStatus').textContent, 'HTTPステータス：400');
  assert.equal(page.get('authSubPresent').textContent, 'OK', 'only the sub presence boolean is shown');
  const visibleDiagnostics = ['authTokenReason', 'authExpiredSeconds', 'authTokenPresent', 'authAudMatches', 'authIssMatches', 'authExpValid', 'authSubPresent', 'authIatValid', 'authDiagnosticCode', 'authHttpStatus']
    .map((id) => page.get(id).textContent).join(' ');
  assert.doesNotMatch(visibleDiagnostics, /sensitive-sub-value/);
  assert.doesNotMatch(html, /id=["']lineSubId["']/);
});

test('client and actual GAS request checks show only booleans and mark missing GAS evidence unconfirmed', () => {
  const page = makePage('?authDiagnostics=DEV');
  vm.runInContext(`clientTokenDiagnostic={tokenPresent:true,audMatches:true,issMatches:true,expValid:true,subPresent:true,iatValid:false}; renderAuthDetails(null);`, page.context);
  assert.equal(page.get('authTokenPresent').textContent, 'OK');
  assert.equal(page.get('authIatValid').textContent, 'NG');
  assert.equal(page.get('verifyUrlOk').textContent, '未確認');
  vm.runInContext(`renderAuthDetails({urlOk:true,methodOk:true,contentTypeOk:false,idTokenPresent:true,idTokenTypeOk:true,clientIdPresent:true,clientIdTypeOk:true,clientIdMatchesConfiguredChannel:true,configuredChannelMatchesExpected:true});`, page.context);
  assert.equal(page.get('verifyUrlOk').textContent, 'OK');
  assert.equal(page.get('verifyContentTypeOk').textContent, 'NG');
  assert.equal(page.get('verifyIdTokenOk').textContent, 'OK');
  assert.equal(page.get('verifyClientIdMatches').textContent, 'OK');
  assert.equal(page.get('verifyConfiguredChannelMatches').textContent, 'OK');
});

test('startup blocks the GAS request for missing, invalid-expiry, and expired ID tokens', async () => {
  const cases = [
    { idToken: null, exp: Math.floor(Date.now() / 1000) + 300, reason: 'TOKEN_NOT_FOUND' },
    { idToken: 'opaque', exp: 'not-a-number', reason: 'EXP_INVALID' },
    { idToken: 'opaque', exp: Math.floor(Date.now() / 1000) - 17, reason: 'TOKEN_EXPIRED', expiredSeconds: 17 },
  ];

  for (const item of cases) {
    const page = makePage('?authDiagnostics=DEV');
    let requests = 0;
    page.context.initializeLiff = async () => {};
    page.context.liff = {
      isLoggedIn: () => true,
      getIDToken: () => item.idToken,
      getDecodedIDToken: () => ({ exp: item.exp }),
      login() { throw new Error('login should not be called'); },
    };
    page.context.fetch = async () => { requests += 1; throw new Error('unexpected GAS request'); };

    await page.context.start();

    assert.equal(requests, 0, `${item.reason} must stop before fetch`);
    assert.equal(page.get('authDetails').hidden, false);
    assert.equal(page.get('authTokenReason').textContent, item.reason);
    if (item.reason === 'TOKEN_EXPIRED') {
      const elapsed = Number.parseInt(page.get('authExpiredSeconds').textContent, 10);
      assert.ok(elapsed >= item.expiredSeconds && elapsed <= item.expiredSeconds + 1);
    } else {
      assert.equal(page.get('authExpiredSeconds').textContent, '該当なし');
    }
  }
});

test('startup continues to GAS when the ID token is within its expiry', async () => {
  const page = makePage('?authDiagnostics=DEV');
  let requests = 0;
  page.get('workDate').value = '2026-11-11';
  page.context.initializeLiff = async () => {};
  page.context.liff = {
    isLoggedIn: () => true,
    getIDToken: () => 'opaque',
    getDecodedIDToken: () => ({ exp: Math.floor(Date.now() / 1000) + 300 }),
    login() { throw new Error('login should not be called'); },
  };
  page.context.fetch = async () => { requests += 1; throw new Error('stop after confirming request'); };

  await page.context.start();

  assert.equal(requests, 1);
});

test('every GAS action is blocked before fetch when the current token has expired', async () => {
  for (const [fields, phase] of [
    [{ action: 'attendanceList', workDate: '2026-11-11' }, 'attendance'],
    [{ action: 'register', registrationCode: 'example' }, 'registration'],
    [{ action: 'shiftMutation', type: 'update', requestId: 'request-id' }, 'mutation'],
    [{ action: 'attendanceList', workDate: '2026-11-11' }, 'readback'],
  ]) {
    let reloads = 0;
    let requests = 0;
    const page = makePage('', { reload: () => { reloads += 1; } });
    page.context.liff = {
      isInClient: () => true,
      isLoggedIn: () => true,
      getIDToken: () => 'expired-token',
      getDecodedIDToken: () => ({ exp: Math.floor(Date.now() / 1000) - 5 }),
      login() { throw new Error('LIFF browser must not call login'); },
    };
    page.context.fetch = async () => { requests += 1; throw new Error('expired token reached GAS'); };

    await assert.rejects(page.context.api(fields, phase), (error) => error.code === 'AUTH_RECOVERY_NAVIGATING');
    assert.equal(requests, 0, `${phase} must not send an expired token`);
    assert.equal(reloads, 1, `${phase} attempts one LIFF-browser reload`);
  }
});

test('LIFF-browser recovery is attempted once and a failed return shows clear guidance', async () => {
  let reloads = 0;
  let requests = 0;
  const page = makePage('?authDiagnostics=DEV', { reload: () => { reloads += 1; } });
  page.context.initializeLiff = async () => {};
  page.context.liff = {
    isInClient: () => true,
    isLoggedIn: () => true,
    getIDToken: () => 'expired-token',
    getDecodedIDToken: () => ({ exp: Math.floor(Date.now() / 1000) - 5 }),
    login() { throw new Error('LIFF browser must not call login'); },
  };
  page.context.fetch = async () => { requests += 1; throw new Error('expired token reached GAS'); };

  await page.context.start();
  await page.context.start();

  assert.equal(reloads, 1);
  assert.equal(requests, 0);
  assert.equal(page.get('connectionErrorHeading').textContent, '認証を復旧できませんでした');
  assert.match(page.get('connectionErrorMessage').textContent, /LINEアプリのトークから勤怠を開き直してください/);
  assert.equal(page.get('authDetails').hidden, false, 'DEV auth diagnostics stay visible');
});

test('external-browser recovery logs out and starts one canonical login, then only reloads attendance', async () => {
  const page = makePage('?authDiagnostics=DEV');
  page.get('workDate').value = '2026-11-11';
  let exp = Math.floor(Date.now() / 1000) - 5;
  let loginCalls = 0;
  let logoutCalls = 0;
  const requests = [];
  page.context.initializeLiff = async () => {};
  page.context.liff = {
    isInClient: () => false,
    isLoggedIn: () => true,
    getIDToken: () => 'opaque-token',
    getDecodedIDToken: () => ({ exp }),
    logout() { logoutCalls += 1; },
    login(config) { loginCalls += 1; assert.equal(config.redirectUri, page.location.href); },
  };
  page.context.fetch = async (_url, init) => {
    requests.push(init.body.get('action'));
    return { ok: true, status: 200, json: async () => ({ ok: true, workDate: '2026-11-11', dateClass: 'future', actorRole: 'manager', records: [], shiftWritesEnabled: false, attendanceWritesEnabled: false }) };
  };

  await page.context.start();
  assert.equal(loginCalls, 1);
  assert.equal(logoutCalls, 1);
  assert.equal(requests.length, 0, 'no request occurs before login returns');

  exp = Math.floor(Date.now() / 1000) + 300;
  await page.context.start();
  assert.equal(loginCalls, 1, 'returning from login does not start another login');
  assert.equal(requests.length, 1);
  assert.equal(requests[0], 'attendanceList', 'recovery reloads only the attendance list');
});

test('expired save is never replayed after the login return; only attendance is requested', async () => {
  const page = makePage('');
  page.get('workDate').value = '2026-11-11';
  let exp = Math.floor(Date.now() / 1000) - 1;
  let loginCalls = 0;
  let logoutCalls = 0;
  const requests = [];
  let reloads = 0;
  page.context.crypto = { randomUUID: () => 'save-1' };
  page.context.initializeLiff = async () => {};
  page.context.liff = {
    isInClient: () => false,
    isLoggedIn: () => true,
    getIDToken: () => 'opaque-token',
    getDecodedIDToken: () => ({ exp }),
    logout() { logoutCalls += 1; },
    login() { loginCalls += 1; },
  };
  page.context.fetch = async (_url, init) => {
    requests.push(init.body.get('action'));
    return { ok: true, status: 200, json: async () => ({ ok: true, workDate: '2026-11-11', dateClass: 'future', actorRole: 'manager', records: [], shiftWritesEnabled: false, attendanceWritesEnabled: false }) };
  };
  page.location.reload = () => { reloads += 1; };
  vm.runInContext("entryState={employeeId:'EMP-1',revision:3,schedule:{startTime:'09:00',endTime:'17:00'},attendance:null}; shiftWritesEnabled=true; attendanceWritesEnabled=true; dateClass='today';", page.context);
  page.get('startTime').value = '10:00';
  page.get('endTime').value = '18:00';

  await page.context.mutateEntry('save');
  assert.deepEqual(requests, []);
  assert.equal(loginCalls, 1);
  assert.equal(logoutCalls, 1);
  assert.equal(reloads, 0);
  exp = Math.floor(Date.now() / 1000) + 300;
  await page.context.start();

  assert.equal(loginCalls, 1);
  assert.deepEqual(requests, ['attendanceList']);
});
