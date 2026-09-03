const test = require('node:test');
const assert = require('node:assert/strict');
const boundary = require('../boundary.service');
const llmService = require('../llm.service');

// classifyAndAnswer is the only OpenAI-calling piece of answerQuery — swap
// it for a stub that always classifies as 'attention', so this file can
// exercise the REAL waiting-on/needs-response/commitments/boundary pipeline
// without a network call or an API key. Must happen before the first
// require of '../ask-titan.service' below: that file destructures
// `classifyAndAnswer` off this same (singleton, cached-by-path) module
// object at require time, so the patched function has to already be in
// place when that require runs.
const originalClassifyAndAnswer = llmService.classifyAndAnswer;
llmService.classifyAndAnswer = async () => ({
  category: 'attention',
  answer: 'stub answer',
  matchingThreadIds: [],
});

const { answerQuery } = require('../ask-titan.service');

test.after(() => {
  llmService.classifyAndAnswer = originalClassifyAndAnswer;
});

test.afterEach(() => {
  boundary.listRules().forEach((r) => boundary.deleteRule(r.id));
});

const CURRENT_USER_EMAIL = 'me@abc.com';

// N days + a couple hours ago — the couple-hours pad keeps
// Math.floor((now - t) / 1 day) landing on exactly N regardless of the few
// milliseconds this test takes to run, without any real chance of drifting
// to N+1.
function daysAgoIso(n) {
  return new Date(Date.now() - (n * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000)).toISOString();
}

// A thread where the OTHER party sent last (getNeedsResponseFromReal's own
// eligibility rule) — lastMessageSentTimestamp omitted entirely so the
// "other party's message is the last one" branch is unambiguous.
function needsResponseThread(threadId, otherEmail, daysWaiting) {
  return {
    threadId,
    subject: `Subject for ${threadId}`,
    participantDetails: [
      { name: 'Me', email: CURRENT_USER_EMAIL },
      { name: otherEmail, email: otherEmail },
    ],
    lastMessageReceivedTimestamp: daysAgoIso(daysWaiting),
    snippet: 'a real snippet',
  };
}

test('attention digest: boundary skippedCount matches only what the digest cap actually renders as redacted, not a redacted item the cap cut off entirely', async () => {
  // 10 threads fit inside the digest's own needs-response cap
  // (ATTENTION_DIGEST_NEEDS_RESPONSE_LIMIT = 10): one redacted (0 days old,
  // sorts first), nine ordinary ones (1-9 days old). An 11th, older (20
  // days) thread is ALSO redacted but sorts past the cap.
  boundary.createRule({
    ruleType: 'contact',
    value: 'blocked-in-cap@zone.com',
    enforcementMode: 'complete_exclusion',
  });
  boundary.createRule({
    ruleType: 'contact',
    value: 'blocked-outside-cap@zone.com',
    enforcementMode: 'complete_exclusion',
  });

  const inCapRedacted = needsResponseThread('t-in-cap', 'blocked-in-cap@zone.com', 0);
  const ordinary = Array.from({ length: 9 }, (_, i) =>
    needsResponseThread(`t-normal-${i}`, `person${i}@abc.com`, i + 1)
  );
  const outsideCapRedacted = needsResponseThread(
    't-outside-cap',
    'blocked-outside-cap@zone.com',
    20
  );

  const realThreads = [inCapRedacted, ...ordinary, outsideCapRedacted];

  const result = await answerQuery(
    'what needs my attention today',
    realThreads,
    [],
    [],
    [],
    CURRENT_USER_EMAIL
  );

  const allShownNeedsResponse = [
    ...result.data.urgentNeedsResponse,
    ...result.data.needsResponse,
  ];

  // The 20-day-old redacted thread never made the top-10 cap — it must not
  // appear anywhere in what's actually rendered, redacted or otherwise.
  assert.equal(
    allShownNeedsResponse.some((i) => i.threadId === 't-outside-cap'),
    false
  );
  // The 0-day-old redacted thread DID make the cap — it must be present and
  // redacted (not silently dropped, not shown in full).
  const shownRedacted = allShownNeedsResponse.find((i) => i.threadId === 't-in-cap');
  assert.ok(shownRedacted);
  assert.equal(shownRedacted.redacted, true);

  // Exactly 1 redacted needs-response card is actually rendered (t-in-cap);
  // t-outside-cap is invisible to the digest entirely (cut by the cap, same
  // as any other 11th-oldest item would be) — the boundary notice must
  // count only the one the user can actually see, not the one the cap
  // already excluded for unrelated reasons.
  assert.equal(result.boundary.skippedCount, 1);
});
