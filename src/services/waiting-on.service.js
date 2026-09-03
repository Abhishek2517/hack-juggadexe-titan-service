const mailbox = require('../data/mailbox.mock.json');
const { filterExcludedThreads, getEnforcementForThread } = require('./boundary.service');

// Mock data's dates are all relative to this fixed anchor. Real data uses
// the actual current time instead (see getWaitingOnFromReal).
const MOCK_NOW = new Date('2026-09-02T09:00:00Z');

function daysSince(dateStr, now) {
  const ms = now - new Date(dateStr);
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// Real message bodies are rich-text HTML — strip tags before keyword
// matching, same reasoning as commitment.service.js's stripHtml.
function stripHtml(body) {
  return (body || '').replace(/<[^>]*>/g, ' ');
}

const WAITING_KEYWORD_PATTERN = /\bwaiting\b/i;
// "Sent with some information" — a real message, not a blank/near-blank
// one. Filters out trivial sends (e.g. just a signature) that shouldn't
// count as "asked something and got no reply".
const MIN_SUBSTANTIVE_BODY_LENGTH = 15;
function hasSubstantiveContent(strippedBody) {
  return strippedBody.replace(/\s+/g, ' ').trim().length >= MIN_SUBSTANTIVE_BODY_LENGTH;
}

// Explicit deadline/urgency language — a second, independent signal from
// daysWaiting. Checked ONLY against the thread's current pending message
// (see computeUrgency's callers below), never the whole thread history.
const URGENT_LANGUAGE_PATTERN =
  /urgent|asap|as soon as possible|immediately|right away|by end of day|by eod|by today|need this today/i;
function hasUrgentLanguage(strippedText) {
  return URGENT_LANGUAGE_PATTERN.test(strippedText);
}

/**
 * urgency = 'high' if EITHER signal fires: daysWaiting >= 3 (existing), or
 * the pending message text has explicit urgency language (new) — a
 * brand-new message (daysWaiting=0) with "need this today" should still be
 * high immediately. `pendingText` must already be scoped by the caller to
 * ONLY the thread's current pending message (see the critical direction
 * rule on getWaitingOnFromThreadTimestamps/getNeedsResponseFromReal below)
 * — never earlier history, and never a message from the wrong party.
 */
function computeUrgency(days, pendingText) {
  if (days >= 3 || hasUrgentLanguage(pendingText)) return 'high';
  if (days >= 1) return 'medium';
  return 'low';
}

/**
 * Most recent message in `messages` for `threadId` sent by `fromEmail`,
 * HTML-stripped. Returns '' (not found) when the specific message isn't in
 * the local-cache batch we have — callers fall back to the thread's own
 * snippet, which already represents its most recent message's preview.
 */
function findLatestMessageBodyFrom(messages, threadId, fromEmail) {
  const candidates = (messages || [])
    .filter((m) => m.threadId === threadId && m.fromEmail === fromEmail)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  return candidates.length > 0 ? stripHtml(candidates[0].body) : '';
}

/**
 * A thread counts as "waiting on" when the user sent the last message
 * and no one has replied since. This is deterministic — no LLM needed.
 *
 * Threads under a "complete_exclusion" boundary rule are dropped before
 * they're ever mapped/returned, unless `includeExcluded` is set — used only
 * by callers that need the pre-filter count (e.g. the Ask Titan boundary
 * banner), never to surface excluded content itself.
 */
function getWaitingOnFromMock(includeExcluded) {
  let threads = mailbox.threads.filter((t) => t.lastReplyFrom === mailbox.user.email);
  if (!includeExcluded) threads = filterExcludedThreads(threads);
  return threads
    .map((t) => {
      const lastMsg = t.messages[t.messages.length - 1];
      const otherPerson = t.participants.find((p) => p !== mailbox.user.email);
      const contact = mailbox.contacts[otherPerson];
      const days = daysSince(lastMsg.sentAt, MOCK_NOW);
      // lastMsg is guaranteed to be the user's own message here (that's
      // what the filter above requires) — the correct "pending message" to
      // scan for urgent language in this direction.
      return {
        threadId: t.threadId,
        subject: t.subject,
        waitingOn: contact ? contact.name : otherPerson,
        waitingOnEmail: otherPerson,
        daysWaiting: days,
        urgency: computeUrgency(days, stripHtml(lastMsg.body || '')),
      };
    })
    .sort((a, b) => b.daysWaiting - a.daysWaiting);
}

/**
 * Same rule as the mock version ("user sent the last message and no one
 * has replied since"), expressed against real TInboxThreadContext shape:
 * the thread's own lastMessageSentTimestamp/lastMessageReceivedTimestamp
 * already tell us who sent the most recent message, with no need to walk
 * individual messages for the direction check itself.
 *
 * Direction rule for the urgency keyword signal: only ever scan the user's
 * OWN most recent message (the one awaiting a reply) — never the other
 * party's, never earlier history. This function's own eligibility filter
 * already guarantees the thread's last message is the user's, so looking
 * up "the user's most recent message in this thread" here can't drift to
 * the wrong message.
 */
function getWaitingOnFromThreadTimestamps(
  realThreads,
  realMessages,
  currentUserEmail,
  includeExcluded
) {
  const now = new Date();
  return (realThreads || [])
    .filter((t) => {
      if (!includeExcluded && getEnforcementForThread(t) === 'complete_exclusion') {
        return false;
      }
      if (!t.lastMessageSentTimestamp) return false;
      if (!t.lastMessageReceivedTimestamp) return true;
      return (
        new Date(t.lastMessageSentTimestamp) >
        new Date(t.lastMessageReceivedTimestamp)
      );
    })
    .map((t) => {
      const other = (t.participantDetails || []).find(
        (p) => p.email !== currentUserEmail
      );
      const days = daysSince(t.lastMessageSentTimestamp, now);
      const pendingText =
        findLatestMessageBodyFrom(realMessages, t.threadId, currentUserEmail) ||
        stripHtml(t.snippet || '');
      return {
        threadId: t.threadId,
        subject: t.subject,
        waitingOn: other ? other.name : t.sender || 'Unknown',
        waitingOnEmail: other ? other.email : '',
        daysWaiting: days,
        urgency: computeUrgency(days, pendingText),
      };
    });
}

/**
 * Secondary, message-level signal: among the user's 5 most recently sent
 * messages, any that either mention "waiting" or simply carry real content
 * (not blank/trivial) and haven't been replied to yet also count — this
 * catches real threads the thread-level timestamp check misses
 * (lastMessageSentTimestamp is frequently null/unpopulated on real
 * accounts; see getNeedsResponseFromReal's own note on the same field).
 * "No reply yet" is judged the same way as the primary check: the thread's
 * lastMessageReceivedTimestamp, compared against this specific message's
 * own date rather than the thread-level lastMessageSentTimestamp.
 */
function getWaitingOnFromRecentMessages(
  realThreads,
  realMessages,
  currentUserEmail,
  includeExcluded
) {
  const now = new Date();
  const threadById = new Map((realThreads || []).map((t) => [t.threadId, t]));

  const recentSent = (realMessages || [])
    .filter((m) => m.fromEmail === currentUserEmail)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);

  const results = [];
  recentSent.forEach((m) => {
    const stripped = stripHtml(m.body);
    const isCandidate =
      WAITING_KEYWORD_PATTERN.test(stripped) || hasSubstantiveContent(stripped);
    if (!isCandidate) return;

    const thread = threadById.get(m.threadId);
    if (!thread) return;
    if (!includeExcluded && getEnforcementForThread(thread) === 'complete_exclusion') return;

    const noReplySince =
      !thread.lastMessageReceivedTimestamp ||
      new Date(thread.lastMessageReceivedTimestamp) < new Date(m.date);
    if (!noReplySince) return;

    const other = (thread.participantDetails || []).find(
      (p) => p.email !== currentUserEmail
    );
    const days = daysSince(m.date, now);
    // `m` IS the user's own pending message here (recentSent is filtered to
    // fromEmail === currentUserEmail above) — already exactly the right
    // text to scan for urgent language, no extra lookup needed.
    results.push({
      threadId: thread.threadId,
      subject: thread.subject,
      waitingOn: other ? other.name : thread.sender || 'Unknown',
      waitingOnEmail: other ? other.email : '',
      daysWaiting: days,
      urgency: computeUrgency(days, stripped),
    });
  });

  return results;
}

function getWaitingOnFromReal(realThreads, realMessages, currentUserEmail, includeExcluded) {
  const fromThreads = getWaitingOnFromThreadTimestamps(
    realThreads,
    realMessages,
    currentUserEmail,
    includeExcluded
  );
  const alreadyFound = new Set(fromThreads.map((w) => w.threadId));
  const fromMessages = getWaitingOnFromRecentMessages(
    realThreads,
    realMessages,
    currentUserEmail,
    includeExcluded
  ).filter((w) => !alreadyFound.has(w.threadId));

  return [...fromThreads, ...fromMessages].sort(
    (a, b) => b.daysWaiting - a.daysWaiting
  );
}

/**
 * realThreads undefined (key genuinely absent — old/transitional clients)
 * falls back to mock. Same rule as buildMailboxContext: an explicit []
 * is real data that found nothing, and must NOT fall back to mock.
 *
 * `includeExcluded` (default false) controls whether boundary-protected
 * threads are dropped — see getWaitingOnFromMock's own doc for why a caller
 * would ever want the excluded ones (count-only, never content display).
 */
function getWaitingOn(realThreads, realMessages, currentUserEmail, { includeExcluded = false } = {}) {
  if (realThreads !== undefined) {
    return getWaitingOnFromReal(realThreads, realMessages, currentUserEmail, includeExcluded);
  }
  return getWaitingOnFromMock(includeExcluded);
}

/**
 * The reverse of "waiting on": threads where the OTHER party sent the last
 * message and the user hasn't replied yet — i.e. things needing the user's
 * own response/approval, not things the user is chasing someone else for.
 * No mock equivalent exists (the mock mailbox was only ever modeled around
 * outgoing waits), so mock mode returns an empty array rather than inventing
 * mock incoming-request data.
 *
 * CRITICAL direction rule, hardened explicitly now that a keyword signal is
 * involved: the filter below requires the OTHER party's message to be the
 * thread's most recent one — if the user's own reply is most recent, the
 * thread is excluded right here, before urgency is ever computed for it.
 * That means urgent language anywhere earlier in the thread's history can
 * never leak a user-already-replied thread into these results; there is no
 * separate/conflicting filter, this is the same one getWaitingOn's
 * eligibility check already relies on, just for the opposite direction.
 */
function getNeedsResponseFromReal(realThreads, realMessages, currentUserEmail, includeExcluded) {
  const now = new Date();
  return (realThreads || [])
    .filter((t) => {
      if (!includeExcluded && getEnforcementForThread(t) === 'complete_exclusion') {
        return false;
      }
      if (!t.lastMessageReceivedTimestamp) return false;
      if (!t.lastMessageSentTimestamp) return true;
      return (
        new Date(t.lastMessageReceivedTimestamp) >
        new Date(t.lastMessageSentTimestamp)
      );
    })
    .map((t) => {
      const other = (t.participantDetails || []).find(
        (p) => p.email !== currentUserEmail
      );
      const days = daysSince(t.lastMessageReceivedTimestamp, now);
      const otherEmail = other ? other.email : '';
      // The other party's most recent message — the thread only reaches
      // this .map() at all when that message is genuinely the thread's
      // last (see the filter above), so this can't pick up an earlier one.
      const pendingText =
        findLatestMessageBodyFrom(realMessages, t.threadId, otherEmail) ||
        stripHtml(t.snippet || '');
      return {
        threadId: t.threadId,
        subject: t.subject,
        from: other ? other.name : t.sender || 'Unknown',
        fromEmail: otherEmail,
        daysWaiting: days,
        urgency: computeUrgency(days, pendingText),
      };
    })
    // Descending by date = most recently received first (ascending days
    // waiting), the opposite of getWaitingOn's oldest-first order — this
    // list is framed around "what recently landed on you", not "what's
    // been neglected longest".
    .sort((a, b) => a.daysWaiting - b.daysWaiting);
}

function getNeedsResponse(realThreads, realMessages, currentUserEmail, { includeExcluded = false } = {}) {
  if (realThreads !== undefined) {
    return getNeedsResponseFromReal(realThreads, realMessages, currentUserEmail, includeExcluded);
  }
  return [];
}

module.exports = { getWaitingOn, getNeedsResponse };
