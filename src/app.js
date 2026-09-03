const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const askTitanRoutes = require('./routes/ask-titan.routes');

// Express app definition only — no app.listen() here. This gets reused by
// both server.js (local `npm start`) and api/index.js (Vercel serverless),
// which need to run the app differently.
const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));

app.use(askTitanRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'juggadexe-titan-service' }));

module.exports = app;
