const mailbox = require('../data/mailbox.mock.json');

const SENSITIVE_KEYWORDS = {
  'employee salaries': /salary|salaries/i,
  'bank account numbers': /bank account|account number/i,
  'credit card information': /credit card/i,
  'tax information': /tax id|ssn|pan number/i,
};

function isExternalRecipient(email) {
  const domain = email.split('@')[1];
  return domain !== 'abc.com'; // "abc.com" = the user's own org domain in this mock
}

function checkUnusualRecipient({ recipient, attachmentType }) {
  const history = mailbox.priorSendHistory[attachmentType] || {};
  const priorRecipients = Object.values(history).flat();
  if (attachmentType && !priorRecipients.includes(recipient)) {
    return {
      triggered: true,
      reason: `This recipient has not previously received a "${attachmentType}" attachment from you.`,
    };
  }
  return { triggered: false };
}

function checkSensitiveContent({ body = '', attachmentName = '' }) {
  const combined = `${body} ${attachmentName}`;
  const matches = Object.entries(SENSITIVE_KEYWORDS)
    .filter(([, re]) => re.test(combined))
    .map(([label]) => label);
  return { triggered: matches.length > 0, categories: matches };
}

function checkRelationshipAnomaly({ senderEmail, body = '' }) {
  const thread = mailbox.threads.find((t) =>
    t.messages.some((m) => m.from === senderEmail)
  );
  const isFirstOfType = thread?.isFirstRequestOfType;
  const mentionsBankChange = /bank account has changed|new account/i.test(body);
  if (isFirstOfType && mentionsBankChange) {
    return {
      triggered: true,
      reason:
        'This request differs significantly from previous communication with this contact — a payment-detail change with no prior pattern.',
    };
  }
  return { triggered: false };
}

/**
 * Deterministic decision — this is the ONLY function allowed to set
 * risk/requireApproval. AI is used elsewhere only to phrase explanations,
 * never to decide safe/unsafe.
 */
function evaluateAction({
  recipient,
  body = '',
  attachmentName = '',
  attachmentType = null,
  senderEmail = null,
}) {
  const reasons = [];
  let risk = 'low';

  const external = isExternalRecipient(recipient);
  if (external) reasons.push('Recipient is external.');

  const sensitive = checkSensitiveContent({ body, attachmentName });
  if (sensitive.triggered) {
    reasons.push(`Sensitive information detected: ${sensitive.categories.join(', ')}.`);
  }

  const unusualRecipient = checkUnusualRecipient({ recipient, attachmentType });
  if (unusualRecipient.triggered) reasons.push(unusualRecipient.reason);

  const anomaly = senderEmail
    ? checkRelationshipAnomaly({ senderEmail, body })
    : { triggered: false };
  if (anomaly.triggered) reasons.push(anomaly.reason);

  // Deterministic risk rule, per spec:
  // external + sensitive => HIGH; any single flag => MEDIUM; none => LOW
  if (external && sensitive.triggered) {
    risk = 'high';
  } else if (reasons.length > 0) {
    risk = 'medium';
  }

  // Simple additive score, purely for UI display alongside the risk label —
  // the risk LEVEL above is what actually drives approval requirements.
  let riskScore = 10;
  if (external) riskScore += 25;
  if (sensitive.triggered) riskScore += 35 + sensitive.categories.length * 5;
  if (unusualRecipient.triggered) riskScore += 20;
  if (anomaly.triggered) riskScore += 30;
  riskScore = Math.min(riskScore, 100);

  return {
    risk,
    riskScore,
    requireApproval: risk !== 'low',
    reasons,
  };
}

/**
 * Fail-closed wrapper. Per spec: if the guardrail itself errors out on a
 * high-stakes call, we must NOT default to allowing the send — an
 * unavailable security check is treated as a BLOCK, not a pass.
 */
function evaluateActionSafely(params) {
  try {
    return evaluateAction(params);
  } catch (err) {
    return {
      risk: 'high',
      riskScore: 100,
      requireApproval: true,
      blocked: true,
      reasons: [
        'Security verification is temporarily unavailable. The email has not been sent.',
      ],
      error: 'SECURITY_SERVICE_UNAVAILABLE',
    };
  }
}

module.exports = { evaluateAction, evaluateActionSafely };
