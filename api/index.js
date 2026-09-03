// Vercel serverless entry point. Vercel calls this file's export directly
// as a request handler for every incoming request — it never runs
// src/server.js's app.listen(), since Vercel manages the actual listening
// itself behind the scenes.
module.exports = require('../src/app');
