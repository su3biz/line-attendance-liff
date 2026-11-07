'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scriptMatch = html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'existing root page has an inline LIFF script');
const script = scriptMatch[1];
const ISOLATED_GAS_V1_URL = 'https://script.google.com/macros/s/AKfycbxHVd1T5gwIN7EwpOgO3zrcOLT40DvlXe-4-SyHTOF2mAIfpUMXz8ac1GaekuY7CGti/exec';

test('existing root keeps the DEV LIFF identity and is pinned only to isolated GAS v1', () => {
  assert.match(script, /const LIFF_ID='2012227652-CgVMkyBb';/);
  assert.match(script, new RegExp(`const GAS_URL='${ISOLATED_GAS_V1_URL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}';`));
  const endpoints = [...html.matchAll(/https:\/\/script\.google\.com\/macros\/s\/[^/'"\\s]+\/exec/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(endpoints)], [ISOLATED_GAS_V1_URL]);
  assert.equal((script.match(/\bfetch\s*\(/g) || []).length, 1);
  assert.match(script, /fetch\(GAS_URL,/);
});

test('existing root contains the Phase 2 shift create, update, and delete controls', () => {
  for (const id of ['shiftCard', 'shiftForm', 'shiftStart', 'shiftEnd', 'shiftSaveButton', 'shiftDeleteButton']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(script, /action:'shiftMutation'/);
  assert.match(script, /\['create','update','delete'\]/);
});

test('existing LINE authentication and attendance actions remain in the root page', () => {
  assert.match(script, /liff\.init\(\{liffId:LIFF_ID\}\)/);
  assert.match(script, /liff\.login\(\)/);
  assert.match(script, /liff\.getIDToken\(\)/);
  for (const action of ["action:'attendanceList'", "action:'saveActual'", "action:'register'"]) {
    assert.ok(script.includes(action), `existing action ${action} remains available`);
  }
  assert.match(html, /id="workDate"/);
});
