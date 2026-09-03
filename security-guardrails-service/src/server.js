const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const securityGuardrailsRoutes = require('./routes/security-guardrails.routes');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));

app.use(securityGuardrailsRoutes);

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'security-guardrails-service' })
);

const PORT = process.env.PORT || 4701;
app.listen(PORT, () => {
  console.log(`security-guardrails-service listening on http://localhost:${PORT}`);
  console.log(
    `Try: curl -s -X POST http://localhost:${PORT}/hack/juggadexe/security-guardrails/classify -H "Content-Type: application/json" -d '{"context":{"subject":"Invoice","bodyText":"See attached.","recipients":[{"email":"finance@gmail.com","isExternal":true}],"attachmentFilenames":["salary.xlsx"],"orgDomain":"abc.com","category":"invoice","categoryHistory":[],"recipientHistory":{}}}'`
  );
});
