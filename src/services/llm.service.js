const OpenAI = require('openai');
const mailbox = require('../data/mailbox.mock.json');
const { getWaitingOn, getNeedsResponse } = require('./waiting-on.service');
const { getCommitments } = require('./commitment.service');

let client = null;
function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY is not set');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

/**
 * Compact, structured view of the mailbox — deliberately NOT the full raw
 * email bodies, to keep the prompt small and reduce PII sent to the model.
 * This is what the LLM is allowed to "see" for a query.
 *
 * @param {Array|undefined} realThreads - the current account's real recent
 *   inbox threads (see TInboxThreadContext on the frontend), when the
 *   client sent them. `undefined` (key genuinely absent from the request —
 *   old/transitional clients) falls back to the mock mailbox. An explicit
 *   `[]` (client's real fetch succeeded but found nothing) is used as-is —
 *   that is NOT the same as "not sent" and must not fall back to mock.
 * @param {Array|undefined} realMessages - real messages for those threads,
 *   forwarded to getCommitments() unchanged (see commitment.service.js).
 * @param {string|undefined} currentUserEmail - forwarded to getWaitingOn()/
 *   getCommitments() so "who is waiting on whom" resolves against the real
 *   account instead of the mock user.
 */
function buildMailboxContext(realThreads, realMessages, currentUserEmail) {
  const threads =
    realThreads !== undefined
      ? realThreads.map((t) => ({
          threadId: t.threadId,
          subject: t.subject,
          participants: t.participants,
          lastMessageSnippet: (t.snippet || '').slice(0, 200),
        }))
      : mailbox.threads.map((t) => ({
          threadId: t.threadId,
          subject: t.subject,
          participants: t.participants,
          lastMessageSnippet: t.messages[t.messages.length - 1].body.slice(0, 200),
        }));

  // Previously called with no args here, which silently always produced
  // mock waitingOn/commitments in the LLM's context even when realThreads
  // was provided — that's what caused the model to write mock names (John,
  // ABC Corp) into its prose regardless of the real data. Must use the same
  // real/mock selection as the threads above.
  return {
    waitingOn: getWaitingOn(realThreads, realMessages, currentUserEmail),
    // The reverse direction of waitingOn: threads where someone else sent
    // the last message and the user hasn't replied — incoming asks/approvals
    // needing the user's own action, not things the user is chasing others
    // for. See getNeedsResponse in waiting-on.service.js.
    needsResponse: getNeedsResponse(realThreads, realMessages, currentUserEmail),
    commitments: getCommitments(realThreads, realMessages, currentUserEmail),
    threads,
  };
}

const SYSTEM_PROMPT = `You are Titan's mailbox assistant. You answer questions about the user's email using ONLY the structured mailbox data provided to you — never invent emails, people, or facts not present in that data.

GROUNDING — applies to every category, not just "general": the answer text must be grounded strictly in the mailboxData given for THIS request. Every person name, company, or subject you mention in your answer must appear verbatim in that request's data — in a thread's participants/subject, or in an item's own waitingOn/from/person/subject field within the waitingOn/needsResponse/commitments arrays. Never reuse a name from training data, a prior request, or an example (e.g. "John", "Jane Doe", "ABC Corp") unless that exact name is actually present in the mailboxData you were given this time. If the relevant array is empty for this request, say so plainly instead of inventing an example item to answer with.

Classify the user's question into exactly one category. Use "waiting_on", "needs_response", "commitments", "urgent", or "attention" ONLY when the question is a generic request for that exact kind of summary across the WHOLE mailbox, with no specific topic named. If the question names a specific topic, project, or subject (e.g. "PR review", "the Acme deal", "invoice #123"), first check whether that topic actually appears in the mailbox data's subjects/snippets/commitments:
  - If it does appear, classify by what the question is asking about that topic ("waiting_on" if asking who's holding it up, "needs_response" if asking whether the user still owes a reply/approval on it, "commitments" if asking about a promise on it, otherwise "general").
  - If it does NOT appear anywhere in the data, you MUST classify it as "general" and say plainly that nothing matches — do NOT fall back to a broad "waiting_on"/"needs_response"/"commitments"/"urgent"/"attention" summary just because the question resembles that shape.

- "waiting_on": a broad, topic-less "who am I waiting for a response from" question — i.e. threads where the USER sent the last message and is waiting on someone ELSE. Base your answer on the waitingOn array in mailboxData — name the actual people in its waitingOn field, not a placeholder. This category is NOT filtered by priority — it includes every such thread regardless of urgency, low/medium/high alike.
- "needs_response": the reverse direction — a broad, topic-less question about incoming emails the user hasn't replied to yet, or requests/approvals waiting on the USER's own action (e.g. "which emails haven't I replied to", "is there anything needing my approval"). Base your answer on the needsResponse array in mailboxData — name the actual people in its from field, not a placeholder.
- "commitments": a broad, topic-less question about promises — either what the user has promised people, or what others have promised the user. Base your answer on the commitments array in mailboxData, which includes both directions (see each item's own "direction" field, "outgoing" = user promised them, "incoming" = they promised the user) — name the actual people in its person field, not a placeholder, and reflect the correct direction in your wording (e.g. "you promised X" vs "Y promised you").
- "urgent": specifically asks what's urgent or high-priority (e.g. "which emails are urgent?", "what's high priority?", "anything pressing?") — as distinct from "waiting_on" (asks about direction/who's holding things up, regardless of priority) and "attention" (broader — everything needing a look, not just the urgent subset). Only the high-urgency items from BOTH the waitingOn and needsResponse arrays are relevant here, merged into one list rather than kept as separate outbound/inbound sections.
- "attention": a broad "what needs my attention" / everything-in-one-place question. Draws on the waitingOn, needsResponse, and commitments arrays above — same grounding rule applies. Broader than "urgent": includes non-urgent follow-ups and commitments too, not just the high-priority subset.
- "general": anything with a specific named topic, or anything else (yes/no questions about a topic, searches, etc.)

For "general" queries: look through the given threads for any that are genuinely relevant to the question, and list their threadId values in matchingThreadIds. If nothing is relevant, matchingThreadIds must be an empty array — do not include a thread just because it's the closest available, only include genuine matches. Only use threadId values that appear in the mailboxData you were given; never invent one.

Write the answer to match what you found: if matchingThreadIds is non-empty, reference how many you found; if empty, say plainly and positively that nothing matches (e.g. "You have no emails requiring that right now — you're all caught up") rather than a vague non-answer. Do not guess or hedge about data you were not given, and never answer a different question than the one asked.

Never expose your reasoning process — return only the final answer.

Respond with JSON only, matching this exact shape:
{ "category": "waiting_on" | "needs_response" | "commitments" | "urgent" | "attention" | "general", "answer": "<one or two sentence natural-language answer>", "matchingThreadIds": ["<threadId>", ...] }
For any category other than "general", matchingThreadIds should be an empty array — it's only used for "general".`;

async function classifyAndAnswer(query, realThreads, realMessages, currentUserEmail) {
  const context = buildMailboxContext(realThreads, realMessages, currentUserEmail);
  const openai = getClient();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          question: query,
          mailboxData: context,
        }),
      },
    ],
    temperature: 0.2,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    const err = new Error('Empty response from model');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error('Model returned invalid JSON');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  // Validate against the expected shape — never trust raw LLM output as-is.
  const validCategories = [
    'waiting_on',
    'needs_response',
    'commitments',
    'urgent',
    'attention',
    'general',
  ];
  if (!validCategories.includes(parsed.category) || typeof parsed.answer !== 'string') {
    const err = new Error('Model returned unexpected shape');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  // Never trust thread IDs from the model either — filter to only IDs that
  // actually exist in the context we gave it. A hallucinated ID here would
  // otherwise silently break the frontend's thread lookup.
  const knownThreadIds = new Set(context.threads.map((t) => t.threadId));
  const matchingThreadIds = Array.isArray(parsed.matchingThreadIds)
    ? parsed.matchingThreadIds.filter((id) => knownThreadIds.has(id))
    : [];

  return { category: parsed.category, answer: parsed.answer, matchingThreadIds };
}

module.exports = { classifyAndAnswer, buildMailboxContext };
