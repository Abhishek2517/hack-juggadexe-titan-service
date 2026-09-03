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

test('a complete_exclusion folder rule removes the matching thread from the result', () => {
  boundary.createRule({
    ruleType: 'folder',
    value: '/HR/Compensation',
    enforcementMode: 'complete_exclusion',
  });
  const items = getWaitingOn();
  assert.equal(
    items.some((i) => i.threadId === 't4'),
    false
  );
});

test('includeExcluded:true still returns the excluded thread, for counting only', () => {
  boundary.createRule({
    ruleType: 'folder',
    value: '/HR/Compensation',
    enforcementMode: 'complete_exclusion',
  });
  const items = getWaitingOn(undefined, undefined, undefined, { includeExcluded: true });
  assert.equal(
    items.some((i) => i.threadId === 't4'),
    true
  );
});

test('a search_only rule does not remove the thread — search stays allowed', () => {
  boundary.createRule({
    ruleType: 'folder',
    value: '/HR/Compensation',
    enforcementMode: 'search_only',
  });
  const items = getWaitingOn();
  assert.equal(
    items.some((i) => i.threadId === 't4'),
    true
  );
});
