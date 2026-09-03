const test = require('node:test');
const assert = require('node:assert/strict');
const { getWaitingOn } = require('../waiting-on.service');
const boundary = require('../boundary.service');

test.afterEach(() => {
  boundary.listRules().forEach((r) => boundary.deleteRule(r.id));
});

test('returns all waiting threads when no boundary rules exist', () => {
  const items = getWaitingOn();
  assert.equal(
    items.some((i) => i.threadId === 't4'),
    true
  );
});

test('a complete_exclusion folder rule redacts the matching thread instead of removing it', () => {
  boundary.createRule({
    ruleType: 'folder',
    value: '/HR/Compensation',
    enforcementMode: 'complete_exclusion',
  });
  const items = getWaitingOn();
  const item = items.find((i) => i.threadId === 't4');
  assert.ok(item, 'redacted item must still be present, not dropped');
  assert.equal(item.redacted, true);
  assert.equal(item.zoneLabel, 'HR/Compensation');
  assert.equal(item.subject, undefined);
  assert.equal(item.waitingOn, undefined);
  assert.equal(item.waitingOnEmail, undefined);
  assert.equal(typeof item.daysWaiting, 'number');
  assert.ok(['low', 'medium', 'high'].includes(item.urgency));
});

test('a non-redacted item is explicitly marked redacted: false', () => {
  const items = getWaitingOn();
  const item = items.find((i) => i.threadId === 't4');
  assert.equal(item.redacted, false);
});

test('a search_only rule does not redact the thread — search stays allowed', () => {
  boundary.createRule({
    ruleType: 'folder',
    value: '/HR/Compensation',
    enforcementMode: 'search_only',
  });
  const items = getWaitingOn();
  const item = items.find((i) => i.threadId === 't4');
  assert.ok(item);
  assert.equal(item.redacted, false);
  assert.equal(item.subject !== undefined, true);
});
