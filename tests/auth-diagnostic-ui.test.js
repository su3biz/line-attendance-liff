'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1].replace(/\nstart\(\);\s*$/, '\n');

function makePage(search) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', value: '', disabled: false, setAttribute() {}, addEventListener() {}, replaceChildren() {}, classList: { add() {}, remove() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: get },
    location: { search }, URLSearchParams, Set, Error, AbortController,
    setTimeout, clearTimeout, console,
  });
  vm.runInContext(script, context);
  return { context, get };
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
