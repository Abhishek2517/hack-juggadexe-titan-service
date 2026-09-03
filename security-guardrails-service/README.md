# security-guardrails-service

Standalone backend for the composer Security Guardrails hackathon feature
(team: **juggadexe**). Per the hackathon guidelines: this is its own
service, makes no changes to the existing `nike`/Titan services or tables,
and every route is prefixed `/hack/juggadexe`.

This is a **separate, parallel path** from `juggadexe-titan-service`'s
`/hack/juggadexe/security-check` — that one intentionally never delegates
the risk decision to an LLM (deterministic by design); this one
intentionally does, as its own exploration of AI-based classification.

## Run it

```bash
npm install
cp .env.example .env   # then fill in OPENAI_API_KEY
npm start               # http://localhost:4701
```

`OPENAI_API_KEY` is read lazily — the server still starts fine without it,
but any classify call will fail closed with `503 { error: "AI_UNAVAILABLE" }`
until it's set. `npm start`/`npm run dev` load `.env` automatically via
Node's built-in `--env-file-if-exists` (Node 22+); exporting the var in your
shell instead also works.

## Endpoint

`POST /hack/juggadexe/security-guardrails/classify`

Body:
```json
{
  "prompt": "<optional pre-rendered natural-language prompt>",
  "context": {
    "subject": "string",
    "bodyText": "string",
    "recipients": [{ "email": "string", "isExternal": true }],
    "attachmentFilenames": ["string"],
    "orgDomain": "string",
    "category": "financial-change | payroll | invoice | normal",
    "categoryHistory": [{ "category": "string", "localPart": "string", "domain": "string", "timestamp": 0 }],
    "recipientHistory": { "<email>": [{ "category": "string", "localPart": "string", "domain": "string", "timestamp": 0 }] }
  }
}
```

`context` is exactly the shape `nike`'s
`security-guardrails.prompt.ts#buildClassificationContext` already
produces client-side (recipient/category history stays in the composer's
own localStorage — this service is stateless, no DB of its own).

Response (`200`):
```json
{
  "riskLevel": "safe" | "needs_review" | "blocked",
  "findings": [
    { "severity": "needs_review" | "blocked", "title": "string", "description": "string" }
  ]
}
```

Failure (`503`): `{ "error": "AI_UNAVAILABLE" }` — no key set, model call
failed, or the model's response didn't parse/validate. The calling
composer (`security-guardrails.api.ts`) already has its own local
regex-based fallback for exactly this response shape, so a down/unkeyed
service degrades gracefully rather than breaking the send flow.

## What's mocked vs. real

- **Classification**: real OpenAI call (`gpt-4o-mini`, JSON mode),
  validated against the expected `{riskLevel, findings[]}` shape before
  being trusted — same "never trust raw LLM output as-is" posture as
  `juggadexe-titan-service`.
- **History**: not stored here at all — the composer already tracks
  per-recipient/per-category send history locally and sends the relevant
  slice as part of `context` on each call. No new DB/table required.

## Deploying

Only `temp_hackathon_2026` gets deployed on staging for existing services;
this is a *new* service, so it deploys independently. Prefix any new
resource (DB, Redis namespace, SQS, etc.) this service ever needs with
`hack_juggadexe`, and log it in DRQ-6124 per the hackathon guidelines.
