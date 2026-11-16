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

function makePage({ initialState, confirm = true, mutationFailure = null, responseWorkDate = null, dateClass = 'future', actorRole = 'employee', disabledActions = [], shiftWritesEnabled = true, attendanceWritesEnabled = true, attendanceRecords = [] } = {}) {
  const elements = new Map();
  const requests = [];
  const confirmMessages = [];
  const stored = new Map();
  let id = 0;
  const get = (name) => {
    if (!elements.has(name)) elements.set(name, element());
    return elements.get(name);
  };
  const nextState = { stateToken: 'a'.repeat(64), ...initialState };
  const currentRecords = attendanceRecords.map((record) => ({ ...record, schedule: record.schedule && { ...record.schedule }, attendance: record.attendance && { ...record.attendance } }));
  const location = { href: 'https://example.test/liff', search: '', reload() {} };
  const context = vm.createContext({
    document: {
      getElementById: get,
      createElement: (tagName) => Object.assign(element(), { tagName }),
      createTextNode: (textContent) => ({ textContent }),
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
    crypto: { randomUUID: () => `request-${String(++id).padStart(4, '0')}` },
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
        return { ok: true, json: async () => ({ ok: true, code: 'SAVED', employeeId: fields.employeeId, workDate: fields.workDate,
          schedule: updated.schedule, attendance: updated.attendance, revision: updated.revision, attendanceUpdated: dateClass !== 'future' }) };
      }
      if (fields.action === 'register') {
        if (disabledActions.includes('register')) return { ok: true, json: async () => ({ ok: false, code: 'DISABLED' }) };
        throw new Error('unexpected register action');
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
  return { context, get, requests, confirmMessages };
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

test('employee can create a shift through the current entry form with the authenticated identity and revision', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 2, schedule: null, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';
  page.get('endTime').value = '17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  const request = page.requests.find((item) => item.action === 'shiftMutation');
  assert.deepEqual(request, {
    id_token: 'test-line-id-token', action: 'shiftMutation', type: 'create', employeeId: 'EMP-01', workDate: '2026-10-05',
    expectedRevision: '2', expectedStateToken: 'a'.repeat(64), requestId: 'request-0001', startTime: '09:00', endTime: '17:00',
  });
  assert.equal(page.requests.filter((item) => item.action === 'attendanceList').length, 1);
  assert.equal(vm.runInContext('entryState.revision', page.context), 3);
  assert.equal(page.get('saveButton').disabled, false);
});

test('employee can save an initially empty day from the confirmed mutation response', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';
  page.get('endTime').value = '17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 1);
  assert.equal(vm.runInContext('entryState.revision', page.context), 0);
  assert.equal(vm.runInContext('entryState.schedule.startTime', page.context), '09:00');
  assert.equal(page.get('status').textContent, '保存しました。');
  assert.equal(page.get('connectionError').hidden, true);
});

test('employee update uses the current schedule revision', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 4, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '10:00';
  page.get('endTime').value = '18:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  const request = page.requests.find((item) => item.action === 'shiftMutation');
  assert.equal(request.type, 'update');
  assert.equal(request.expectedRevision, '4');
  assert.equal(request.startTime, '10:00');
  assert.equal(request.endTime, '18:00');
});


test('a stale state token does not cause a conflict retry or post-save reload', async () => {
  const page = makePage({
    initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 4, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: null },
  });
  await page.context.load(false);
  page.get('startTime').value = '10:00'; page.get('endTime').value = '18:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  const mutations = page.requests.filter((item) => item.action === 'shiftMutation');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].expectedStateToken, 'a'.repeat(64));
  assert.equal(page.requests.filter((item) => item.action === 'attendanceList').length, 1);
  assert.equal(page.get('startTime').value, '10:00');
  assert.equal(page.get('endTime').value, '18:00');
  assert.equal(page.get('status').textContent, '保存しました。');
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

test('shift deletion asks for confirmation and sends no mutation when cancelled', async () => {
  const page = makePage({ confirm: false, initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: null } });
  await page.context.load(false);
  await page.get('deleteButton').handlers.click();
  assert.equal(page.requests.some((item) => item.action === 'shiftMutation'), false);
});

test('confirmed deletion sends one revisioned mutation and verifies by rereading attendanceList', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: { startTime: '08:55', endTime: '17:05' } } });
  await page.context.load(false);
  await page.get('deleteButton').handlers.click();
  assert.match(page.confirmMessages[0], /2026-10-05/);
  assert.match(page.confirmMessages[0], /シフト表・勤怠実績/);
  const request = page.requests.find((item) => item.action === 'shiftMutation');
  assert.equal(request.type, 'delete');
  assert.equal(request.expectedRevision, '1');
  assert.equal(request.startTime, '');
  assert.equal(request.endTime, '');
  assert.equal(page.requests.filter((item) => item.action === 'attendanceList').length, 1);
  assert.equal(vm.runInContext('entryState.schedule', page.context), null);
  assert.equal(vm.runInContext('entryState.attendance', page.context), null);
  assert.equal(page.get('status').textContent, '削除しました。');
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 1);
});

test('actual-only day can delete the actual record and preserve the empty schedule', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: { startTime: '08:55', endTime: '17:05' } } });
  await page.context.load(false);
  assert.equal(page.get('deleteButton').disabled, false);
  await page.get('deleteButton').handlers.click();
  assert.match(page.confirmMessages[0], /勤怠実績を削除/);
  assert.doesNotMatch(page.confirmMessages[0], /シフト表・/);
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 1);
  assert.equal(vm.runInContext('entryState.schedule', page.context), null);
  assert.equal(vm.runInContext('entryState.attendance', page.context), null);
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

test('either single schedule endpoint remains deletable and delete clears the whole schedule', async () => {
  for (const schedule of [{ startTime: '09:00', endTime: '' }, { startTime: '', endTime: '17:00' }]) {
    const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 2, schedule, attendance: null } });
    await page.context.load(false);
    assert.equal(page.get('deleteButton').disabled, false);
    assert.equal(page.get('startTime').value, schedule.startTime);
    assert.equal(page.get('endTime').value, schedule.endTime);
    await page.get('deleteButton').handlers.click();
    assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 1);
    assert.equal(page.requests.find((item) => item.action === 'shiftMutation').type, 'delete');
    assert.equal(vm.runInContext('entryState.schedule', page.context), null);
    assert.equal(vm.runInContext('entryState.attendance', page.context), null);
    assert.equal(page.get('status').textContent, '削除しました。');
  }
});

test('schedule-only deletion clears schedule while attendance remains empty', async () => {
  const page = makePage({ initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: { startTime: '09:00', endTime: '17:00' }, attendance: null } });
  await page.context.load(false);
  await page.get('deleteButton').handlers.click();
  assert.match(page.confirmMessages[0], /シフト表を削除/);
  assert.doesNotMatch(page.confirmMessages[0], /勤怠実績を削除/);
  assert.equal(vm.runInContext('entryState.schedule', page.context), null);
  assert.equal(vm.runInContext('entryState.attendance', page.context), null);
});

test('past and today saves update both records while future saves preserve actual-only data', async () => {
  for (const dateClass of ['past', 'today']) {
    const page = makePage({ dateClass, initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
    await page.context.load(false);
    page.get('startTime').value = '09:00'; page.get('endTime').value = '17:00';
    await page.get('entryForm').handlers.submit({ preventDefault() {} });
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('entryState.schedule', page.context))), { startTime: '09:00', endTime: '17:00' });
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('entryState.attendance', page.context))), { startTime: '09:00', endTime: '17:00' });
  }
  const priorAttendance = { startTime: '08:55', endTime: '17:05' };
  const future = makePage({ dateClass: 'future', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: priorAttendance } });
  await future.context.load(false);
  assert.equal(future.get('startTime').value, priorAttendance.startTime, 'case 4 displays actual times');
  assert.equal(future.get('endTime').value, priorAttendance.endTime);
  future.get('startTime').value = '10:00'; future.get('endTime').value = '18:00';
  await future.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('entryState.schedule', future.context))), { startTime: '10:00', endTime: '18:00' });
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
  let request = page.requests.find((item) => item.action === 'shiftMutation');
  assert.equal(request.startTime, '08:55');
  assert.equal(request.endTime, '17:05');
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('entryState.schedule', page.context))), { startTime: '08:55', endTime: '17:05' });

  const oneSided = makePage({ dateClass: 'past', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: { startTime: '08:55', endTime: '17:05' }, attendance: { startTime: '08:55', endTime: '17:05' } } });
  await oneSided.context.load(false);
  oneSided.get('startTime').value = '09:15';
  await oneSided.get('entryForm').handlers.submit({ preventDefault() {} });
  request = oneSided.requests.find((item) => item.action === 'shiftMutation');
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

test('overnight employee schedule continues to save and display with the next-day label', async () => {
  const page = makePage({ dateClass: 'future', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: { startTime: '22:00', endTime: '02:00' }, attendance: null } });
  await page.context.load(false);
  assert.match(page.get('plannedTime').textContent, /22:00–02:00（翌日）/);
  page.get('startTime').value = '22:15'; page.get('endTime').value = '02:45';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  const request = page.requests.find((item) => item.action === 'shiftMutation');
  assert.equal(request.startTime, '22:15');
  assert.equal(request.endTime, '02:45');
  assert.match(page.get('plannedTime').textContent, /22:15–02:45（翌日）/);
});

test('a lost mutation response is resolved by rereading state without resending', async () => {
  const page = makePage({ mutationFailure: 'after', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';
  page.get('endTime').value = '17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.match(page.get('status').textContent, /保存結果を.*再取得で確認しました/);
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 1);
});

test('a mutation outcome is not confirmed from a different date selected during the request', async () => {
  const page = makePage({ mutationFailure: 'after-switch', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';
  page.get('endTime').value = '17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.doesNotMatch(page.get('status').textContent, /再取得で確認しました/);
  assert.match(page.get('connectionErrorMessage').textContent, /再保存せず/);
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 1);
});

test('an unresolved mutation is not retried and reports the uncertain result', async () => {
  const page = makePage({ mutationFailure: 'before', initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 0, schedule: null, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';
  page.get('endTime').value = '17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.match(page.get('connectionErrorMessage').textContent, /再保存せず/);
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 1);
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

test('DISABLED shift mutation is shown distinctly and never resends the mutation', async () => {
  const page = makePage({ disabledActions: ['shiftMutation'], initialState: { employeeId: 'EMP-01', displayName: '本人', revision: 1, schedule: null, attendance: null } });
  await page.context.load(false);
  page.get('startTime').value = '09:00';
  page.get('endTime').value = '17:00';
  await page.get('entryForm').handlers.submit({ preventDefault() {} });
  assert.equal(page.get('connectionError').hidden, true);
  assert.equal(page.get('status').textContent, '機能が停止中です。');
  assert.equal(page.requests.filter((item) => item.action === 'shiftMutation').length, 1);
  assert.equal(page.requests.filter((item) => item.action === 'attendanceList').length, 1, 'only initial load fetches attendance state');
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
  assert.match(html, /<button id="saveButton" type="submit">保存<\/button>/);
  assert.match(html, /<label>開始 /);
  assert.match(html, /<label>終了 /);
  assert.doesNotMatch(html, /id="shiftForm"/);
});
