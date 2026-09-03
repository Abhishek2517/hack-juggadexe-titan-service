const app = require('./app');

// Local dev entrypoint (npm start). Vercel doesn't use this file at all —
// see api/index.js, which imports the same app but never calls .listen().
const PORT = process.env.PORT || 4700;
app.listen(PORT, () => {
  console.log(`juggadexe-titan-service listening on http://localhost:${PORT}`);
  console.log(`Try: curl -s -X POST http://localhost:${PORT}/hack/juggadexe/ask-titan/query -H "Content-Type: application/json" -d '{"query":"who am I waiting for"}'`);
});
