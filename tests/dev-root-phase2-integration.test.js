'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scriptMatch = html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'root page has an inline LIFF script');
const script = scriptMatch[1];
const DEV_GAS_URL = 'https://script.google.com/macros/s/AKfycbx4hCvYIKhSJlnDpGaKAUTk8iiEkvWaxfp957GDirqv3dam6rhloMM9FDAmP4VQtMPS/exec';

test('DEV root uses the current LIFF identity and one current DEV GAS endpoint', () => {
  assert.match(script, /const LIFF_ID='2012227652-CgVMkyBb';/);
  assert.match(script, new RegExp(`const GAS_URL='${DEV_GAS_URL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}';`));
  const endpoints = [...html.matchAll(/https:\/\/script\.google\.com\/macros\/s\/[^/'"]+\/exec/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(endpoints)], [DEV_GAS_URL], 'no stale DEV GAS endpoints remain in the root');
  assert.equal((script.match(/\bfetch\s*\(/g) || []).length, 1);
  assert.match(script, /fetch\(GAS_URL,/);
});

test('root uses Phase 2 shift mutation and the existing attendance response model', () => {
  for (const id of ['entryCard', 'entryForm', 'startTime', 'endTime', 'saveButton', 'deleteButton']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(script, /action:'shiftMutation'/);
  assert.match(script, /action:'attendanceList'/);
  assert.match(script, /entryState=\{/);
  assert.doesNotMatch(script, /action:'saveActual'/, 'the current UI saves through shiftMutation');
  assert.doesNotMatch(html, /id=["']shiftForm["']/);
});

test('authentication recovery and error display use the current screen without exposing a Sub ID', () => {
  assert.match(script, /ensureFreshIdToken\(\)/);
  assert.match(script, /AUTH_RECOVERY_SESSION_KEY/);
  assert.match(script, /liff\.login\(\{redirectUri:window\.location\.href\}\)/);
  assert.match(script, /function showConnectionError\(/);
  assert.match(script, /diagnosticEnabled/);
  assert.doesNotMatch(html, /アクセス中のLINE Sub ID|id=["']lineSubId["']/);
});
