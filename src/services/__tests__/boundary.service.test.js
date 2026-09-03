const test = require('node:test');
const assert = require('node:assert/strict');
const boundary = require('../boundary.service');

test.afterEach(() => {
  boundary.listRules().forEach((r) => boundary.deleteRule(r.id));
});

test('createRule rejects an unknown ruleType', () => {
  assert.throws(
    () =>
      boundary.createRule({
        ruleType: 'nope',
        value: 'x',
        enforcementMode: 'complete_exclusion',
      }),
    { code: 'INVALID_RULE_TYPE' }
  );
});

test('createRule rejects an unknown enforcementMode', () => {
  assert.throws(
    () =>
      boundary.createRule({
        ruleType: 'contact',
        value: 'a@b.com',
        enforcementMode: 'nope',
      }),
    { code: 'INVALID_ENFORCEMENT_MODE' }
  );
});

test('createRule rejects an empty/whitespace-only value', () => {
  assert.throws(
    () =>
      boundary.createRule({
        ruleType: 'contact',
        value: '   ',
        enforcementMode: 'complete_exclusion',
      }),
    { code: 'INVALID_RULE_VALUE' }
  );
});

test('createRule rejects catastrophic-backtracking keyword patterns', () => {
  assert.throws(
    () =>
      boundary.createRule({
        ruleType: 'keyword',
        value: '(a+)+$',
        enforcementMode: 'search_only',
      }),
    { code: 'PATTERN_TOO_COMPLEX' }
  );
});

test('createRule rejects an invalid regular expression', () => {
  assert.throws(
    () =>
      boundary.createRule({
        ruleType: 'keyword',
        value: '(unclosed',
        enforcementMode: 'search_only',
      }),
    { code: 'INVALID_PATTERN' }
  );
});

test('createRule rejects an overly long keyword pattern', () => {
  assert.throws(
    () =>
      boundary.createRule({
        ruleType: 'keyword',
        value: 'a'.repeat(201),
        enforcementMode: 'search_only',
      }),
    { code: 'PATTERN_TOO_LONG' }
  );
});

test('createRule accepts a safe keyword pattern', () => {
  const rule = boundary.createRule({
    ruleType: 'keyword',
    value: 'M&A Falcon',
    enforcementMode: 'search_only',
  });
  assert.equal(rule.ruleType, 'keyword');
  assert.ok(rule.id.startsWith('boundary_'));
});

test('folder rule matches the folder itself and subfolders, not a similarly-named sibling', () => {
  boundary.createRule({
    ruleType: 'folder',
    value: '/HR',
    enforcementMode: 'complete_exclusion',
  });
  assert.equal(
    boundary.getEnforcementForThread({ folder: '/HR', participants: [], subject: '' }),
    'complete_exclusion'
  );
  assert.equal(
    boundary.getEnforcementForThread({
      folder: '/HR/Compensation',
      participants: [],
      subject: '',
    }),
    'complete_exclusion'
  );
  assert.equal(
    boundary.getEnforcementForThread({ folder: '/HRX', participants: [], subject: '' }),
    null
  );
  assert.equal(
    boundary.getEnforcementForThread({ participants: [], subject: '' }),
    null
  );
});

test('contact rule matches case-insensitively', () => {
  boundary.createRule({
    ruleType: 'contact',
    value: 'Jane@Med.com',
    enforcementMode: 'complete_exclusion',
  });
  assert.equal(
    boundary.getEnforcementForThread({
      participants: ['priya@abc.com', 'jane@med.com'],
      subject: '',
    }),
    'complete_exclusion'
  );
});

test('domain rule matches any participant on that domain, with or without the *@ prefix', () => {
  boundary.createRule({
    ruleType: 'domain',
    value: '*@legal-counsel.com',
    enforcementMode: 'search_only',
  });
  assert.equal(
    boundary.getEnforcementForThread({
      participants: ['priya@abc.com', 'x@legal-counsel.com'],
      subject: '',
    }),
    'search_only'
  );
  assert.equal(
    boundary.getEnforcementForThread({
      participants: ['priya@abc.com', 'x@other.com'],
      subject: '',
    }),
    null
  );
});

test('keyword rule matches the subject case-insensitively', () => {
  boundary.createRule({
    ruleType: 'keyword',
    value: 'M&A Falcon',
    enforcementMode: 'search_only',
  });
  assert.equal(
    boundary.getEnforcementForThread({
      participants: [],
      subject: 'RE: m&a falcon update',
    }),
    'search_only'
  );
});

test('the most restrictive matching mode wins when multiple rules match one thread', () => {
  boundary.createRule({
    ruleType: 'domain',
    value: '*@vendor.com',
    enforcementMode: 'no_external_actions',
  });
  boundary.createRule({
    ruleType: 'keyword',
    value: 'confidential',
    enforcementMode: 'complete_exclusion',
  });
  const thread = {
    participants: ['priya@abc.com', 'x@vendor.com'],
    subject: 'CONFIDENTIAL update',
  };
  assert.equal(boundary.getEnforcementForThread(thread), 'complete_exclusion');
});

test('getEnforcementForContact only evaluates contact/domain rules, never folder/keyword/label', () => {
  boundary.createRule({
    ruleType: 'keyword',
    value: 'salary',
    enforcementMode: 'complete_exclusion',
  });
  boundary.createRule({
    ruleType: 'contact',
    value: 'jane@med.com',
    enforcementMode: 'complete_exclusion',
  });
  assert.equal(boundary.getEnforcementForContact('jane@med.com'), 'complete_exclusion');
  assert.equal(boundary.getEnforcementForContact('unrelated@abc.com'), null);
});

test('filterExcludedThreads drops only complete_exclusion matches', () => {
  boundary.createRule({
    ruleType: 'folder',
    value: '/HR',
    enforcementMode: 'complete_exclusion',
  });
  boundary.createRule({
    ruleType: 'domain',
    value: '*@vendor.com',
    enforcementMode: 'search_only',
  });
  const threads = [
    { threadId: 't1', folder: '/HR', participants: [], subject: '' },
    { threadId: 't2', participants: ['x@vendor.com'], subject: '' },
    { threadId: 't3', participants: [], subject: '' },
  ];
  const result = boundary.filterExcludedThreads(threads);
  assert.deepEqual(
    result.map((t) => t.threadId),
    ['t2', 't3']
  );
});

test('deleteRule removes a rule so it no longer matches', () => {
  const rule = boundary.createRule({
    ruleType: 'contact',
    value: 'a@b.com',
    enforcementMode: 'complete_exclusion',
  });
  assert.equal(boundary.getEnforcementForContact('a@b.com'), 'complete_exclusion');
  assert.equal(boundary.deleteRule(rule.id), true);
  assert.equal(boundary.getEnforcementForContact('a@b.com'), null);
});

test('deleteRule returns false for an unknown id', () => {
  assert.equal(boundary.deleteRule('boundary_does-not-exist'), false);
});
