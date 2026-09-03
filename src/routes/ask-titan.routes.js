const express = require('express');
const { answerQuery } = require('../services/ask-titan.service');
const { getWaitingOn } = require('../services/waiting-on.service');
const { getCommitments } = require('../services/commitment.service');
const {
  evaluateAction,
  evaluateActionSafely,
} = require('../services/security-guardrail.service');
const {
  createAction,
  getAction,
  transition,
} = require('../services/action-state.service');
const {
  createRule,
  listRules,
  deleteRule,
  getEnforcementForContact,
} = require('../services/boundary.service');
const {
  suggestSnoozeTime,
  rankSnoozeWakeups,
} = require('../services/snooze-ai.service');

const router = express.Router();
const PREFIX = '/hack/juggadexe';

router.post(`${PREFIX}/ask-titan/query`, async (req, res) => {
  const { query, realThreads, realMessages, sentThreads, sentMessages, currentUserEmail } =
    req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  try {
    // realThreads is undefined for old/transitional clients that don't send
    // it at all (falls back to mock data below) — an explicit [] means the
    // client's real fetch genuinely found nothing, which is NOT the same
    // thing and must not fall back. sentThreads/sentMessages (Sent-folder
    // data) is only ever merged in for the waiting_on category — see
    // ask-titan.service.js.
    const result = await answerQuery(
      query,
      realThreads,
      realMessages,
      sentThreads,
      sentMessages,
      currentUserEmail
    );
    return res.json(result);
  } catch (err) {
    // Fail closed on AI unavailability — matches FAILURE_MESSAGES.AI_UNAVAILABLE
    // already handled on the frontend for exactly this response shape.
    return res.status(503).json({ error: err.code || 'AI_UNAVAILABLE' });
  }
});

// --- Boundary rules ("No-Go Zones") ---

router.get(`${PREFIX}/boundary-rules`, (_req, res) => {
  res.json({ items: listRules() });
});

router.post(`${PREFIX}/boundary-rules`, (req, res) => {
  const { ruleType, value, enforcementMode } = req.body || {};
  try {
    const rule = createRule({ ruleType, value, enforcementMode });
    return res.status(201).json(rule);
  } catch (err) {
    return res.status(400).json({ error: err.code || 'INVALID_RULE', message: err.message });
  }
});

router.delete(`${PREFIX}/boundary-rules/:id`, (req, res) => {
  const deleted = deleteRule(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'RULE_NOT_FOUND' });
  return res.status(204).end();
});

router.get(`${PREFIX}/waiting-on`, (_req, res) => {
  res.json({ items: getWaitingOn() });
});

router.get(`${PREFIX}/commitments`, (_req, res) => {
  res.json({ items: getCommitments() });
});

// Standalone security check, useful for previewing risk without creating
// an action (e.g. live-checking a draft as the user edits it).
router.post(`${PREFIX}/security-check`, (req, res) => {
  const { recipient, body, attachmentName, attachmentType, senderEmail } = req.body;
  if (!recipient) return res.status(400).json({ error: 'recipient is required' });
  const result = evaluateActionSafely({
    recipient,
    body,
    attachmentName,
    attachmentType,
    senderEmail,
  });
  res.json(result);
});

/**
 * Creates an action and drives it through CREATED -> PLANNED ->
 * SECURITY_CHECK -> AWAITING_APPROVAL (or BLOCKED) in one call, since the
 * planning + security steps are synchronous and fast in this MVP. The
 * resulting action sits in AWAITING_APPROVAL/BLOCKED until the user acts.
 */
router.post(`${PREFIX}/actions`, (req, res) => {
  const {
    personEmail,
    personName,
    actionType = 'follow_up',
    // Context for reply-type drafts — not required for follow_up.
    threadSubject,
    // Optional overrides so the demo can exercise the full attachment/BEC
    // scenarios through the real action lifecycle, not just /security-check.
    bodyOverride,
    attachmentName,
    attachmentType,
    senderEmail,
  } = req.body;
  if (!personEmail) return res.status(400).json({ error: 'personEmail is required' });

  const isReply = actionType === 'reply';
  const greetingName = personName || '';
  const defaultBody = isReply
    ? `Hi ${greetingName},\n\nThanks for your email — following up on this now.\n\nBest,\nPriya`
    : `Hi ${greetingName},\n\nJust following up on my earlier message — any update?\n\nThanks,\nPriya`;
  const defaultSubject =
    isReply && threadSubject
      ? threadSubject.startsWith('Re:')
        ? threadSubject
        : `Re: ${threadSubject}`
      : 'Following up';
  const draft = {
    to: personEmail,
    subject: defaultSubject,
    body: bodyOverride || defaultBody,
    attachmentName: attachmentName || null,
    actionType,
  };

  const action = createAction({ type: 'send_email', payload: draft });
  transition(action.id, 'PLANNED');
  transition(action.id, 'SECURITY_CHECK');

  // A "complete_exclusion" or "search_only" boundary rule blocks drafting
  // outright — Titan is never allowed to prepare an action for this contact,
  // regardless of what the (still-run, for consistency) security guardrail
  // finds. "no_external_actions" is checked again at approve-time instead,
  // since drafting is explicitly allowed under that mode.
  const boundaryMode = getEnforcementForContact(personEmail);
  const boundaryBlocksDraft =
    boundaryMode === 'complete_exclusion' || boundaryMode === 'search_only';

  const security = evaluateActionSafely({
    recipient: personEmail,
    body: draft.body,
    attachmentName: draft.attachmentName,
    attachmentType,
    senderEmail,
  });

  const nextState =
    boundaryBlocksDraft || security.risk === 'high' || security.blocked
      ? 'BLOCKED'
      : 'AWAITING_APPROVAL';
  const boundaryReasons = boundaryBlocksDraft
    ? [
        `This contact is protected by an active boundary rule (${boundaryMode}). Titan cannot draft or send to this recipient.`,
      ]
    : [];

  transition(action.id, nextState, {
    riskLevel: boundaryBlocksDraft ? 'high' : security.risk,
    riskScore: boundaryBlocksDraft ? 100 : security.riskScore,
    reasons: [...boundaryReasons, ...security.reasons],
  });

  res.status(201).json(getAction(action.id));
});

router.get(`${PREFIX}/actions/:id`, (req, res) => {
  const action = getAction(req.params.id);
  if (!action) return res.status(404).json({ error: 'ACTION_NOT_FOUND' });
  res.json(action);
});

// Idempotent: repeat calls with the same idempotencyKey return the existing
// result instead of re-executing. Required so a double-click never sends twice.
router.post(`${PREFIX}/actions/:id/approve`, (req, res) => {
  const { idempotencyKey } = req.body || {};
  const action = getAction(req.params.id);
  if (!action) return res.status(404).json({ error: 'ACTION_NOT_FOUND' });

  if (action.state !== 'AWAITING_APPROVAL') {
    // Already approved/executing/completed with this or another key —
    // return current state rather than erroring, so retries are safe.
    return res.json(action);
  }

  try {
    transition(action.id, 'APPROVED', { approvedByIdempotencyKey: idempotencyKey || null });

    // Re-checked here, not just at draft-time — a boundary rule may have
    // been added after this action was already approved. "no_external_actions"
    // permits the draft (already past that point) but never the send.
    const boundaryMode = getEnforcementForContact(action.payload.to);
    if (boundaryMode === 'no_external_actions') {
      transition(action.id, 'BLOCKED', {
        reasons: [
          ...action.reasons,
          'Sending is blocked for this recipient by an active "No External Actions" boundary rule.',
        ],
      });
      return res.json(getAction(action.id));
    }

    transition(action.id, 'EXECUTING');
    // MVP: no real send integration yet — mark completed immediately.
    // This is the one line to replace with a real Titan sendEmail call.
    transition(action.id, 'COMPLETED');
    res.json(getAction(action.id));
  } catch (err) {
    transition(action.id, 'FAILED', { reasons: [err.message] });
    res.status(500).json(getAction(action.id));
  }
});

router.post(`${PREFIX}/actions/:id/cancel`, (req, res) => {
  const action = getAction(req.params.id);
  if (!action) return res.status(404).json({ error: 'ACTION_NOT_FOUND' });
  if (action.state !== 'AWAITING_APPROVAL') {
    return res.json(action); // already terminal or in-flight — no-op
  }
  transition(action.id, 'CANCELLED');
  res.json(getAction(action.id));
});

// --- Snooze AI proxy (moves the OpenAI key server-side, out of the client
// bundle - see snooze-ai.service.js and the frontend's snooze-ai.api.ts) ---

router.post(`${PREFIX}/suggest-snooze-time`, async (req, res) => {
  const { subject, snippet, now } = req.body || {};
  if (typeof subject !== 'string' || typeof snippet !== 'string' || typeof now !== 'number') {
    return res.status(400).json({ error: 'subject, snippet, and now are required' });
  }
  try {
    const result = await suggestSnoozeTime({ subject, snippet, now });
    return res.json(result);
  } catch (err) {
    // Fail closed, same convention as /ask-titan/query above - never a
    // 500/crash just because the model or the key isn't available.
    return res.status(503).json({ error: err.code || 'AI_UNAVAILABLE' });
  }
});

router.post(`${PREFIX}/rank-snooze-wakeups`, async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }
  try {
    const result = await rankSnoozeWakeups({ items });
    return res.json(result);
  } catch (err) {
    return res.status(503).json({ error: err.code || 'AI_UNAVAILABLE' });
  }
});

module.exports = router;
