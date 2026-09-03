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

  const security = evaluateActionSafely({
    recipient: personEmail,
    body: draft.body,
    attachmentName: draft.attachmentName,
    attachmentType,
    senderEmail,
  });

  const nextState = security.risk === 'high' || security.blocked ? 'BLOCKED' : 'AWAITING_APPROVAL';
  transition(action.id, nextState, {
    riskLevel: security.risk,
    riskScore: security.riskScore,
    reasons: security.reasons,
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

module.exports = router;
