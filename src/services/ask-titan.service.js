const { getWaitingOn, getNeedsResponse } = require('./waiting-on.service');
const { getCommitments } = require('./commitment.service');
const { classifyAndAnswer, buildMailboxContext } = require('./llm.service');

// The daily attention digest is meant to be a quick glance, not an
// exhaustive backlog — cap it to the N most recent (already sorted
// newest-first by getNeedsResponse). A direct question like "which emails
// haven't I replied to" goes through the needs_response category instead,
// which intentionally returns the full list uncapped.
const ATTENTION_DIGEST_NEEDS_RESPONSE_LIMIT = 10;

/**
 * Deterministic answer text for waiting_on, built from the same `waiting`
 * array actually served as `data` — guarantees the copy can never disagree
 * with the results, unlike the LLM's own answer for this category, which is
 * written during classification against Inbox-only grounding context and so
 * can't see Sent-derived waits merged in afterward (see the waiting_on
 * branch below).
 */
function buildWaitingOnAnswer(waiting) {
  if (waiting.length === 0) {
    return "You're not waiting on a response from anyone right now.";
  }
  if (waiting.length === 1) {
    const [w] = waiting;
    return `You are waiting on ${w.waitingOn} for a response regarding '${w.subject}'.`;
  }
  const names = waiting.map((w) => w.waitingOn);
  const namesText =
    names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  return `You are waiting on responses from ${namesText}.`;
}

/**
 * Real LLM-backed query answering (Milestone 3). The LLM only classifies
 * intent and writes the natural-language answer — it never decides what
 * structured data goes back to the frontend. That still comes from our own
 * deterministic functions, same separation of concerns as the security
 * guardrail: AI reasons, rules/code supply the actual data.
 */
async function answerQuery(
  query,
  realThreads,
  realMessages,
  sentThreads,
  sentMessages,
  currentUserEmail
) {
  const { category, answer, matchingThreadIds } = await classifyAndAnswer(
    query,
    realThreads,
    realMessages,
    currentUserEmail
  );

  if (category === 'waiting_on') {
    // Sent-folder data is merged in ONLY here, for the explicit "who am I
    // waiting for" question — a brand-new compose with no prior inbox
    // history lives purely in Sent and would otherwise never be seen. Every
    // other category (attention/urgent included) stays scoped to
    // realThreads/realMessages (Inbox only) by design — see
    // ask-titan.routes.js and the tailgate subscriber for why these are
    // kept as separate arrays rather than merged upstream.
    // Preserve the undefined-vs-[] distinction: realThreads undefined means
    // an old/transitional client that never sent real data at all, which
    // must still fall back to mock — merging in sentThreads unconditionally
    // would turn that undefined into a defined (if empty) array and break
    // the fallback.
    const waitingThreads =
      realThreads !== undefined ? [...realThreads, ...(sentThreads || [])] : undefined;
    const waitingMessages =
      realThreads !== undefined ? [...(realMessages || []), ...(sentMessages || [])] : undefined;
    const waiting = getWaitingOn(waitingThreads, waitingMessages, currentUserEmail);
    return {
      answer: buildWaitingOnAnswer(waiting),
      data: waiting,
      accessed: { threads: waiting.length, contacts: waiting.length, attachments: 0 },
    };
  }

  if (category === 'needs_response') {
    const needsResponse = getNeedsResponse(realThreads, realMessages, currentUserEmail);
    return {
      answer,
      data: needsResponse,
      accessed: {
        threads: needsResponse.length,
        contacts: needsResponse.length,
        attachments: 0,
      },
    };
  }

  if (category === 'commitments') {
    const commitments = getCommitments(realThreads, realMessages, currentUserEmail);
    return {
      answer,
      data: commitments,
      accessed: {
        threads: commitments.length,
        contacts: commitments.length,
        attachments: 0,
      },
    };
  }

  if (category === 'urgent') {
    // Distinct from "attention": ONLY high-urgency items, from BOTH
    // directions, merged into one flat list — no section breakdown, no
    // non-urgent follow-ups/commitments. Stays scoped to
    // realThreads/realMessages (non-Sent) same as attention, per the
    // existing "no sent mail in attention/urgent" rule — this is not the
    // standalone waiting_on query, which is the only place Sent gets
    // merged in.
    const waiting = getWaitingOn(realThreads, realMessages, currentUserEmail);
    const needsResponse = getNeedsResponse(realThreads, realMessages, currentUserEmail);
    const urgentWaiting = waiting.filter((w) => w.urgency === 'high');
    const urgentNeedsResponse = needsResponse.filter((n) => n.urgency === 'high');
    // Each item keeps its own original shape (waitingOn/waitingOnEmail vs
    // from/fromEmail) rather than being normalized — the frontend already
    // has a pattern for telling these apart per-item (see AskTitanContent's
    // data-shape checks), so this flat array mixes both, same as how
    // AttentionDigest's own Urgent section already renders urgent/
    // urgentNeedsResponse side by side.
    const merged = [...urgentWaiting, ...urgentNeedsResponse];
    return {
      answer,
      data: merged,
      accessed: {
        threads: merged.length,
        contacts: merged.length,
        attachments: 0,
      },
    };
  }

  if (category === 'attention') {
    const waiting = getWaitingOn(realThreads, realMessages, currentUserEmail);
    const cappedNeedsResponse = getNeedsResponse(realThreads, realMessages, currentUserEmail).slice(
      0,
      ATTENTION_DIGEST_NEEDS_RESPONSE_LIMIT
    );
    // Split by recency, not the existing urgency field (which is about
    // outgoing waits being overdue — the opposite direction): an incoming
    // thread received today or yesterday is time-sensitive/urgent, older
    // unreplied ones are still listed but not flagged urgent.
    const urgentNeedsResponse = cappedNeedsResponse.filter((n) => n.daysWaiting <= 1);
    const needsResponse = cappedNeedsResponse.filter((n) => n.daysWaiting > 1);
    const commitments = getCommitments(realThreads, realMessages, currentUserEmail);
    const urgent = waiting.filter((w) => w.urgency === 'high');
    return {
      answer,
      data: { urgent, urgentNeedsResponse, waiting, needsResponse, commitments },
      accessed: {
        threads: waiting.length + cappedNeedsResponse.length + commitments.length,
        contacts: waiting.length + cappedNeedsResponse.length,
        attachments: 0,
      },
    };
  }

  // "general" — the LLM's grounded free-text answer, plus any threads it
  // found genuinely relevant (validated against real IDs in llm.service.js).
  // This is the case that used to be a canned fallback with no data at all;
  // now it can surface real matching emails as cards, or an honest "none
  // found" when matchingThreadIds is empty.
  if (matchingThreadIds.length > 0) {
    const context = buildMailboxContext(realThreads, realMessages, currentUserEmail);
    const matchedThreads = context.threads.filter((t) =>
      matchingThreadIds.includes(t.threadId)
    );
    return {
      answer,
      data: { searchResults: matchedThreads },
      accessed: {
        threads: context.threads.length,
        contacts: 0,
        attachments: 0,
      },
    };
  }

  return {
    answer,
    data: null,
    accessed: { threads: 0, contacts: 0, attachments: 0 },
  };
}

module.exports = { answerQuery };
