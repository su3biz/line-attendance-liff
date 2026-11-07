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
    children: [], handlers: {}, attributes: {}, classList: { add() {}, remove() {} },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}

function makePage({ initialState, confirm = true, mutationFailure = null, responseWorkDate = null } = {}) {
  const elements = new Map();
  const requests = [];
  let id = 0;
  const get = (name) => {
    if (!elements.has(name)) elements.set(name, element());
    return elements.get(name);
  };
  const nextState = { ...initialState };
  const context = vm.createContext({
    document: {
      getElementById: get,
      createElement: element,
      createTextNode: (textContent) => ({ textContent }),
    },
    window: { confirm: () => confirm },
    URL, URLSearchParams, Error, AbortController, setTimeout, clearTimeout,
    crypto: { randomUUID: () => `request-${String(++id).padStart(4, '0')}` },
    fetch: async (_url, options) => {
      const fields = Object.fromEntries(new URLSearchParams(options.body).entries());
      requests.push(fields);
      if (fields.action === 'shiftMutation') {
        if (mutationFailure === 'before') throw new Error('simulated request failure');
        nextState.revision = Number(fields.expectedRevision) + 1;
        nextState.schedule = fields.type === 'delete' ? null : { startTime: fields.startTime, endTime: fields.endTime };
        if (mutationFailure === 'after-switch') get('workDate').value = '2026-10-06';
        if (mutationFailure === 'after' || mutationFailure === 'after-switch') throw new Error('simulated lost response');
        return { ok: true, json: async () => ({ ok: true, code: 'SAVED' }) };
      }
      if (fields.action === 'attendanceList') return { ok: true, json: async () => ({ ok: true, records: [], actorRole: 'employee', workDate: responseWorkDate || fields.workDate, selfShift: nextState }) };
      throw new Error(`unexpected action ${fields.action}`);
    },
  });
  const script = match[1].replace(/\nstart\(\);\s*$/, '\n');
  vm.runInContext(script, context);
  vm.runInContext("token='test-line-id-token'", context);
  get('workDate').value = '2026-10-05';
  get('shiftStart').value = initialState?.schedule?.startTime || '09:00';
  get('shiftEnd').value = initialState?.schedule?.endTime || '17:00';
  return { context, get, requests };
}

test('employee can create a shift using the authenticated identity and current revision', async () => {
  const state = { employeeId: 'EMP-01', revision: 2, schedule: null };
  const page = makePage({ initialState: state });
  await page.context.load(false);
  page.get('shiftStart').value = '09:00';
  page.get('shiftEnd').value = '17:00';
  await page.get('shiftForm').handlers.submit({ preventDefault() {} });
  const request = page.requests.find((item) => item.action === 'shiftMutation');
  assert.deepEqual(request, {
    id_token: 'test-line-id-token', action: 'shiftMutation', type: 'create', employeeId: 'EMP-01', workDate: '2026-10-05',
    expectedRevision: '2', requestId: 'request-0001', startTime: '09:00', endTime: '17:00',
  });
  assert.equal(page.requests.filter((item) => item.action === 'attendanceList').length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('shiftState', page.context))), {
    employeeId: 'EMP-01', revision: 3, schedule: { startTime: '09:00', endTime: '17:00' },
  });
  assert.equal(page.get('shiftSaveButton').textContent, 'シフトを変更');
  assert.equal(page.get('shiftDeleteButton').hidden, false);
});

test('employee can update a shift with its current revision', async () => {
  const state = { employeeId: 'EMP-01', revision: 4, schedule: { startTime: '09:00', endTime: '17:00' } };
  const page = makePage({ initialState: state });
  await page.context.load(false);
  page.get('shiftStart').value = '10:00';
  page.get('shiftEnd').value = '18:00';
  await page.get('shiftForm').handlers.submit({ preventDefault() {} });
  const request = page.requests.find((item) => item.action === 'shiftMutation');
  assert.equal(request.type, 'update');
  assert.equal(request.expectedRevision, '4');
  assert.equal(request.startTime, '10:00');
  assert.equal(request.endTime, '18:00');
});

test('shift deletion asks for confirmation and sends no request when cancelled', async () => {
  const state = { employeeId: 'EMP-01', revision: 1, schedule: { startTime: '09:00', endTime: '17:00' } };
  const page = makePage({ initialState: state, confirm: false });
  await page.context.load(false);
  await page.get('shiftDeleteButton').handlers.click();
  assert.equal(page.requests.some((item) => item.action === 'shiftMutation'), false);
});

test('confirmed shift deletion sends a delete mutation with the current revision', async () => {
  const state = { employeeId: 'EMP-01', revision: 1, schedule: { startTime: '09:00', endTime: '17:00' } };
  const page = makePage({ initialState: state, confirm: true });
  await page.context.load(false);
  await page.get('shiftDeleteButton').handlers.click();
  const request = page.requests.find((item) => item.action === 'shiftMutation');
  assert.equal(request.type, 'delete');
  assert.equal(request.expectedRevision, '1');
  assert.equal(request.startTime, '');
  assert.equal(request.endTime, '');
  assert.equal(page.requests.filter((item) => item.action === 'attendanceList').length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('shiftState', page.context))), {
    employeeId: 'EMP-01', revision: 2, schedule: null,
  });
  assert.equal(page.get('shiftSaveButton').textContent, 'シフトを登録');
  assert.equal(page.get('shiftDeleteButton').hidden, true);
});

test('a lost response is resolved by rereading the exact resulting revision without resending', async () => {
  const state = { employeeId: 'EMP-01', revision: 0, schedule: null };
  const page = makePage({ initialState: state, mutationFailure: 'after' });
  await page.context.load(false);
  page.get('shiftStart').value = '09:00';
  page.get('shiftEnd').value = '17:00';
  await page.get('shiftForm').handlers.submit({ preventDefault() {} });
  assert.match(page.get('status').textContent, /保存済みであること/);
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 1);
});

test('an unresolved mutation is not automatically resent after rereading unchanged state', async () => {
  const state = { employeeId: 'EMP-01', revision: 0, schedule: null };
  const page = makePage({ initialState: state, mutationFailure: 'before' });
  await page.context.load(false);
  page.get('shiftStart').value = '09:00';
  page.get('shiftEnd').value = '17:00';
  await page.get('shiftForm').handlers.submit({ preventDefault() {} });
  assert.match(page.get('status').textContent, /再送せず/);
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 1);
});

test('an ambiguous mutation is not confirmed from a different selected date', async () => {
  const state = { employeeId: 'EMP-01', revision: 0, schedule: null };
  const page = makePage({ initialState: state, mutationFailure: 'after-switch' });
  await page.context.load(false);
  page.get('shiftStart').value = '09:00';
  page.get('shiftEnd').value = '17:00';
  await page.get('shiftForm').handlers.submit({ preventDefault() {} });
  assert.doesNotMatch(page.get('status').textContent, /保存済みであること/);
  assert.match(page.get('status').textContent, /再送せず/);
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 1);
});

test('attendance state for a different date is rejected', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', revision: 0, schedule: null }, responseWorkDate: '2026-10-06' });
  const result = await page.context.load(false);
  assert.equal(result, null);
  assert.equal(vm.runInContext('shiftState', page.context), null);
});
