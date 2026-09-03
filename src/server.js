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

const PORT = process.env.PORT || 4700;
app.listen(PORT, () => {
  console.log(`juggadexe-titan-service listening on http://localhost:${PORT}`);
  console.log(`Try: curl -s -X POST http://localhost:${PORT}/hack/juggadexe/ask-titan/query -H "Content-Type: application/json" -d '{"query":"who am I waiting for"}'`);
});
