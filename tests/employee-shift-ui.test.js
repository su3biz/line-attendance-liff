'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const match = html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(match, 'inline LIFF script exists');

function element() {
  return {
    value: '', textContent: '', type: '', required: false, disabled: false, hidden: false,
    children: [], handlers: {}, attributes: {}, dataset: {}, className: '', blurCount: 0, classList: { add() {}, remove() {} },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    blur() { this.blurCount++; },
    querySelectorAll(selector) { const found=[];const visit=node=>{for(const child of node.children||[]){if(matches(child,selector))found.push(child);visit(child);}};visit(this);return found; },
    querySelector(selector) { return this.querySelectorAll(selector)[0]||null; },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}
function matches(node,selector){if(selector==='p')return node.tagName==='p';if(selector==='.times')return node.className==='times';if(selector==='[data-manager-card]')return !!node.dataset&&node.dataset.managerCard==='true';const m=selector.match(/^\[data-([a-z-]+)\]$/);return !!m&&!!node.dataset&&node.dataset[m[1].replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]!==undefined;}

function selectValues(select) { return select.children.map((option) => option.value); }
function quarterHourValues() { return Array.from({ length: 96 }, (_unused, index) => `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`); }

function makePage({ initialState, confirm = true, mutationFailure = null, requestFailure = null, approveFailure = null, rejectFailure = null, responseWorkDate = null, dateClass = 'future', actorRole = 'employee', disabledActions = [], shiftWritesEnabled = true, attendanceWritesEnabled = true, attendanceRecords = [], diagnosticMode = false, initialRequests = [], duplicateRequest = false } = {}) {
  const elements = new Map();
  const requests = [];
  const employeeRequests = initialRequests.map((request) => ({ ...request }));
  const confirmMessages = [];
  const stored = new Map();
  let id = 0;
  const get = (name) => {
    if (!elements.has(name)) elements.set(name, element());
    return elements.get(name);
  };
  const nextState = { stateToken: 'a'.repeat(64), ...initialState };
  const currentRecords = attendanceRecords.map((record) => ({ ...record, schedule: record.schedule && { ...record.schedule }, attendance: record.attendance && { ...record.attendance } }));
  const location = { href: diagnosticMode ? 'https://example.test/liff?debug=1' : 'https://example.test/liff', search: diagnosticMode ? '?debug=1' : '', reload() {} };
  const context = vm.createContext({
    document: {
      visibilityState: 'visible', handlers: {},
      getElementById: get,
      createElement: (tagName) => Object.assign(element(), { tagName }),
      createTextNode: (textContent) => ({ textContent }),
      addEventListener(name, handler) { this.handlers[name] = handler; },
    },
    window: {
      confirm(message) { confirmMessages.push(message); return confirm; },
      location,
      sessionStorage: {
        getItem(key) { return stored.has(key) ? stored.get(key) : null; },
        setItem(key, value) { stored.set(key, String(value)); },
        removeItem(key) { stored.delete(key); },
      },
    },
    location, URL, URLSearchParams, Error, AbortController, Set, Intl, Date,
    setTimeout, clearTimeout,
    crypto: { randomUUID: () => `request-${String(++id).padStart(4, '0')}`, getRandomValues: (bytes) => { bytes.set([1,2,3,4,5,6]); return bytes; } },
    liff: {
      isLoggedIn: () => true,
      isInClient: () => true,
      getIDToken: () => 'test-line-id-token',
      getDecodedIDToken: () => ({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      init: async () => {}, login() { throw new Error('valid-token fixture must not log in'); }, logout() {},
    },
    fetch: async (_url, options) => {
      const fields = Object.fromEntries(new URLSearchParams(options.body).entries());
      requests.push(fields);
      if (fields.action === 'shiftMutation') {
        if (disabledActions.includes('shiftMutation')) return { ok: true, json: async () => ({ ok: false, code: 'DISABLED' }) };
        if (mutationFailure === 'before') throw new Error('simulated request failure');
        const updated = actorRole === 'manager' ? currentRecords.find((record) => record.targetActorId === fields.employeeId) : nextState;
        updated.revision = fields.type === 'create' && !updated.schedule && Number(fields.expectedRevision) === 0
          ? 0
          : Number(fields.expectedRevision) + 1;
        updated.stateToken = 'b'.repeat(64);
        updated.schedule = fields.type === 'delete' ? null : { startTime: fields.startTime, endTime: fields.endTime };
        if (fields.type === 'delete') updated.attendance = null;
        else if (dateClass !== 'future') updated.attendance = { startTime: fields.startTime, endTime: fields.endTime };
        if (mutationFailure === 'after-switch') get('workDate').value = '2026-10-06';
        if (mutationFailure === 'after' || mutationFailure === 'after-switch') throw new Error('simulated lost response');
        if (mutationFailure === 'outcome-unknown') return { ok: true, json: async () => ({ ok: false, code: 'OUTCOME_UNKNOWN', diagnosticCode: 'post_state_mismatch', performance: { requestId: fields.requestId, timingsMs: { totalMs: 25 } } }) };
        return { ok: true, json: async () => ({ ok: true, code: 'SAVED', employeeId: fields.employeeId, workDate: fields.workDate,
          schedule: updated.schedule, attendance: updated.attendance, revision: updated.revision, attendanceUpdated: dateClass !== 'future',
          performance: { requestId: fields.requestId, timingsMs: { totalMs: 12, scriptLockWaitMs: 2 }, nested: { readbackMs: 'included in finalStateCheckMs' } } }) };
      }
      if (fields.action === 'register') {
        if (disabledActions.includes('register')) return { ok: true, json: async () => ({ ok: false, code: 'DISABLED' }) };
        throw new Error('unexpected register action');
      }
      if (fields.action === 'requestList') { const rows=actorRole==='manager'?employeeRequests.filter((request)=>request.status==='申請中'):employeeRequests;return { ok: true, json: async () => ({ ok: true, requests: rows, count: rows.length }) }; }
      if (fields.action === 'requestCreate') {
        if (duplicateRequest) return { ok: true, json: async () => ({ ok: false, code: 'DUPLICATE_REQUEST' }) };
        const requestId = `00000000-0000-4000-8000-${String(employeeRequests.length + 1).padStart(12,'0')}`;
        if (requestFailure === 'before') throw new Error('simulated request failure');
        employeeRequests.push({ requestId, workDate: fields.workDate, startTime: fields.startTime, endTime: fields.endTime, requestType: fields.requestType, status: '申請中' });
        if (requestFailure === 'after') throw new Error('simulated lost request response');
        return { ok: true, json: async () => ({ ok: true, requestId }) };
      }
      if (fields.action === 'requestCancel') {
        if (requestFailure === 'cancel-before') throw new Error('simulated cancellation failure');
        const index = employeeRequests.findIndex((request) => request.requestId === fields.requestId);
        if (index < 0) return { ok: true, json: async () => ({ ok: false, code: 'REQUEST_NOT_FOUND' }) };
        if (requestFailure === 'cancel-remains') return { ok: true, json: async () => ({ ok: false, code: 'REQUEST_STORAGE_UNAVAILABLE', diagnosticCode: 'DELETE_REMAINS', diagnosticId: fields.diagnosticId }) };
        employeeRequests.splice(index, 1);
        if (requestFailure === 'cancel-after') throw new Error('simulated lost cancellation response');
        return { ok: true, json: async () => ({ ok: true, diagnosticCode: 'DELETE_CONFIRMED', diagnosticId: fields.diagnosticId }) };
      }
      if (fields.action === 'requestApprove') {
        if (approveFailure) {const code=typeof approveFailure==='string'?approveFailure:approveFailure.code;return { ok: true, json: async () => ({ ok: false, code, diagnosticCode: typeof approveFailure==='object'?approveFailure.diagnosticCode:undefined, diagnosticId: fields.diagnosticId }) };}
        const index=employeeRequests.findIndex((request)=>request.requestId===fields.requestId);if(index>=0)employeeRequests.splice(index,1);
        return { ok: true, json: async () => ({ ok: true, code: 'APPROVED', requestId: fields.requestId }) };
      }
      if (fields.action === 'requestReject') {
        if (rejectFailure) return { ok: true, json: async () => ({ ok: false, code: rejectFailure }) };
        const request=employeeRequests.find((item)=>item.requestId===fields.requestId);if(request)request.status='却下';
        return { ok: true, json: async () => ({ ok: true, requestId: fields.requestId, status: '却下' }) };
      }
      if (fields.action === 'attendanceList') {
        if (disabledActions.includes('attendanceList')) return { ok: true, json: async () => ({ ok: false, code: 'DISABLED' }) };
        return {
          ok: true,
          json: async () => ({
            ok: true, records: currentRecords, actorRole, workDate: responseWorkDate || fields.workDate,
            dateClass, selfShift: nextState, shiftWritesEnabled, attendanceWritesEnabled,
          }),
        };
      }
      throw new Error(`unexpected action ${fields.action}`);
    },
  });
  const script = match[1].replace(/\nstart\(\);\s*$/, '\n');
  vm.runInContext(script, context);
  get('workDate').value = '2026-10-05';
  return { context, get, requests, confirmMessages, employeeRequests };
}

test('selecting a date closes the shared calendar input and reloads that date for employee and manager views', () => {
  for (const actorRole of ['employee', 'manager']) {
    const page = makePage();
    if (actorRole === 'employee') {
      page.context.render({ actorRole, dateClass: 'past', selfShift: { employeeId: 'EMP-01', displayName: '従業員01', revision: 0, stateToken: 'a'.repeat(64), schedule: null, attendance: null } });
    } else {
      page.context.render({ actorRole, dateClass: 'past', records: [{ employeeId: 'MGR-01', targetActorId: 'MGR-01', displayName: '店長', revision: 0, stateToken: 'b'.repeat(64), schedule: null, attendance: null }] });
    }
    const selectedDates = [];
    page.get('workDate').value = '2026-10-10';
    page.context.load = () => { selectedDates.push(page.get('workDate').value); };
    page.get('workDate').handlers.change();
    assert.equal(page.get('workDate').blurCount, 1, `${actorRole} calendar closes after a date is selected`);
    assert.deepEqual(selectedDates, ['2026-10-10'], `${actorRole} loads the selected date`);
  }
});

test('calendar month navigation has no date-change handler and does not close or reload', () => {
  const page = makePage();
  let loads = 0;
  page.context.load = () => { loads++; };
  assert.equal(page.get('workDate').handlers.click, undefined);
  assert.equal(page.get('workDate').handlers.input, undefined);
  assert.equal(loads, 0);
  assert.equal(page.get('workDate').blurCount, 0);
});

test('employee submits a correction request without sending an employee ID or changing attendance', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 2, schedule: null, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';
  page.get('endTime').value = '17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  const request = page.requests.find((item) => item.action === 'requestCreate');
  assert.deepEqual(request, {
    id_token: 'test-line-id-token', action: 'requestCreate', requestType: '修正申請', workDate: '2026-10-05', startTime: '09:00', endTime: '17:00',
  });
  assert.equal(page.requests.filter((item) => item.action === 'attendanceList').length, 1);
  assert.equal(page.requests.some((item) => ['shiftMutation','saveActual'].includes(item.action)), false);
  assert.equal(vm.runInContext('entryState.revision', page.context), 2);
  assert.equal(page.get('requestStatusList').children.length, 1);
  assert.match(page.get('requestStatusList').children[0].children[0].textContent, /10\/05 09:00〜17:00.*修正申請中/);
  assert.equal(page.get('saveButton').disabled, false);
});

test('employee request leaves initially empty attendance data unchanged', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';
  page.get('endTime').value = '17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 0);
  assert.equal(page.requests.filter((item) => item.action === 'requestCreate').length, 1);
  assert.equal(vm.runInContext('entryState.revision', page.context), 0);
  assert.equal(vm.runInContext('entryState.schedule', page.context), null);
  assert.equal(page.get('status').textContent, '修正申請を受け付けました。');
  assert.equal(page.get('connectionError').hidden, true);
});

test('employee requests do not produce shift mutation performance diagnostics; manager direct save remains unchanged', async () => {
  const page = makePage({ diagnosticMode: true, initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';page.get('endTime').value = '17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.equal(page.get('savePerformanceOutput').textContent, '');
  assert.equal(page.requests.filter((request) => request.action === 'shiftMutation').length, 0);
  assert.equal(page.requests.filter((request) => request.action === 'requestCreate').length, 1);
  assert.equal(page.requests.filter((request) => request.action === 'requestList').length, 2, 'initial load and post-create refresh');

  const managerRow = { employeeId: 'EMP-02', targetActorId: 'EMP-02', displayName: '従業員02', workDate: '2026-10-05', revision: 0, stateToken: 'c'.repeat(64), schedule: null, attendance: null };
  const manager = makePage({ diagnosticMode: true, actorRole: 'manager', dateClass: 'future', attendanceRecords: [managerRow] });
  vm.runInContext('shiftWritesEnabled=true;attendanceWritesEnabled=true', manager.context);
  manager.context.render({ actorRole: 'manager', dateClass: 'future', records: [managerRow] });
  const managerForm = manager.get('list').children[0].children[4];
  managerForm.children[0].children[1].value = '09:00';managerForm.children[1].children[1].value = '17:00';
  await managerForm.children[2].children[0].children[0].handlers.click();
  const managerOutput = JSON.parse(manager.get('savePerformanceOutput').textContent);
  assert.equal(managerOutput.action, 'save');
  assert.equal(managerOutput.requestId, manager.requests.find((request) => request.action === 'shiftMutation').requestId);
  assert.equal(managerOutput.server.requestId, managerOutput.requestId);

  assert.equal(manager.requests.filter((request) => request.action === 'shiftMutation').length, 1);
});

test('employee correction request sends the selected date and edited values', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 4, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '10:00';
  page.get('endTime').value = '18:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  const request = page.requests.find((item) => item.action === 'requestCreate');
  assert.equal(request.requestType, '修正申請');
  assert.equal(request.workDate, '2026-10-05');
  assert.equal(request.startTime, '10:00');
  assert.equal(request.endTime, '18:00');
});

test('request list shows pending and rejected requests in target date order without exposing UUID', async () => {
  const page = makePage({ initialRequests: [
    { requestId: '11111111-1111-4111-8111-111111111111', workDate: '2026-11-08', startTime: '10:00', endTime: '18:00', requestType: '削除申請', status: '却下' },
    { requestId: '22222222-2222-4222-8222-222222222222', workDate: '2026-11-02', startTime: '09:00', endTime: '17:00', requestType: '修正申請', status: '申請中' },
  ], initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  const rows = page.get('requestStatusList').children;
  assert.equal(rows.length, 2);
  assert.match(rows[0].children[0].textContent, /^11\/02 .*修正申請中/);
  assert.match(rows[0].children[0].textContent, /09:00〜17:00/);
  assert.match(rows[1].children[0].textContent, /11\/08 削除申請が却下/);
  assert.equal(rows[0].children[1].dataset.requestId, '22222222-2222-4222-8222-222222222222');
  assert.doesNotMatch(rows[0].children[0].textContent, /22222222-2222-4222-8222-222222222222/);
});

test('duplicate request displays a clear message and does not send direct shift mutation', async () => {
  const page = makePage({ duplicateRequest: true, initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);page.get('startTime').value='09:00';page.get('endTime').value='17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.match(page.get('status').textContent, /すでに申請があります/);
  assert.equal(page.requests.filter((request) => request.action === 'shiftMutation').length, 0);
});

test('request cancellation uses the hidden UUID and refreshes list; canceled date can be requested again', async () => {
  const page = makePage({ initialRequests: [{ requestId: '33333333-3333-4333-8333-333333333333', workDate: '2026-10-05', startTime: '09:00', endTime: '17:00', requestType: '修正申請', status: '申請中' }], initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  await page.get('requestStatusList').children[0].children[1].handlers.click();
  assert.deepEqual(page.requests.find((request) => request.action === 'requestCancel'), { id_token: 'test-line-id-token', action: 'requestCancel', requestId: '33333333-3333-4333-8333-333333333333' });
  assert.equal(page.get('requestStatusList').children.length, 0);
  page.get('startTime').value='09:00';page.get('endTime').value='17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.equal(page.requests.filter((request) => request.action === 'requestCreate').length, 1);
  assert.equal(page.get('requestStatusList').children.length, 1);
});

test('screen becoming visible refreshes request status', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  const before = page.requests.filter((request) => request.action === 'requestList').length;
  page.context.document.handlers.visibilitychange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.requests.filter((request) => request.action === 'requestList').length, before + 1);
});

test('busy gate prevents a second correction request while the first is in flight', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);page.get('startTime').value='09:00';page.get('endTime').value='17:00';
  const originalFetch = page.context.fetch;
  let finish, interceptedCreates = 0;
  page.context.fetch = async (url, options) => {
    const fields = Object.fromEntries(new URLSearchParams(options.body).entries());
    if (fields.action === 'requestCreate') { interceptedCreates++; return new Promise((resolve) => { finish = () => { page.employeeRequests.push({ requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', workDate: fields.workDate, startTime: fields.startTime, endTime: fields.endTime, requestType: fields.requestType, status: '申請中' });resolve({ ok: true, json: async () => ({ ok: true, requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }) }); }; }); }
    return originalFetch(url, options);
  };
  const first = page.get('entryForm').handlers.submit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.equal(interceptedCreates, 1, 'second submission is blocked by busy');
  finish();await first;
  assert.equal(page.get('requestStatusList').children.length, 1);
});

test('unknown cancellation result refreshes requests and confirms when UUID is gone', async () => {
  const page = makePage({ requestFailure: 'cancel-after', initialRequests: [{ requestId: '44444444-4444-4444-8444-444444444444', workDate: '2026-10-05', startTime: '09:00', endTime: '17:00', requestType: '削除申請', status: '申請中' }], initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);await page.get('requestStatusList').children[0].children[1].handlers.click();
  assert.equal(page.get('requestStatusList').children.length, 0);
  assert.equal(page.get('status').textContent, '申請の取消しを確認しました。');
  assert.equal(page.requests.filter((request) => request.action === 'requestCancel').length, 1);
});

test('DEV diagnostic mode attaches only a short correlation id and records cancellation trace without identifiers', async () => {
  const page = makePage({ diagnosticMode: true, initialRequests: [{ requestId: '44444444-4444-4444-8444-444444444444', workDate: '2026-10-05', startTime: '', endTime: '', requestType: '削除申請', status: '申請中' }], initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);await page.get('requestStatusList').children[0].children[1].handlers.click();
  const sent=page.requests.find((request)=>request.action==='requestCancel');
  assert.equal(sent.diagnosticId,'010203040506');
  assert.equal(sent.requestId,'44444444-4444-4444-8444-444444444444');
  const output=page.get('traceOutput').textContent;
  assert.match(output,/request_operation/);assert.match(output,/DELETE_CONFIRMED/);assert.match(output,/request_cancel_list_refresh/);assert.match(output,/010203040506/);
  assert.doesNotMatch(output,/44444444-4444-4444-8444-444444444444|test-line-id-token/);
  assert.equal(page.requests.filter((request)=>request.action==='requestCancel').length,1);
});

test('cancellation row-remains response refreshes once and never resends the destructive request', async () => {
  const page=makePage({requestFailure:'cancel-remains',initialRequests:[{requestId:'45454545-4545-4545-8545-454545454545',workDate:'2026-10-05',startTime:'09:00',endTime:'17:00',requestType:'削除申請',status:'申請中'}],initialState:{employeeId:'EMP-01',displayName:'本人',revision:0,schedule:null,attendance:null}});
  await page.context.load(false);const beforeList=page.requests.filter((request)=>request.action==='requestList').length;
  await page.get('requestStatusList').children[0].children[1].handlers.click();
  assert.equal(page.requests.filter((request)=>request.action==='requestCancel').length,1);
  assert.equal(page.requests.filter((request)=>request.action==='requestList').length,beforeList+1);
  assert.equal(page.get('requestStatusList').children.length,1);
  assert.match(page.get('status').textContent,/取消し結果を確認できません/);
});

test('manager sees only pending requests with the matching count in a collapsible section', async () => {
  const page=makePage({actorRole:'manager',initialRequests:[
    {requestId:'55555555-5555-4555-8555-555555555555',workDate:'2026-11-03',startTime:'09:00',endTime:'17:00',requestType:'修正申請',status:'申請中',displayName:'田中',employeeOrder:1},
    {requestId:'66666666-6666-4666-8666-666666666666',workDate:'2026-11-04',startTime:'10:00',endTime:'18:00',requestType:'削除申請',status:'却下',displayName:'佐藤',employeeOrder:2},
  ]});
  await page.context.load(false);
  assert.equal(page.get('managerRequestSection').hidden,false);
  assert.equal(page.get('managerRequestCount').textContent,'1件の申請があります。');
  assert.equal(page.get('managerRequestList').children.length,1);
  assert.equal(page.get('managerRequestList').children[0].children[0].children[0].textContent,'田中');
  assert.equal(page.get('managerRequestSection').tagName,undefined); // native <details> uses the existing disclosure behavior
  assert.match(html,/<details id="managerRequestSection"/);
});

test('manager edits correction date and times and approves through requestApprove', async () => {
  const request={requestId:'77777777-7777-4777-8777-777777777777',workDate:'2026-11-03',startTime:'09:00',endTime:'17:00',requestType:'修正申請',status:'申請中',displayName:'田中',employeeOrder:1};
  const page=makePage({actorRole:'manager',initialRequests:[request]});await page.context.load(false);
  const row=page.get('managerRequestList').children[0];
  row.querySelector('[data-review-date]').value='2026-11-05';row.querySelector('[data-review-start]').value='10:15';row.querySelector('[data-review-end]').value='18:30';
  await row.querySelector('[data-review-approve]').handlers.click();
  assert.deepEqual(page.requests.find((item)=>item.action==='requestApprove'),{id_token:'test-line-id-token',action:'requestApprove',requestId:'77777777-7777-4777-8777-777777777777',workDate:'2026-11-05',startTime:'10:15',endTime:'18:30'});
  assert.equal(page.get('managerRequestCount').textContent,'0件の申請があります。');
  assert.equal(page.get('status').textContent,'申請を承認しました。');
});

test('DEV approval failure carries only correlation and fixed diagnostic code, refreshes list, and is not resent', async () => {
  const request={requestId:'78787878-7878-4787-8787-787878787878',workDate:'2026-11-03',startTime:'09:00',endTime:'17:00',requestType:'修正申請',status:'申請中',displayName:'田中',employeeOrder:1};
  const page=makePage({diagnosticMode:true,actorRole:'manager',approveFailure:{code:'APPROVAL_SAVED_REQUEST_REMAINS',diagnosticCode:'APPROVAL_REQUEST_READBACK_FAILED'},initialRequests:[request]});
  await page.context.load(false);const row=page.get('managerRequestList').children[0];await row.querySelector('[data-review-approve]').handlers.click();
  const sent=page.requests.find((item)=>item.action==='requestApprove');assert.equal(sent.diagnosticId,'010203040506');
  assert.equal(page.requests.filter((item)=>item.action==='requestApprove').length,1);
  assert.equal(page.get('managerRequestCount').textContent,'1件の申請があります。');
  const output=page.get('traceOutput').textContent;assert.match(output,/APPROVAL_REQUEST_READBACK_FAILED/);assert.match(output,/010203040506/);
  assert.doesNotMatch(output,/78787878-7878-4787-8787-787878787878|test-line-id-token/);
});

test('manager deletion approval edits only date and sends snapshot times unchanged', async () => {
  const request={requestId:'88888888-8888-4888-8888-888888888888',workDate:'2026-11-03',startTime:'08:55',endTime:'17:05',requestType:'削除申請',status:'申請中',displayName:'田中',employeeOrder:1};
  const page=makePage({actorRole:'manager',initialRequests:[request]});await page.context.load(false);
  const row=page.get('managerRequestList').children[0];
  row.querySelector('[data-review-date]').value='2026-11-06';
  assert.equal(row.querySelector('[data-review-start]'),null);
  assert.equal(row.querySelector('[data-review-read-only-times]').textContent,'08:55 ～ 17:05');
  await row.querySelector('[data-review-approve]').handlers.click();
  const sent=page.requests.find((item)=>item.action==='requestApprove');
  assert.equal(sent.workDate,'2026-11-06');assert.equal(sent.startTime,'08:55');assert.equal(sent.endTime,'17:05');
});

test('empty deletion request times are omitted from employee status and manager list', async () => {
  const request={requestId:'abababab-abab-4bab-8bab-abababababab',workDate:'2026-11-28',startTime:'',endTime:'',requestType:'削除申請',status:'申請中',displayName:'田中',employeeOrder:1};
  const employee=makePage({initialRequests:[request],initialState:{employeeId:'EMP-01',displayName:'本人',revision:0,schedule:null,attendance:null}});
  await employee.context.load(false);
  assert.match(employee.get('requestStatusList').children[0].children[0].textContent,/11\/28 削除申請中/);
  assert.doesNotMatch(employee.get('requestStatusList').children[0].children[0].textContent,/1899|GMT|～/);

  const manager=makePage({actorRole:'manager',initialRequests:[request]});
  await manager.context.load(false);
  const row=manager.get('managerRequestList').children[0];
  assert.equal(row.querySelector('[data-review-read-only-times]'),null);
});

test('manager rejection calls requestReject and removes the request from pending list', async () => {
  const request={requestId:'99999999-9999-4999-8999-999999999999',workDate:'2026-11-03',startTime:'09:00',endTime:'17:00',requestType:'修正申請',status:'申請中',displayName:'田中',employeeOrder:1};
  const page=makePage({actorRole:'manager',initialRequests:[request]});await page.context.load(false);
  await page.get('managerRequestList').children[0].querySelector('[data-review-reject]').handlers.click();
  assert.deepEqual(page.requests.find((item)=>item.action==='requestReject'),{id_token:'test-line-id-token',action:'requestReject',requestId:'99999999-9999-4999-8999-999999999999'});
  assert.equal(page.get('managerRequestCount').textContent,'0件の申請があります。');
});

test('failed approval leaves request available for a manual retry', async () => {
  const request={requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',workDate:'2026-11-03',startTime:'09:00',endTime:'17:00',requestType:'修正申請',status:'申請中',displayName:'田中',employeeOrder:1};
  const page=makePage({actorRole:'manager',approveFailure:'APPROVAL_SAVE_FAILED',initialRequests:[request]});await page.context.load(false);
  const row=page.get('managerRequestList').children[0];await row.querySelector('[data-review-approve]').handlers.click();
  assert.equal(row.querySelector('[data-review-approve]').disabled,false);
  assert.equal(page.get('managerRequestCount').textContent,'1件の申請があります。');
  assert.match(page.get('status').textContent,/保存できませんでした/);
  assert.equal(page.requests.filter((item)=>item.action==='requestApprove').length,1);
});


test('employee correction does not use attendance revisions or reload attendance after submission', async () => {
  const page = makePage({
    initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 4, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: null },
  });
  await page.context.load(false);
  page.get('startTime').value = '10:00'; page.get('endTime').value = '18:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 0);
  assert.equal(page.requests.filter((item) => item.action === 'requestCreate').length, 1);
  assert.equal(page.requests.filter((item) => item.action === 'attendanceList').length, 1);
  assert.equal(page.get('startTime').value, '10:00');
  assert.equal(page.get('endTime').value, '18:00');
  assert.equal(page.get('status').textContent, '修正申請を受け付けました。');
});

test('startup clears the busy gate and applies current writer permissions to initial buttons', async () => {
  const empty = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await empty.context.start();
  assert.equal(empty.get('saveButton').disabled, true, 'empty invalid times cannot be saved');
  assert.equal(empty.get('deleteButton').disabled, true, 'empty state has nothing to delete');

  const populated = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 4, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: { startTime: '10:00', endTime: '18:00' } } });
  await populated.context.start();
  assert.equal(populated.get('startTime').value, '10:00');
  assert.equal(populated.get('endTime').value, '18:00');
  assert.equal(populated.get('saveButton').disabled, false);
  assert.equal(populated.get('deleteButton').disabled, false);
});

test('shift deletion asks for confirmation and sends no request when cancelled', async () => {
  const page = makePage({ confirm: false, initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: null } });
  await page.context.load(false);
  await page.get('deleteButton').handlers.click();
  assert.equal(page.requests.some((item) => item.action === 'requestCreate'), false);
});

test('confirmed deletion submits a request with displayed times and refreshes request list', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: { startTime: '08:55', endTime: '17:05' } } });
  await page.context.load(false);
  await page.get('deleteButton').handlers.click();
  assert.match(page.confirmMessages[0], /2026-10-05/);
  assert.match(page.confirmMessages[0], /削除を申請/);
  const request = page.requests.find((item) => item.action === 'requestCreate');
  assert.equal(request.requestType, '削除申請');
  assert.equal(request.startTime, '08:55');
  assert.equal(request.endTime, '17:05');
  assert.equal(page.requests.filter((item) => item.action === 'attendanceList').length, 1);
  assert.equal(vm.runInContext('entryState.schedule.startTime', page.context), '09:00');
  assert.equal(vm.runInContext('entryState.attendance.startTime', page.context), '08:55');
  assert.equal(page.get('status').textContent, '削除申請を受け付けました。');
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 0);
});

test('actual-only day can request deletion while preserving the displayed record', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: { startTime: '08:55', endTime: '17:05' } } });
  await page.context.load(false);
  assert.equal(page.get('deleteButton').disabled, false);
  await page.get('deleteButton').handlers.click();
  assert.equal(page.requests.find((item) => item.action === 'requestCreate').requestType, '削除申請');
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 0);
  assert.equal(vm.runInContext('entryState.schedule', page.context), null);
  assert.equal(vm.runInContext('entryState.attendance.startTime', page.context), '08:55');
});

test('empty day disables delete and preserves both empty records', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  assert.equal(page.get('deleteButton').disabled, true);
  await page.get('deleteButton').handlers.click();
  assert.equal(page.requests.some((item) => item.action === 'shiftMutation'), false);
  assert.equal(vm.runInContext('entryState.schedule', page.context), null);
  assert.equal(vm.runInContext('entryState.attendance', page.context), null);
});

test('all four cases display the specified source times and enable delete only when a target exists', async () => {
  const cases = [
    { schedule: null, attendance: null, displayed: null, planned: /未登録/, deleteDisabled: true },
    { schedule: { startTime: '09:00', endTime: '17:00' }, attendance: null, displayed: { startTime: '09:00', endTime: '17:00' }, planned: /09:00–17:00/, deleteDisabled: false },
    { schedule: { startTime: '09:00', endTime: '17:00' }, attendance: { startTime: '08:55', endTime: '17:05' }, displayed: { startTime: '08:55', endTime: '17:05' }, planned: /09:00–17:00/, deleteDisabled: false },
    { schedule: null, attendance: { startTime: '08:55', endTime: '17:05' }, displayed: { startTime: '08:55', endTime: '17:05' }, planned: /未登録/, deleteDisabled: false },
  ];
  for (const [index, state] of cases.entries()) {
    const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, ...state } });
    await page.context.load(false);
    assert.match(page.get('plannedTime').textContent, state.planned, `case ${index + 1} planned row`);
    assert.equal(page.get('startTime').value, state.displayed?.startTime || '', `case ${index + 1} start`);
    assert.equal(page.get('endTime').value, state.displayed?.endTime || '', `case ${index + 1} end`);
    assert.equal(page.get('deleteButton').disabled, state.deleteDisabled, `case ${index + 1} delete availability`);
  }
});

test('either single schedule endpoint remains eligible for deletion request without clearing schedule', async () => {
  for (const schedule of [{ startTime: '09:00', endTime: '' }, { startTime: '', endTime: '17:00' }]) {
    const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 2, schedule, attendance: null } });
    await page.context.load(false);
    assert.equal(page.get('deleteButton').disabled, false);
    assert.equal(page.get('startTime').value, schedule.startTime);
    assert.equal(page.get('endTime').value, schedule.endTime);
    await page.get('deleteButton').handlers.click();
    assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 0);
    assert.equal(page.requests.find((item) => item.action === 'requestCreate').requestType, '削除申請');
    assert.notEqual(vm.runInContext('entryState.schedule', page.context), null);
    assert.equal(page.get('status').textContent, '削除申請を受け付けました。');
  }
});

test('schedule-only deletion request preserves the schedule until approval', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: null } });
  await page.context.load(false);
  await page.get('deleteButton').handlers.click();
  assert.match(page.confirmMessages[0], /削除を申請/);
  assert.equal(vm.runInContext('entryState.schedule.startTime', page.context), '09:00');
  assert.equal(vm.runInContext('entryState.attendance', page.context), null);
});

test('past, today, and future corrections remain requests without changing displayed records', async () => {
  for (const dateClass of ['past', 'today']) {
    const page = makePage({ dateClass, initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
    await page.context.load(false);
    page.get('startTime').value = '09:00'; page.get('endTime').value = '17:00';
    await page.get('entryForm').handlers.submit({ preventDefault() {} });
    assert.equal(vm.runInContext('entryState.schedule', page.context), null);
    assert.equal(vm.runInContext('entryState.attendance', page.context), null);
    assert.equal(page.requests.filter((request) => request.action === 'requestCreate').length, 1);
  }
  const priorAttendance = { startTime: '08:55', endTime: '17:05' };
  const future = makePage({ dateClass: 'future', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: priorAttendance } });
  await future.context.load(false);
  assert.equal(future.get('startTime').value, priorAttendance.startTime, 'case 4 displays actual times');
  assert.equal(future.get('endTime').value, priorAttendance.endTime);
  future.get('startTime').value = '10:00'; future.get('endTime').value = '18:00';
  await future.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.equal(vm.runInContext('entryState.schedule', future.context), null);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('entryState.attendance', future.context))), priorAttendance, 'future save leaves actual data unchanged');
});

test('employee and manager selects generate 96 quarter-hour choices and leave empty values blank', async () => {
  const start = html.match(/<select id="startTime"[^>]*>/)?.[0] || '';
  const end = html.match(/<select id="endTime"[^>]*>/)?.[0] || '';
  assert.ok(start && end);
  assert.match(match[1], /for\(let hour=0;hour<24;hour\+\+\)for\(const minute of \['00','15','30','45'\]\)/);
  assert.doesNotMatch(html, /createTimePicker|time-picker|step="900"|formnovalidate/);

  const empty = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await empty.context.load(false);
  for (const field of ['startTime', 'endTime']) {
    assert.equal(empty.get(field).value, '');
    assert.deepEqual(selectValues(empty.get(field)), ['', ...quarterHourValues()]);
  }

  const row = { employeeId: 'EMP-02', targetActorId: 'EMP-02', displayName: '従業員02', workDate: '2026-10-05', revision: 2, stateToken: 'c'.repeat(64), schedule: { startTime: '09:00', endTime: '17:00' }, attendance: null };
  const page = makePage({ actorRole: 'manager', dateClass: 'future', attendanceRecords: [row] });
  vm.runInContext('shiftWritesEnabled=true;attendanceWritesEnabled=true', page.context);
  page.context.render({ actorRole: 'manager', dateClass: 'future', records: [row] });
  const form = page.get('list').children[0].children[4];
  const managerStart = form.children[0].children[1], managerEnd = form.children[1].children[1];
  assert.deepEqual(selectValues(managerStart), ['', ...quarterHourValues()]);
  assert.deepEqual(selectValues(managerEnd), ['', ...quarterHourValues()]);
  managerStart.value = '09:15'; managerEnd.value = '17:45';
  await form.children[2].children[0].children[0].handlers.click();
  const request = page.requests.find((item) => item.action === 'shiftMutation');
  assert.equal(request.employeeId, 'EMP-02');
  assert.equal(request.startTime, '09:15');
  assert.equal(request.endTime, '17:45');
  assert.equal(page.get('status').textContent, '保存しました。');
});

test('registered non-quarter-hour values are displayed and preserved without rounding', async () => {
  const page = makePage({ dateClass: 'past', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: { startTime: '08:55', endTime: '17:05' }, attendance: { startTime: '08:55', endTime: '17:05' } } });
  await page.context.load(false);
  assert.equal(page.get('startTime').value, '08:55');
  assert.equal(page.get('endTime').value, '17:05');
  assert.deepEqual(selectValues(page.get('startTime')), ['', ...quarterHourValues(), '08:55']);
  assert.deepEqual(selectValues(page.get('endTime')), ['', ...quarterHourValues(), '17:05']);
  assert.equal(page.get('startTime').children.at(-1).textContent, '08:55（登録済み）');
  assert.equal(page.get('endTime').children.at(-1).textContent, '17:05（登録済み）');
  assert.equal(vm.runInContext("validTime('08:55') && validTime('17:05')", page.context), true);
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  let request = page.requests.find((item) => item.action === 'requestCreate');
  assert.equal(request.startTime, '08:55');
  assert.equal(request.endTime, '17:05');
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('entryState.schedule', page.context))), { startTime: '08:55', endTime: '17:05' });

  const oneSided = makePage({ dateClass: 'past', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: { startTime: '08:55', endTime: '17:05' }, attendance: { startTime: '08:55', endTime: '17:05' } } });
  await oneSided.context.load(false);
  oneSided.get('startTime').value = '09:15';
  await oneSided.get('entryForm').handlers.submit({ preventDefault() {} });
  request = oneSided.requests.find((item) => item.action === 'requestCreate');
  assert.equal(request.startTime, '09:15');
  assert.equal(request.endTime, '17:05');
});

test('date changes and rerenders discard previous temporary non-quarter-hour options', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: { startTime: '08:55', endTime: '17:05' }, attendance: null } });
  await page.context.load(false);
  assert.ok(selectValues(page.get('startTime')).includes('08:55'));
  page.context.render({ actorRole: 'employee', dateClass: 'future', selfShift: { employeeId: 'EMP-01', displayName: '本人', revision: 2, stateToken: 'b'.repeat(64), schedule: { startTime: '09:00', endTime: '17:00' }, attendance: null } });
  assert.deepEqual(selectValues(page.get('startTime')), ['', ...quarterHourValues()]);
  assert.deepEqual(selectValues(page.get('endTime')), ['', ...quarterHourValues()]);

  const manager = makePage();
  const nonQuarterRow = { employeeId: 'EMP-02', targetActorId: 'EMP-02', displayName: '従業員02', workDate: '2026-10-05', revision: 1, stateToken: 'c'.repeat(64), schedule: { startTime: '08:55', endTime: '17:05' }, attendance: null };
  const quarterRow = { ...nonQuarterRow, workDate: '2026-10-06', schedule: { startTime: '09:00', endTime: '17:00' } };
  manager.context.render({ actorRole: 'manager', dateClass: 'future', records: [nonQuarterRow] });
  let form = manager.get('list').children[0].children[4];
  assert.ok(selectValues(form.children[0].children[1]).includes('08:55'));
  manager.context.render({ actorRole: 'manager', dateClass: 'future', records: [quarterRow] });
  form = manager.get('list').children[0].children[4];
  assert.deepEqual(selectValues(form.children[0].children[1]), ['', ...quarterHourValues()]);
  assert.deepEqual(selectValues(form.children[1].children[1]), ['', ...quarterHourValues()]);
});

test('manager select inputs retain the existing create and delete mutation behavior', async () => {
  const empty = { employeeId: 'EMP-03', targetActorId: 'EMP-03', displayName: '従業員03', workDate: '2026-10-05', revision: 0, stateToken: 'd'.repeat(64), schedule: null, attendance: null };
  const createPage = makePage({ actorRole: 'manager', dateClass: 'future', attendanceRecords: [empty] });
  vm.runInContext('shiftWritesEnabled=true;attendanceWritesEnabled=true', createPage.context);
  createPage.context.render({ actorRole: 'manager', dateClass: 'future', records: [empty] });
  let form = createPage.get('list').children[0].children[4];
  assert.equal(form.children[0].children[1].value, '');
  assert.deepEqual(selectValues(form.children[0].children[1]), ['', ...quarterHourValues()]);
  assert.deepEqual(selectValues(form.children[1].children[1]), ['', ...quarterHourValues()]);
  form.children[0].children[1].value = '08:15'; form.children[1].children[1].value = '16:45';
  await form.children[2].children[0].children[0].handlers.click();
  let request = createPage.requests.find((item) => item.action === 'shiftMutation');
  assert.equal(request.type, 'create');
  assert.equal(request.employeeId, 'EMP-03');
  assert.equal(request.startTime, '08:15');
  assert.equal(request.endTime, '16:45');

  const existing = { ...empty, revision: 3, schedule: { startTime: '08:15', endTime: '16:45' } };
  const deletePage = makePage({ actorRole: 'manager', dateClass: 'future', attendanceRecords: [existing] });
  vm.runInContext('shiftWritesEnabled=true;attendanceWritesEnabled=true', deletePage.context);
  deletePage.context.render({ actorRole: 'manager', dateClass: 'future', records: [existing] });
  form = deletePage.get('list').children[0].children[4];
  await form.children[2].children[1].children[0].handlers.click();
  request = deletePage.requests.find((item) => item.action === 'shiftMutation');
  assert.equal(request.type, 'delete');
  assert.equal(request.employeeId, 'EMP-03');
  assert.equal(request.startTime, '');
  assert.equal(request.endTime, '');
  assert.equal(vm.runInContext('entryState.schedule', deletePage.context), null);
});

test('manager retains non-quarter-hour values on save and on a one-sided edit', async () => {
  const row = { employeeId: 'EMP-04', targetActorId: 'EMP-04', displayName: '従業員04', workDate: '2026-10-05', revision: 1, stateToken: 'e'.repeat(64), schedule: { startTime: '08:55', endTime: '17:05' }, attendance: null };
  const unchanged = makePage({ actorRole: 'manager', dateClass: 'future', attendanceRecords: [row] });
  vm.runInContext('shiftWritesEnabled=true;attendanceWritesEnabled=true', unchanged.context);
  unchanged.context.render({ actorRole: 'manager', dateClass: 'future', records: [row] });
  let form = unchanged.get('list').children[0].children[4];
  const start = form.children[0].children[1], end = form.children[1].children[1];
  assert.equal(start.value, '08:55');
  assert.equal(end.value, '17:05');
  assert.equal(start.children.at(-1).textContent, '08:55（登録済み）');
  assert.equal(end.children.at(-1).textContent, '17:05（登録済み）');
  await form.children[2].children[0].children[0].handlers.click();
  let request = unchanged.requests.find((item) => item.action === 'shiftMutation');
  assert.equal(request.startTime, '08:55');
  assert.equal(request.endTime, '17:05');

  const edited = makePage({ actorRole: 'manager', dateClass: 'future', attendanceRecords: [row] });
  vm.runInContext('shiftWritesEnabled=true;attendanceWritesEnabled=true', edited.context);
  edited.context.render({ actorRole: 'manager', dateClass: 'future', records: [row] });
  form = edited.get('list').children[0].children[4];
  form.children[0].children[1].value = '09:15';
  await form.children[2].children[0].children[0].handlers.click();
  request = edited.requests.find((item) => item.action === 'shiftMutation');
  assert.equal(request.startTime, '09:15');
  assert.equal(request.endTime, '17:05');
});

test('overnight employee schedule can be submitted for correction and stays unchanged until approval', async () => {
  const page = makePage({ dateClass: 'future', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: { startTime: '22:00', endTime: '02:00' }, attendance: null } });
  await page.context.load(false);
  assert.match(page.get('plannedTime').textContent, /22:00–02:00（翌日）/);
  page.get('startTime').value = '22:15'; page.get('endTime').value = '02:45';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  const request = page.requests.find((item) => item.action === 'requestCreate');
  assert.equal(request.startTime, '22:15');
  assert.equal(request.endTime, '02:45');
  assert.match(page.get('plannedTime').textContent, /22:00–02:00（翌日）/);
});

test('a lost request response is reconciled by refreshing request list without resending', async () => {
  const page = makePage({ requestFailure: 'after', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';
  page.get('endTime').value = '17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.match(page.get('status').textContent, /申請結果を確認しました/);
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 0);
  assert.equal(page.requests.filter((item) => item.action === 'requestCreate').length, 1);
  assert.equal(page.get('requestStatusList').children.length, 1);
});

test('changing the date does not refetch request list and keeps request status visible', async () => {
  const pending = { requestId: 'secret-uuid', workDate: '2026-10-05', startTime: '09:00', endTime: '17:00', requestType: '修正申請', status: '申請中' };
  const page = makePage({ initialRequests: [pending], initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  const before = page.requests.filter((item) => item.action === 'requestList').length;
  page.get('workDate').value = '2026-10-06';
  await page.get('workDate').handlers.change();
  assert.equal(page.requests.filter((item) => item.action === 'requestList').length, before);
  assert.equal(page.get('requestStatusList').children.length, 1);
  assert.doesNotMatch(page.get('requestStatusList').children[0].textContent, /secret-uuid/);
});

test('an unresolved request is not retried and request list is refreshed', async () => {
  const page = makePage({ requestFailure: 'before', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';
  page.get('endTime').value = '17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.match(page.get('status').textContent, /申請結果を確認しました/);
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 0);
  assert.equal(page.requests.filter((item) => item.action === 'requestCreate').length, 1);
});

test('response for a different work date is rejected and does not populate the entry state', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null }, responseWorkDate: '2026-10-06' });
  const result = await page.context.load(false);
  assert.equal(result, null);
  assert.equal(vm.runInContext('entryState', page.context), null);
  assert.equal(page.get('connectionError').hidden, false);
});

test('DISABLED attendance response is shown as a stopped feature, not a connection failure', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null }, disabledActions: ['attendanceList'] });
  const result = await page.context.load(false);
  assert.equal(result, null);
  assert.equal(page.get('attendancePanel').hidden, false);
  assert.equal(page.get('connectionError').hidden, true);
  assert.equal(page.get('status').textContent, '機能が停止中です。');
});

test('request submission never invokes disabled shift mutation', async () => {
  const page = makePage({ disabledActions: ['shiftMutation'], initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: null, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';
  page.get('endTime').value = '17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.equal(page.get('connectionError').hidden, true);
  assert.equal(page.get('status').textContent, '修正申請を受け付けました。');
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 0);
  assert.equal(page.requests.filter((item) => item.action === 'attendanceList').length, 1, 'only initial load fetches attendance state');
});

test('employee request flow does not use shift mutation outcome or replay path', async () => {
  const page = makePage({ mutationFailure: 'outcome-unknown', diagnosticMode: true, dateClass: 'today', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 2, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: { startTime: '09:00', endTime: '17:00' } } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';
  page.get('endTime').value = '17:15';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.equal(page.get('status').textContent, '修正申請を受け付けました。');
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 0);
  assert.equal(page.requests.filter((item) => item.action === 'requestList').length, 2);
});

test('DISABLED registration is reported as a definitive result', async () => {
  const page = makePage({ disabledActions: ['register'], initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  page.get('enrollmentCode').value = 'A'.repeat(32);
  await page.get('enrollment').handlers.submit({ preventDefault() {} });
  assert.equal(page.get('enrollmentStatus').textContent, '機能が停止中です。');
  assert.equal(page.requests.filter((item) => item.action === 'register').length, 1);
  assert.equal(page.requests.filter((item) => item.action === 'attendanceList').length, 0);
});

test('read-only shift capability disables editor inputs and prevents shift writes', async () => {
  const page = makePage({ shiftWritesEnabled: false, attendanceWritesEnabled: true, initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 2, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: null } });
  await page.context.load(false);
  assert.equal(page.get('startTime').disabled, true);
  assert.equal(page.get('endTime').disabled, true);
  assert.equal(page.get('saveButton').disabled, true);
  assert.equal(page.get('deleteButton').disabled, true);
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  await page.get('deleteButton').handlers.click();
  assert.equal(page.requests.some((item) => item.action === 'shiftMutation'), false);
});

test('initial work date and current employee controls stay in the existing attendance screen', () => {
  const dateInput = html.match(/<input id="workDate"[^>]*>/)?.[0] || '';
  assert.match(dateInput, /type="date"/);
  assert.match(dateInput, /min="2026-10-01"/);
  for (const id of ['entryCard', 'entryForm', 'startTime', 'endTime', 'saveButton', 'deleteButton']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /class="entry-actions"[^>]*>[\s\S]*id="saveButton"[\s\S]*id="deleteButton"/);
  assert.match(html, /\.entry-actions\{[^}]*display:flex[^}]*gap:20px/);
  assert.match(html, /<button id="saveButton" type="submit">修正申請<\/button>/);
  assert.match(html, /<button id="deleteButton" type="button">削除申請<\/button>/);
  assert.match(html, /<label>開始 /);
  assert.match(html, /<label>終了 /);
  assert.doesNotMatch(html, /id="shiftForm"/);
});
