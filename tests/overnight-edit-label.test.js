'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'schedule-configured-test.html'), 'utf8');
assert.match(html, /旧 ScheduleEvents API は廃止されました/);
assert.match(html, /href="\.\/index\.html"/);
assert.doesNotMatch(html, /<script\b/i, 'retired test page must not issue API calls');
assert.doesNotMatch(html, /SCHEDULE_SHEET_ID|ScheduleEvents.*(create|update|list)/);
console.log('PASS: retired schedule test page explains deprecation and links to the current attendance screen');
