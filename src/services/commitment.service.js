const mailbox = require('../data/mailbox.mock.json');
const { getEnforcementForThread } = require('./boundary.service');

// Simple pattern set standing in for LLM-based commitment extraction.
// Replace matchCommitmentPhrase() with an LLM call in a later milestone —
// keep the output shape identical so nothing downstream needs to change.
const COMMITMENT_PATTERNS = [/i'?ll send/i, /i will send/i, /i'?ll get.*over/i];
// Broader, keyword-level catch-all requested alongside the phrase patterns
// above: a real email that talks about "the commitment"/"a promise" without
// using one of the specific phrasings above should still be caught.
const COMMITMENT_KEYWORDS = [/\bcommitments?\b/i, /\bpromise[sd]?\b/i];

// Real message bodies are rich-text HTML (Froala editor markup), not plain
// text — tags/attributes can otherwise split a phrase across nodes and
// silently defeat a plain-text regex.
function stripHtml(body) {
  return (body || '').replace(/<[^>]*>/g, ' ');
}

function matchCommitmentPhrase(body) {
  const text = stripHtml(body);
  return (
    COMMITMENT_PATTERNS.some((re) => re.test(text)) ||
    COMMITMENT_KEYWORDS.some((re) => re.test(text))
  );
}

// What's actually shown on the commitment card — plain text, whitespace
// collapsed, capped to a preview length (a raw HTML signature block can run
// to several KB, which is unreadable as a one-line card summary).
const COMMITMENT_TEXT_PREVIEW_LENGTH = 200;
function cleanCommitmentText(body) {
  const text = stripHtml(body).replace(/\s+/g, ' ').trim();
  return text.length > COMMITMENT_TEXT_PREVIEW_LENGTH
    ? `${text.slice(0, COMMITMENT_TEXT_PREVIEW_LENGTH)}…`
    : text;
}

// Threads under a "complete_exclusion" boundary rule never contribute a
// commitment, unless `includeExcluded` is set — same contract as
// getWaitingOn() in waiting-on.service.js.
function getCommitmentsFromMock(includeExcluded) {
  const commitments = [];

  mailbox.threads.forEach((t) => {
    if (!includeExcluded && getEnforcementForThread(t) === 'complete_exclusion') return;
    t.messages.forEach((m) => {
      if (m.from === mailbox.user.email && matchCommitmentPhrase(m.body)) {
        const recipient = m.to[0];
        const contact = mailbox.contacts[recipient];
        commitments.push({
          threadId: t.threadId,
          subject: t.subject,
          person: contact ? contact.name : recipient,
          personEmail: recipient,
          commitmentText: cleanCommitmentText(m.body),
          status: 'pending', // pending | overdue | completed — mocked for now
          direction: 'outgoing', // outgoing = you promised them; incoming = they promised you
        });
      }
    });
  });

  return commitments;
}

/**
 * Same rule as the mock version (messages the user sent that match a
 * commitment phrase), against real TInboxMessageContext/TInboxThreadContext
 * shapes. `m.body` is already the real body-or-snippet-fallback text (see
 * GET_INBOX_THREADS) — no different handling needed here for that.
 */
function getOutgoingCommitmentsFromReal(
  realThreads,
  realMessages,
  currentUserEmail,
  includeExcluded
) {
  const commitments = [];
  const threadById = new Map((realThreads || []).map((t) => [t.threadId, t]));

  (realMessages || []).forEach((m) => {
    if (m.fromEmail !== currentUserEmail || !matchCommitmentPhrase(m.body)) {
      return;
    }
    const thread = threadById.get(m.threadId);
    if (thread && !includeExcluded && getEnforcementForThread(thread) === 'complete_exclusion') {
      return;
    }
    const recipientEmail = m.toEmails && m.toEmails[0];
    const participant =
      thread &&
      (thread.participantDetails || []).find(
        (p) => p.email === recipientEmail
      );
    commitments.push({
      threadId: m.threadId,
      subject: thread ? thread.subject : '',
      person: participant ? participant.name : recipientEmail || 'Unknown',
      personEmail: recipientEmail || '',
      commitmentText: cleanCommitmentText(m.body),
      status: 'pending', // pending | overdue | completed — mocked for now
      direction: 'outgoing',
    });
  });

  return commitments;
}

/**
 * The reverse direction: messages someone ELSE sent to the current user that
 * match the same commitment phrase — i.e. what they promised the user, not
 * what the user promised them. Same phrase-matching rule, just flipped
 * sender/recipient roles.
 */
function getIncomingCommitmentsFromReal(
  realThreads,
  realMessages,
  currentUserEmail,
  includeExcluded
) {
  const commitments = [];
  const threadById = new Map((realThreads || []).map((t) => [t.threadId, t]));

  (realMessages || []).forEach((m) => {
    const sentToUser = (m.toEmails || []).includes(currentUserEmail);
    if (m.fromEmail === currentUserEmail || !sentToUser || !matchCommitmentPhrase(m.body)) {
      return;
    }
    const thread = threadById.get(m.threadId);
    if (thread && !includeExcluded && getEnforcementForThread(thread) === 'complete_exclusion') {
      return;
    }
    const sender =
      thread &&
      (thread.participantDetails || []).find((p) => p.email === m.fromEmail);
    commitments.push({
      threadId: m.threadId,
      subject: thread ? thread.subject : '',
      person: sender ? sender.name : m.fromEmail || 'Unknown',
      personEmail: m.fromEmail || '',
      commitmentText: cleanCommitmentText(m.body),
      status: 'pending', // pending | overdue | completed — mocked for now
      direction: 'incoming',
    });
  });

  return commitments;
}

function getCommitmentsFromReal(realThreads, realMessages, currentUserEmail, includeExcluded) {
  return [
    ...getOutgoingCommitmentsFromReal(realThreads, realMessages, currentUserEmail, includeExcluded),
    ...getIncomingCommitmentsFromReal(realThreads, realMessages, currentUserEmail, includeExcluded),
  ];
}

/**
 * realThreads undefined (key genuinely absent — old/transitional clients)
 * falls back to mock. Same rule as buildMailboxContext: an explicit []
 * is real data that found nothing, and must NOT fall back to mock.
 *
 * `includeExcluded` (default false) controls whether boundary-protected
 * threads are dropped — same contract as getWaitingOn().
 */
function getCommitments(realThreads, realMessages, currentUserEmail, { includeExcluded = false } = {}) {
  if (realThreads !== undefined) {
    return getCommitmentsFromReal(realThreads, realMessages, currentUserEmail, includeExcluded);
  }
  return getCommitmentsFromMock(includeExcluded);
}

module.exports = { getCommitments };
