const express = require('express');
const { classifyDraftRisk } = require('../services/security-guardrails.service');
const { redactAndRelink } = require('../services/redact-secrets.service');

const router = express.Router();
const PREFIX = '/hack/juggadexe';

router.post(`${PREFIX}/security-guardrails/classify`, async (req, res) => {
  const { context, attachments } = req.body || {};
  if (!context) {
    return res.status(400).json({ error: 'context is required' });
  }
  if (attachments !== undefined && !Array.isArray(attachments)) {
    return res.status(400).json({ error: 'attachments must be an array when provided' });
  }

  try {
    const verdict = await classifyDraftRisk(req.body);
    return res.json(verdict);
  } catch (err) {
    // Fail closed on AI unavailability — the calling composer already has
    // its own local fallback for this response shape (503 AI_UNAVAILABLE).
    return res.status(503).json({ error: err.code || 'AI_UNAVAILABLE' });
  }
});

// Swaps each blocked finding's exact credential text for a one-time Yopass
// link, so a flagged draft can be sent without the raw secret in plain text.
router.post(`${PREFIX}/security-guardrails/redact`, async (req, res) => {
  const { bodyText, findings, attachments } = req.body || {};
  if (typeof bodyText !== 'string' || !Array.isArray(findings)) {
    return res.status(400).json({ error: 'bodyText and findings are required' });
  }
  if (attachments !== undefined && !Array.isArray(attachments)) {
    return res.status(400).json({ error: 'attachments must be an array when provided' });
  }

  try {
    const result = await redactAndRelink(bodyText, findings, attachments);
    return res.json(result);
  } catch (err) {
    return res.status(503).json({ error: err.code || 'YOPASS_UNAVAILABLE' });
  }
});

module.exports = router;
