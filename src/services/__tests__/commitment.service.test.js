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

test('a complete_exclusion folder rule redacts the commitment instead of removing it', () => {
  boundary.createRule({
    ruleType: 'folder',
    value: '/HR',
    enforcementMode: 'complete_exclusion',
  });
  const items = getCommitments();
  const item = items.find((i) => i.threadId === 't4');
  assert.ok(item, 'redacted commitment must still be present, not dropped');
  assert.equal(item.redacted, true);
  assert.equal(item.zoneLabel, 'HR');
  assert.equal(item.subject, undefined);
  assert.equal(item.person, undefined);
  assert.equal(item.personEmail, undefined);
  assert.equal(item.commitmentText, undefined);
  assert.equal(item.status, 'pending');
  assert.ok(['outgoing', 'incoming'].includes(item.direction));
});

test('a non-redacted commitment is explicitly marked redacted: false', () => {
  const items = getCommitments();
  const item = items.find((i) => i.threadId === 't4');
  assert.equal(item.redacted, false);
});
