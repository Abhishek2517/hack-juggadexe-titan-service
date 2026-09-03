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

// How many items a boundary rule hid from this answer. Deliberately just a
// count — never a subject line, sender, or any other content for the
// skipped items themselves (Privacy Integrity Rule: enforced by this shape,
// not by UI discipline downstream).
function boundaryContextFor(filteredLength, unfilteredLength) {
  return { skippedCount: Math.max(0, unfilteredLength - filteredLength) };
}

/**
 * Real LLM-backed query answering (Milestone 3). The LLM only classifies
 * intent and writes the natural-language answer — it never decides what
 * structured data goes back to the frontend. That still comes from our own
 * deterministic functions, same separation of concerns as the security
 * guardrail: AI reasons, rules/code supply the actual data.
 *
 * Every category also reports `boundary.skippedCount` — how many items a
 * boundary rule hid from this specific answer, computed by comparing the
 * normal (excluded) result against an includeExcluded:true recount. This is
 * always a count-only recount, never a second, unfiltered payload.
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
    const allWaiting = getWaitingOn(waitingThreads, waitingMessages, currentUserEmail, {
      includeExcluded: true,
    });
    return {
      answer: buildWaitingOnAnswer(waiting),
      data: waiting,
      accessed: { threads: waiting.length, contacts: waiting.length, attachments: 0 },
      boundary: boundaryContextFor(waiting.length, allWaiting.length),
    };
  }

  if (category === 'needs_response') {
    const needsResponse = getNeedsResponse(realThreads, realMessages, currentUserEmail);
    const allNeedsResponse = getNeedsResponse(realThreads, realMessages, currentUserEmail, {
      includeExcluded: true,
    });
    return {
      answer,
      data: needsResponse,
      accessed: {
        threads: needsResponse.length,
        contacts: needsResponse.length,
        attachments: 0,
      },
      boundary: boundaryContextFor(needsResponse.length, allNeedsResponse.length),
    };
  }

  if (category === 'commitments') {
    const commitments = getCommitments(realThreads, realMessages, currentUserEmail);
    const allCommitments = getCommitments(realThreads, realMessages, currentUserEmail, {
      includeExcluded: true,
    });
    return {
      answer,
      data: commitments,
      accessed: {
        threads: commitments.length,
        contacts: commitments.length,
        attachments: 0,
      },
      boundary: boundaryContextFor(commitments.length, allCommitments.length),
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

    const allWaiting = getWaitingOn(realThreads, realMessages, currentUserEmail, {
      includeExcluded: true,
    });
    const allNeedsResponse = getNeedsResponse(realThreads, realMessages, currentUserEmail, {
      includeExcluded: true,
    });
    const allMergedUrgentCount =
      allWaiting.filter((w) => w.urgency === 'high').length +
      allNeedsResponse.filter((n) => n.urgency === 'high').length;

    return {
      answer,
      data: merged,
      accessed: {
        threads: merged.length,
        contacts: merged.length,
        attachments: 0,
      },
      boundary: boundaryContextFor(merged.length, allMergedUrgentCount),
    };
  }

  if (category === 'attention') {
    const waiting = getWaitingOn(realThreads, realMessages, currentUserEmail);
    const needsResponseAll = getNeedsResponse(realThreads, realMessages, currentUserEmail);
    const cappedNeedsResponse = needsResponseAll.slice(0, ATTENTION_DIGEST_NEEDS_RESPONSE_LIMIT);
    // Split by recency, not the existing urgency field (which is about
    // outgoing waits being overdue — the opposite direction): an incoming
    // thread received today or yesterday is time-sensitive/urgent, older
    // unreplied ones are still listed but not flagged urgent.
    const urgentNeedsResponse = cappedNeedsResponse.filter((n) => n.daysWaiting <= 1);
    const needsResponse = cappedNeedsResponse.filter((n) => n.daysWaiting > 1);
    const commitments = getCommitments(realThreads, realMessages, currentUserEmail);
    const urgent = waiting.filter((w) => w.urgency === 'high');

    // Boundary-skip counts are computed pre-cap (needsResponseAll vs its own
    // includeExcluded:true recount) so the digest cap never gets conflated
    // with content a boundary rule actually hid.
    const allWaiting = getWaitingOn(realThreads, realMessages, currentUserEmail, {
      includeExcluded: true,
    });
    const allNeedsResponse = getNeedsResponse(realThreads, realMessages, currentUserEmail, {
      includeExcluded: true,
    });
    const allCommitments = getCommitments(realThreads, realMessages, currentUserEmail, {
      includeExcluded: true,
    });
    const skippedCount =
      boundaryContextFor(waiting.length, allWaiting.length).skippedCount +
      boundaryContextFor(needsResponseAll.length, allNeedsResponse.length).skippedCount +
      boundaryContextFor(commitments.length, allCommitments.length).skippedCount;

    return {
      answer,
      data: { urgent, urgentNeedsResponse, waiting, needsResponse, commitments },
      accessed: {
        threads: waiting.length + cappedNeedsResponse.length + commitments.length,
        contacts: waiting.length + cappedNeedsResponse.length,
        attachments: 0,
      },
      boundary: { skippedCount },
    };
  }

  // "general" — the LLM's grounded free-text answer, plus any threads it
  // found genuinely relevant (validated against real IDs in llm.service.js).
  // This is the case that used to be a canned fallback with no data at all;
  // now it can surface real matching emails as cards, or an honest "none
  // found" when matchingThreadIds is empty. buildMailboxContext() already
  // excludes boundary-protected threads before the LLM ever sees them, so
  // matchingThreadIds can never reference one — skippedThreadsCount reports
  // how many were hidden without exposing which.
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
      boundary: { skippedCount: context.skippedThreadsCount },
    };
  }

  return {
    answer,
    data: null,
    accessed: { threads: 0, contacts: 0, attachments: 0 },
    boundary: { skippedCount: 0 },
  };
}

module.exports = { answerQuery };
