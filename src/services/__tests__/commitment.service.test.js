const test = require('node:test');
const assert = require('node:assert/strict');
const { getCommitments } = require('../commitment.service');
const boundary = require('../boundary.service');

test.afterEach(() => {
  boundary.listRules().forEach((r) => boundary.deleteRule(r.id));
});

test('returns the known commitment when no boundary rules exist', () => {
  const items = getCommitments();
  assert.equal(
    items.some((i) => i.threadId === 't4'),
    true
  );
});

test('a complete_exclusion folder rule removes the commitment from the result', () => {
  boundary.createRule({
    ruleType: 'folder',
    value: '/HR',
    enforcementMode: 'complete_exclusion',
  });
  const items = getCommitments();
  assert.equal(
    items.some((i) => i.threadId === 't4'),
    false
  );
});

test('includeExcluded:true still returns it, for counting only', () => {
  boundary.createRule({
    ruleType: 'folder',
    value: '/HR',
    enforcementMode: 'complete_exclusion',
  });
  const items = getCommitments(undefined, undefined, undefined, { includeExcluded: true });
  assert.equal(
    items.some((i) => i.threadId === 't4'),
    true
  );
});
