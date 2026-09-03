require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const askTitanRoutes = require('./routes/ask-titan.routes');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));

app.use(askTitanRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'juggadexe-titan-service' }));

// Only bind a real port when this file is run directly (`npm start`) — not
// when a test imports the app via require('../server') to drive it with
// supertest, which would otherwise collide with an already-running instance
// on the same port.
if (require.main === module) {
  const PORT = process.env.PORT || 4700;
  app.listen(PORT, () => {
    console.log(`juggadexe-titan-service listening on http://localhost:${PORT}`);
    console.log(`Try: curl -s -X POST http://localhost:${PORT}/hack/juggadexe/ask-titan/query -H "Content-Type: application/json" -d '{"query":"who am I waiting for"}'`);
  });
}

module.exports = app;
