const XLSX = require('xlsx');

// Keeps the classify prompt small and the request fast — this is a
// best-effort content preview for risk-scanning, not a full document dump.
const MAX_PREVIEW_CHARS = 4000;

const PLAIN_TEXT_EXTENSIONS = ['csv', 'txt', 'json', 'md'];
const SPREADSHEET_EXTENSIONS = ['xlsx', 'xls'];

function getExtension(filename) {
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

/**
 * Best-effort text extraction for the file types risk-scanning actually
 * benefits from (structured data most likely to carry PII in bulk: CSV/
 * spreadsheet exports). Anything else (PDF, DOCX, images, etc.) returns
 * null and falls back to filename-only judgment — parsing those formats
 * is a much bigger dependency footprint than a hackathon timebox affords,
 * and the filename check still catches the obvious cases.
 */
function extractAttachmentText(filename, buffer) {
  const ext = getExtension(filename);

  try {
    if (PLAIN_TEXT_EXTENSIONS.includes(ext)) {
      return buffer.toString('utf-8').slice(0, MAX_PREVIEW_CHARS);
    }

    if (SPREADSHEET_EXTENSIONS.includes(ext)) {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const text = workbook.SheetNames.map(sheetName =>
        XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])
      ).join('\n');
      return text.slice(0, MAX_PREVIEW_CHARS);
    }
  } catch {
    // Malformed/unreadable file — fall back to filename-only judgment
    // rather than failing the whole classify call over one bad attachment.
    return null;
  }

  return null;
}

module.exports = { extractAttachmentText };
