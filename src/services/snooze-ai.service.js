const OpenAI = require('openai');

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Same lazy-singleton + fail-closed pattern as llm.service.js's getClient() —
// throws with a .code the routes layer can turn into a clean 503 instead of
// a 500/crash when the key isn't configured.
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

// Ported verbatim from the frontend's snooze-ai.api.ts SYSTEM_PROMPT —
// keep these two in sync if either changes.
const SUGGEST_SYSTEM_PROMPT =
  'You help decide when an email should resurface as a reminder. Given ' +
  "the current time and an email's subject and preview text, reply with " +
  'strict JSON only, no markdown: {"suggestedAt": "<ISO 8601 datetime>", ' +
  '"reason": "<one short sentence>"}. Infer any deadline or follow-up cue ' +
  'from the text; if none is present, suggest a sensible default such as ' +
  'tomorrow morning. suggestedAt must be strictly after the given current ' +
  'time - use the given weekday name (not date arithmetic on the ISO ' +
  'date alone) to resolve relative references like "Friday" or "next week".';

// Spelling out the weekday name (not just an ISO date) matters: a raw ISO
// timestamp alone leads the model to miscalculate which day "Friday" etc.
// refers to (and occasionally return a date before "now"), since deriving
// a weekday from a date is a known LLM weak spot. Same reasoning as the
// frontend's formatCurrentTimeForPrompt, ported here since suggestedAt is
// now resolved server-side.
function formatCurrentTimeForPrompt(now) {
  return new Date(now).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * @param {{subject: string, snippet: string, now: number}} params
 * @returns {Promise<{suggestedAt: number, reason: string}>}
 */
async function suggestSnoozeTime({ subject, snippet, now }) {
  const openai = getClient();

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SUGGEST_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Current time: ${formatCurrentTimeForPrompt(now)}\nSubject: ${subject}\nPreview: ${snippet}`,
      },
    ],
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    const err = new Error('Empty response from model');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const err = new Error('Model returned invalid JSON');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  const suggestedAt = parsed.suggestedAt ? new Date(parsed.suggestedAt).getTime() : NaN;
  if (!parsed.reason || Number.isNaN(suggestedAt)) {
    const err = new Error('Model returned unexpected shape');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  return { suggestedAt, reason: parsed.reason };
}

const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);

// Ported verbatim from the frontend's snooze-ai.api.ts RANK_SYSTEM_PROMPT.
const RANK_SYSTEM_PROMPT =
  'You help a user triage several emails that just came back from snooze ' +
  'at the same time. Given a JSON array of emails (threadId, subject, ' +
  'snippet), reply with strict JSON only, no markdown: {"rankings": ' +
  '[{"threadId": "<id>", "priority": "high" | "medium" | "low"}, ...]}. ' +
  'Use "high" for urgent or time-sensitive items that need attention ' +
  'first, "medium" for normal follow-ups, and "low" for informational or ' +
  'low-urgency items. Every threadId from the input must appear exactly ' +
  'once in the output.';

/**
 * @param {{items: Array<{threadId: string, subject: string, snippet: string}>}} params
 * @returns {Promise<Record<string, 'high'|'medium'|'low'>>}
 */
async function rankSnoozeWakeups({ items }) {
  const openai = getClient();

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: RANK_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(items) },
    ],
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    const err = new Error('Empty response from model');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const err = new Error('Model returned invalid JSON');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  if (!Array.isArray(parsed.rankings)) {
    const err = new Error('Model returned unexpected shape');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  const priorityByThreadId = {};
  parsed.rankings.forEach(({ threadId, priority }) => {
    if (threadId && priority && VALID_PRIORITIES.has(priority)) {
      priorityByThreadId[threadId] = priority;
    }
  });

  // A response missing (or mis-keying) one or two ids out of several is
  // still useful for the rest - only reject the whole batch when literally
  // nothing usable came back. Same reasoning as the frontend original.
  if (!Object.keys(priorityByThreadId).length) {
    const err = new Error('Model ranking response had no usable rankings');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  return priorityByThreadId;
}

module.exports = { suggestSnoozeTime, rankSnoozeWakeups };
