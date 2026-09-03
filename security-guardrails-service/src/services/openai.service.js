const OpenAI = require('openai');

let client = null;

/**
 * Lazy client init — the server must still start fine with no key set (it
 * just fails closed per-request), matching juggadexe-titan-service's
 * llm.service.js convention.
 */
function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY is not set');
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

module.exports = { getClient };
