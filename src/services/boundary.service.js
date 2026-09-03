const crypto = require('crypto');

// In-memory store — same pattern as action-state.service.js's `actions` Map.
// Fine for a single-instance hackathon demo; swap for a
// `hack_juggadexe_boundary_rules` table if you need persistence.
const RULES = new Map();

const RULE_TYPES = ['folder', 'contact', 'domain', 'keyword', 'label'];
const ENFORCEMENT_MODES = ['complete_exclusion', 'search_only', 'no_external_actions'];

// Higher number = more restrictive. When multiple rules match one thread or
// contact, the most restrictive mode wins — never the most permissive.
const MODE_STRICTNESS = {
  complete_exclusion: 3,
  search_only: 2,
  no_external_actions: 1,
};

// Lightweight ReDoS guard for user-supplied keyword patterns: reject the
// classic catastrophic-backtracking shapes (nested/alternated quantifiers)
// before a pattern is ever persisted or run against live mail. Not a full
// regex-safety analyzer — a deliberate, cheap first line of defense.
const UNSAFE_REGEX_SHAPES = [
  /\([^()]*[+*][^()]*\)[+*]/, // e.g. (a+)+, (a*)*
  /\([^()]*\|[^()]*\)[+*]{2,}/, // e.g. (a|a)++
];
const MAX_PATTERN_LENGTH = 200;

function assertSafeKeywordPattern(value) {
  if (value.length > MAX_PATTERN_LENGTH) {
    const err = new Error(
      `Keyword pattern exceeds ${MAX_PATTERN_LENGTH} characters.`
    );
    err.code = 'PATTERN_TOO_LONG';
    throw err;
  }
  if (UNSAFE_REGEX_SHAPES.some((shape) => shape.test(value))) {
    const err = new Error(
      'Keyword pattern is too complex (possible catastrophic backtracking).'
    );
    err.code = 'PATTERN_TOO_COMPLEX';
    throw err;
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(value, 'i');
  } catch (regexErr) {
    const err = new Error(
      `Keyword pattern is not a valid regular expression: ${regexErr.message}`
    );
    err.code = 'INVALID_PATTERN';
    throw err;
  }
}

function assertValidRule({ ruleType, value, enforcementMode }) {
  if (!RULE_TYPES.includes(ruleType)) {
    const err = new Error(
      `ruleType must be one of ${RULE_TYPES.join(', ')}, got "${ruleType}".`
    );
    err.code = 'INVALID_RULE_TYPE';
    throw err;
  }
  if (!ENFORCEMENT_MODES.includes(enforcementMode)) {
    const err = new Error(
      `enforcementMode must be one of ${ENFORCEMENT_MODES.join(', ')}, got "${enforcementMode}".`
    );
    err.code = 'INVALID_ENFORCEMENT_MODE';
    throw err;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    const err = new Error('value is required and must be a non-empty string.');
    err.code = 'INVALID_RULE_VALUE';
    throw err;
  }
  if (ruleType === 'keyword') {
    assertSafeKeywordPattern(value);
  }
}

function createRule({ ruleType, value, enforcementMode }) {
  assertValidRule({ ruleType, value, enforcementMode });

  const normalizedValue =
    ruleType === 'contact' || ruleType === 'domain' ? value.toLowerCase() : value;

  const rule = {
    id: `boundary_${crypto.randomUUID()}`,
    ruleType,
    value: normalizedValue,
    enforcementMode,
    createdAt: new Date().toISOString(),
  };
  RULES.set(rule.id, rule);
  return rule;
}

function listRules() {
  return Array.from(RULES.values());
}

function deleteRule(id) {
  return RULES.delete(id);
}

function domainOf(email) {
  return (email.split('@')[1] || '').toLowerCase();
}

// A folder rule protects its own path and every subfolder under it, but not
// a sibling with a similar-looking name — a rule on "/HR" must match
// "/HR/Compensation" but must NOT match "/HRX".
function folderMatches(ruleValue, threadFolder) {
  if (typeof threadFolder !== 'string') return false;
  return threadFolder === ruleValue || threadFolder.startsWith(`${ruleValue}/`);
}

// Mock threads carry `participants` as a plain email-string array; real
// TInboxThreadContext threads carry `participantDetails` as {email, name}
// objects instead. Accept either shape here so the same rule matching works
// against both without callers needing to normalize first.
function threadEmails(thread) {
  if (Array.isArray(thread.participants)) return thread.participants;
  return (thread.participantDetails || []).map((p) => p.email);
}

function ruleMatchesThread(rule, thread) {
  switch (rule.ruleType) {
    case 'folder':
      return folderMatches(rule.value, thread.folder);
    case 'contact':
      return threadEmails(thread).some((p) => p.toLowerCase() === rule.value);
    case 'domain': {
      const wantedDomain = rule.value.replace(/^\*@/, '');
      return threadEmails(thread).some((p) => domainOf(p) === wantedDomain);
    }
    case 'keyword':
      return new RegExp(rule.value, 'i').test(thread.subject || '');
    case 'label':
      return Array.isArray(thread.labels) && thread.labels.includes(rule.value);
    default:
      return false;
  }
}

// A bare contact/domain check, used to gate agentic actions where there is a
// recipient email but no thread object (e.g. a fresh follow-up draft). Folder,
// keyword, and label rules structurally cannot apply here — there is no
// thread to inspect — which is a real, honest limitation, not a bug.
function ruleMatchesContact(rule, email) {
  const normalized = email.toLowerCase();
  switch (rule.ruleType) {
    case 'contact':
      return rule.value === normalized;
    case 'domain':
      return domainOf(normalized) === rule.value.replace(/^\*@/, '');
    default:
      return false;
  }
}

function strictestMode(modes) {
  if (modes.length === 0) return null;
  return modes.reduce((strictest, mode) =>
    MODE_STRICTNESS[mode] > MODE_STRICTNESS[strictest] ? mode : strictest
  );
}

function getEnforcementForThread(thread) {
  const matchingModes = listRules()
    .filter((rule) => ruleMatchesThread(rule, thread))
    .map((rule) => rule.enforcementMode);
  return strictestMode(matchingModes);
}

function getEnforcementForContact(email) {
  const matchingModes = listRules()
    .filter((rule) => ruleMatchesContact(rule, email))
    .map((rule) => rule.enforcementMode);
  return strictestMode(matchingModes);
}

function filterExcludedThreads(threads) {
  return threads.filter(
    (thread) => getEnforcementForThread(thread) !== 'complete_exclusion'
  );
}

module.exports = {
  createRule,
  listRules,
  deleteRule,
  getEnforcementForThread,
  getEnforcementForContact,
  filterExcludedThreads,
  RULE_TYPES,
  ENFORCEMENT_MODES,
};
