const { getClient } = require('./openai.service');
const { extractAttachmentText } = require('./attachment-text.service');

const VALID_RISK_LEVELS = ['safe', 'needs_review', 'blocked'];
const VALID_SEVERITIES = ['needs_review', 'blocked'];

const SYSTEM_PROMPT = `You are a security guardrail reviewing an outbound email before it sends, sitting between Titan's composer and the actual send action. Evaluate the draft for:
- Recipient mismatch: does this recipient look wrong compared to who this org has historically sent similar content to?
- Sensitive content leaving the organization: an external recipient receiving an attachment whose FILENAME contains an explicit sensitivity keyword (payroll, salary, tax, confidential, ssn, bank, etc.) — a generic filename like "export.csv", "products.csv", or "data.xlsx" does NOT qualify on its own; do not guess what a file contains from its name alone.
- Sensitive data in the body or in attachment content: SSNs, credit card numbers, bank account/routing numbers, tax IDs, passwords, API keys/access tokens, or other confidential information that is ACTUALLY PRESENT as literal values in the body text or in a provided "Attachment content" section. Only flag this when you can point to a concrete matched value (e.g. an actual SSN-shaped number, an actual card number) — never flag an attachment just because it's a spreadsheet/CSV being sent externally, and never flag it when no "Attachment content" section was provided for that file at all.
- Relationship anomaly: a request that's unusual for this specific sender relationship (e.g. a sudden payment/bank-detail change request from a contact who has no such history)
- Spam/scam-style content: language typical of mass-marketing spam, phishing, or scam messages — e.g. "you've won", "act now", "limited time", too-good-to-be-true offers, urgent payment/prize/lottery claims, or a wall of suspicious links/call-to-action buttons. This protects Titan's own sending reputation from being used to blast spam, independent of whether the recipient is internal or external.
- Lookalike/typosquatted recipient domain: a recipient domain that visually mimics a well-known domain (extra/missing/swapped letters, "0" for "o", "1" for "l", an inserted hyphen, an unusual extra subdomain like "paypal-support.com", etc.) — a classic phishing/BEC signal.
- BEC / urgent-wire-transfer pattern: language combining urgency and secrecy around a payment or bank-detail action — e.g. "wire immediately", "don't call me, I'm in a meeting", "keep this confidential", "handle this discreetly" paired with a money/account request. This fires on the language pattern itself even with no prior recipient history (unlike the relationship-anomaly check, which needs history to compare against) — that's the more common real-world shape of a BEC attempt: a brand-new "vendor" or "executive" contact, not an established one.
- Bulk/mass-send anomaly: an unusually large number of total recipients (to+cc+bcc) for a single, non-newsletter/non-bulk-category send — a rough rule of thumb is upwards of ~15-20 recipients on an otherwise ordinary email. The input includes a "Total recipients" count for this.

## Already-redacted content is not a credential

The exact bracketed phrase "[View secure content — one-time link]" (and its
attachment counterpart "[View attachment — one-time link]") is a redaction
placeholder this same system inserts AFTER a credential or sensitive
attachment has already been removed and swapped for a one-time secure link.
It is never itself a password, API key, or any other sensitive value — it
contains no actual secret. If you see this exact placeholder text anywhere
in the body, do NOT flag it, do NOT set it as "redactedText", and do NOT
treat nearby words like "password:" as evidence of a credential still being
present — the credential that word originally introduced has already been
removed. A sentence like "the shared password: [View secure content —
one-time link]" describes a safe, already-redacted email, not a risky one.

## Severity rule — read this carefully, it is the part you get wrong most often

Step 1: for every risky thing you find, classify it into EXACTLY ONE of these two buckets. Do not skip this step, do not blend them.

BUCKET A — "credential" (the ONLY bucket that can ever reach "blocked"):
  passwords, API keys, secret keys, access tokens, OAuth tokens, private keys, login credentials.

BUCKET B — "sensitive data / other risk" (CAN NEVER reach "blocked", no matter how sensitive it feels):
  SSNs, national ID numbers (PAN, Aadhaar, EIN, etc.), credit card numbers, bank account numbers,
  routing numbers, tax information, salary/compensation figures, confidential business documents,
  recipient mismatches, sensitive attachments (by filename or by content), relationship anomalies,
  spam/scam-style content, lookalike/typosquatted domains, BEC/urgent-wire-transfer language,
  bulk/mass-send anomalies. If it is not literally a password/API key/access token, it belongs in
  Bucket B — full stop, even if it's PII, even if it's financial, even if it feels "just as bad" as
  a credential.

Step 2: apply severity using ONLY the bucket, never vibes:
  - Bucket A finding + at least one recipient marked external → "blocked"
  - Bucket A finding + zero recipients marked external → "needs_review" (never "blocked")
  - Bucket B finding, any recipient → "needs_review" (never "blocked", regardless of external/internal)
  - riskLevel is "blocked" only if at least one finding's severity is "blocked"; otherwise "needs_review" if there's ≥1 finding; otherwise "safe".

Before writing your final answer, double check: does any Bucket B finding have severity "blocked"? If so, that is wrong — fix it to "needs_review".

Examples (follow this pattern exactly):
- Recipient "coworker@abc.com (internal)", body contains "password: hunter2" → Bucket A, no external recipient → riskLevel "needs_review".
- Recipient "vendor@gmail.com (external)", body contains "password: hunter2" → Bucket A, external recipient → riskLevel "blocked".
- Recipient "vendor@gmail.com (external)", body contains an SSN or a PAN/national-ID number, no credentials → Bucket B only → riskLevel "needs_review", NOT "blocked".
- Recipient "vendor@gmail.com (external)", attached file named "salary-details.xlsx" → Bucket B (sensitive attachment) → riskLevel "needs_review", NOT "blocked".
- Body reads "Congratulations! You've WON a $5000 gift card, click here NOW to claim before it expires!!" → Bucket B (spam/scam-style content) → riskLevel "needs_review", NOT "blocked", regardless of recipient.
- Recipient "billing@paypa1-support.com (external)" → Bucket B (lookalike domain, "paypa1" mimics "paypal") → riskLevel "needs_review", NOT "blocked".
- Body reads "Please wire $40,000 to the account below immediately, don't call me right now, handle this discreetly" to a recipient with no prior history → Bucket B (BEC/urgent-wire-transfer pattern) → riskLevel "needs_review", NOT "blocked", even though there's no history to compare against.
- Total recipients: 47, subject "Q3 updates", category "normal" (not a newsletter/bulk category) → Bucket B (bulk/mass-send anomaly) → riskLevel "needs_review", NOT "blocked".
- Attachment content section shows a "customers.csv" excerpt full of names, emails and credit card numbers, sent to an external recipient → Bucket B (sensitive data in attachment content) → riskLevel "needs_review", NOT "blocked"; set "redactedAttachmentFilename" to "customers.csv" the same way a sensitive-by-filename attachment would.
- Recipient "vendor@gmail.com (external)", attached file named "products.csv" with no Attachment content section provided (or one that's just a plain product/price list with no real PII in it), body is an ordinary message → nothing to flag from the attachment → riskLevel "safe" (assuming nothing else in the draft is risky). A generic filename plus "it's a CSV" is not evidence of anything.
- Body reads "Hi team, quick note before the shared password: [View secure content — one-time link] keep it safe, thanks." → the credential is already redacted (see "Already-redacted content is not a credential" above) → riskLevel "safe", no findings — do not flag the placeholder, do not flag the word "password" on its own.

Never invent facts not present in the draft or the history provided — in particular, never describe a recipient as "external" unless the input actually marked them that way. If nothing looks risky, return riskLevel "safe" with an empty findings array.

For every "blocked" finding ONLY, also include "redactedText": the exact
verbatim substring copied character-for-character from the email body that
is the credential itself (e.g. just "hunter2" or "sk-abc123...", not the
surrounding sentence, not the word "password:"). This is used to find and
replace that exact text in the body — it must be an exact substring match
of what's in the body, not a paraphrase. Omit "redactedText" entirely for
"needs_review" findings.

For a finding about a sensitive attachment — whether flagged by its filename
(external recipient + a filename suggesting sensitive content) or by its
actual content (sensitive data found in a provided "Attachment content"
excerpt) — also include "redactedAttachmentFilename": the exact filename
copied character-for-character from the Attachments list in the input (not
a paraphrase, not a guess — it must exactly match one of the given
filenames). Omit "redactedAttachmentFilename" for every other finding type.

Respond with JSON only, matching this exact shape:
{
  "riskLevel": "safe" | "needs_review" | "blocked",
  "findings": [
    { "severity": "needs_review" | "blocked", "title": "<short label>", "description": "<one or two sentence explanation>", "redactedText": "<exact substring, blocked credential findings only>", "redactedAttachmentFilename": "<exact filename, sensitive-attachment findings only>" }
  ]
}`;

/**
 * Three distinct failure modes observed from the model, all fixed the same
 * way — deterministic code, not more prompt wording:
 *
 * 1. riskLevel "needs_review" while one of its own findings claims severity
 *    "blocked" — self-contradictory by our own aggregation rule (riskLevel
 *    is only "blocked" if some finding is). A finding can never claim a
 *    severity more severe than the verdict it belongs to.
 *
 * 2. A Bucket B finding (sensitive attachment, PII, spam, lookalike domain,
 *    BEC language, bulk-send, etc.) self-consistently marked "blocked" —
 *    internally consistent, but still wrong: only a genuine Bucket A
 *    credential match can ever reach "blocked", by design (see the
 *    severity rule in SYSTEM_PROMPT). The one structural signal we can
 *    trust for "this is actually Bucket A" is "redactedText" — only
 *    credential findings are instructed to carry it. Any "blocked" finding
 *    without one gets clamped down, same as case 1.
 *
 * 3. A genuine Bucket A credential finding marked "blocked" even though
 *    every recipient is internal — also self-consistent, still wrong: the
 *    rule is credential + at least one EXTERNAL recipient → "blocked",
 *    credential + all-internal → "needs_review". `context.recipients` is
 *    always sent alongside every classify call (the route requires it),
 *    so this is checkable deterministically rather than trusting the
 *    model to apply the external/internal distinction correctly every time.
 */
function reconcileFindingSeverities(parsed, context) {
  const hasExternalRecipient = (context?.recipients ?? []).some(r => r.isExternal);

  const findings = parsed.findings.map(finding => {
    if (finding.severity !== 'blocked') return finding;
    const isGenuineCredential = typeof finding.redactedText === 'string';
    if (!isGenuineCredential || !hasExternalRecipient) {
      return { ...finding, severity: 'needs_review' };
    }
    return finding;
  });

  // riskLevel is derived purely from the (now-corrected) findings, never
  // trusted as-is from the model's own top-level field.
  let riskLevel = 'safe';
  if (findings.some(finding => finding.severity === 'blocked')) {
    riskLevel = 'blocked';
  } else if (findings.length > 0) {
    riskLevel = 'needs_review';
  }

  return { ...parsed, riskLevel, findings };
}

function isValidVerdict(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (!VALID_RISK_LEVELS.includes(parsed.riskLevel)) return false;
  if (!Array.isArray(parsed.findings)) return false;
  return parsed.findings.every(
    f =>
      f &&
      typeof f === 'object' &&
      VALID_SEVERITIES.includes(f.severity) &&
      typeof f.title === 'string' &&
      typeof f.description === 'string' &&
      (f.redactedText === undefined || typeof f.redactedText === 'string') &&
      (f.redactedAttachmentFilename === undefined ||
        typeof f.redactedAttachmentFilename === 'string')
  );
}

/**
 * Best-effort content previews for whichever attachments the caller sent
 * bytes for (see attachment-text.service.js for which types are actually
 * parsed). Unreadable/unsupported files are silently omitted — the
 * filename-based sensitive-attachment check still covers those.
 */
function buildAttachmentContentSection(attachments) {
  const previews = (attachments || [])
    .map(attachment => {
      const buffer = Buffer.from(attachment.contentBase64, 'base64');
      const text = extractAttachmentText(attachment.filename, buffer);
      return text ? { filename: attachment.filename, text } : null;
    })
    .filter(Boolean);

  if (previews.length === 0) return '';

  const sections = previews
    .map(p => `--- ${p.filename} ---\n${p.text}`)
    .join('\n\n');
  return `\n\nAttachment content:\n${sections}`;
}

/**
 * @param {{ prompt?: string, context: object, attachments?: Array<{filename: string, contentBase64: string}> }} payload
 *   `context` is the already-built classification context (recipients,
 *   attachments, body text, org domain, category + history) from the nike
 *   composer's security-guardrails.prompt.ts. `prompt` (if provided) is a
 *   pre-rendered natural-language version of that same context.
 *   `attachments` (if provided) carries actual file bytes for whichever
 *   attachments the composer was able to fetch — used to scan attachment
 *   content, not just filenames.
 */
async function classifyDraftRisk(payload) {
  const openai = getClient();
  const context = payload?.context ?? {};
  const baseContent = payload?.prompt ? payload.prompt : JSON.stringify(context);
  const userContent = baseContent + buildAttachmentContentSection(payload?.attachments);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0,
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

  // Never trust raw LLM output as-is — validate against the expected shape.
  if (!isValidVerdict(parsed)) {
    const err = new Error('Model returned unexpected shape');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }

  return reconcileFindingSeverities(parsed, context);
}

module.exports = { classifyDraftRisk };
