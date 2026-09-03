const { createSecureLink, createSecureFileLink } = require('./yopass.service');

/**
 * The model is told to copy the credential verbatim, but it has been
 * observed truncating at a punctuation boundary (e.g. returning "hunter2"
 * for a body that actually contains "hunter2-roundtrip") — a partial
 * match leaves the rest of the secret sitting in plain text right next to
 * the inserted link, which then gets flagged as a credential all over
 * again on the next Send. Rather than chase this with more prompt
 * wording (the same class of problem reconcileFindingSeverities already
 * solves deterministically for severity), expand whatever substring the
 * model found out to the full contiguous non-whitespace token it sits
 * inside of, and redact that instead.
 */
function expandToFullToken(bodyText, matchedText) {
  const idx = bodyText.indexOf(matchedText);
  if (idx === -1) return matchedText;

  let start = idx;
  while (start > 0 && !/\s/.test(bodyText[start - 1])) start -= 1;

  let end = idx + matchedText.length;
  while (end < bodyText.length && !/\s/.test(bodyText[end])) end += 1;

  return bodyText.slice(start, end);
}

/**
 * Replaces each blocked finding's exact credential substring in the body
 * with a one-time Yopass secure link, so the email can be sent without the
 * raw credential ever leaving the organization in plain text. Also pulls
 * out any attachment a finding flagged as sensitive, uploads it to Yopass
 * as its own one-time secret (never the body's PGP secret — a different
 * file could need a different lifetime/audience), and appends a link to
 * it in the body instead. `attachments` is the actual file bytes for
 * whichever attachments the caller has on hand — the classify step only
 * ever saw filenames, so redaction is the first point the real bytes are
 * needed, and only for files a finding actually named.
 */
async function redactAndRelink(bodyText, findings, attachments = []) {
  let updatedBody = bodyText;
  let linksCreated = 0;
  const redactedAttachmentFilenames = [];

  const blockedWithText = (findings || []).filter(
    finding =>
      finding.severity === 'blocked' &&
      typeof finding.redactedText === 'string' &&
      finding.redactedText.length > 0
  );

  for (const finding of blockedWithText) {
    // The model can occasionally paraphrase instead of quoting verbatim —
    // skip rather than silently redact the wrong (or no) text.
    if (!updatedBody.includes(finding.redactedText)) continue;

    const fullToken = expandToFullToken(updatedBody, finding.redactedText);

    // eslint-disable-next-line no-await-in-loop -- secrets must be created
    // one at a time, each one only for the substring it replaces.
    const link = await createSecureLink(fullToken);
    // Body is the composer's HTML content — emit a real clickable link,
    // not just bracketed text, so the recipient can actually open it.
    // Padded with spaces so it doesn't run into whatever text sat on
    // either side of the credential it's replacing.
    const replacement = ` <a href="${link}" rel="noopener noreferrer">[View secure content — one-time link]</a> `;
    updatedBody = updatedBody.split(fullToken).join(replacement);
    linksCreated += 1;
  }

  const attachmentFindings = (findings || []).filter(
    finding => typeof finding.redactedAttachmentFilename === 'string'
  );

  for (const finding of attachmentFindings) {
    const attachment = attachments.find(
      a => a.filename === finding.redactedAttachmentFilename
    );
    // Same "don't act on an unverified match" rule as the credential path
    // above — only redact an attachment the caller actually sent us.
    if (!attachment) continue;

    // eslint-disable-next-line no-await-in-loop -- one file secret at a time
    const link = await createSecureFileLink(
      Buffer.from(attachment.contentBase64, 'base64'),
      attachment.filename
    );
    updatedBody += ` <p>"${attachment.filename}" was removed and replaced with a one-time secure link: <a href="${link}" rel="noopener noreferrer">[View attachment — one-time link]</a></p>`;
    redactedAttachmentFilenames.push(attachment.filename);
    linksCreated += 1;
  }

  return { bodyText: updatedBody, linksCreated, redactedAttachmentFilenames };
}

module.exports = { redactAndRelink };
