# Ask Titan — Backend (Team juggadexe)

An AI mailbox assistant for Titan that answers natural-language questions
about your inbox — and, critically, is architected so the AI is never the
thing deciding whether a risky action is safe to take.

Standalone service for the hackathon: it doesn't touch existing Titan
services or tables, and every route is prefixed `/hack/juggadexe`.

## The problem

Inboxes bury three things people constantly re-derive by hand: *who am I
waiting on*, *what have I promised*, and *what still needs my reply*. An LLM
can answer these conversationally — but only if you don't let it also decide
what's safe to send on your behalf. Most "AI assistant" demos skip that part.

## What this does

1. **Ask Titan** — ask things like *"who am I waiting on?"* or *"what did I
   promise the Acme team?"* and get a grounded natural-language answer, backed
   by real inbox data when available (falls back to a mock mailbox otherwise).
2. **Security guardrail** — before any AI-suggested action (e.g. sending an
   email) can go out, a deterministic rule engine scores its risk (external
   recipient, sensitive content, unusual recipient, relationship anomalies)
   and requires human approval above a threshold. **The LLM only classifies
   and phrases answers — it never decides safe vs. unsafe.** If the guardrail
   itself errors, it fails **closed** (blocks the send) rather than open.
3. **Action state machine** — every AI-initiated action is a tracked object
   moving through explicit states (`CREATED → PLANNED → SECURITY_CHECK →
   AWAITING_APPROVAL → APPROVED → EXECUTING → COMPLETED`, or
   `BLOCKED/CANCELLED/FAILED/EXPIRED`). Illegal transitions throw, and
   approval is idempotent — so a double-click (or a retried request) can
   never send the same email twice.

## Why this architecture

- **Separation of concerns is the whole point**: reasoning (LLM) and
  authorization (deterministic code) are different modules that can't be
  conflated by construction — see [`llm.service.js`](src/services/llm.service.js)
  vs. [`security-guardrail.service.js`](src/services/security-guardrail.service.js).
- **Grounding, not hallucination**: the LLM is only ever shown structured,
  extracted mailbox data (never raw email bodies) and is instructed to name
  only people/subjects that actually appear in that data — reducing both PII
  exposure and made-up answers.
- **Fail-closed by default**: an unavailable or erroring security check
  blocks the action; it never silently allows it.
- **Idempotent, auditable actions**: nothing mutates action state except the
  single `transition()` function, and every action carries its risk score
  and reasons, not just a pass/fail bit.

## Quick start

```bash
npm install
npm start        # http://localhost:4700
```

Try it:

```bash
curl -s -X POST http://localhost:4700/hack/juggadexe/ask-titan/query \
  -H "Content-Type: application/json" \
  -d '{"query":"who am I waiting for"}'
```

Set `OPENAI_API_KEY` in your environment to enable real LLM-backed answers
(`/ask-titan/query` returns `503 AI_UNAVAILABLE` without it).

## Endpoints

- `GET  /hack/juggadexe/waiting-on` — who the user is waiting on
- `GET  /hack/juggadexe/commitments` — commitments the user has made
- `POST /hack/juggadexe/ask-titan/query` — body `{ "query": "..." }`
- `POST /hack/juggadexe/security-check` — standalone risk preview, body `{ recipient, body, attachmentName, attachmentType, senderEmail }`. Fails closed: internal errors return `risk: "high", blocked: true`.
- `POST /hack/juggadexe/actions` — creates an action and drives it through `CREATED → PLANNED → SECURITY_CHECK → AWAITING_APPROVAL` (or `BLOCKED` if high risk). Body: `{ personEmail, personName, bodyOverride?, attachmentName?, attachmentType?, senderEmail? }`
- `GET  /hack/juggadexe/actions/:id` — fetch current action state
- `POST /hack/juggadexe/actions/:id/approve` — body `{ idempotencyKey }`. Only progresses actions in `AWAITING_APPROVAL`; repeat calls are no-ops that return the existing result (safe against double-clicks). `BLOCKED` actions can never be approved through this endpoint.
- `POST /hack/juggadexe/actions/:id/cancel` — moves `AWAITING_APPROVAL` → `CANCELLED`; no-op otherwise

## Demo script (for judges)

1. `GET /hack/juggadexe/waiting-on` and `/commitments` — deterministic,
   rule-based extraction from the mailbox, no AI involved.
2. `POST /hack/juggadexe/ask-titan/query` with `{"query":"who am I waiting on?"}`
   — LLM classifies + phrases the answer, grounded in that same data.
3. `POST /hack/juggadexe/actions` with a `personEmail` outside your org domain
   and a body mentioning something sensitive (e.g. "bank account") — watch it
   land in `BLOCKED` with `reasons` explaining exactly why.
4. `POST /hack/juggadexe/actions` with a routine follow-up — watch it land in
   `AWAITING_APPROVAL`, then `POST .../approve` to complete it. Call
   `/approve` twice with the same `idempotencyKey` to show it's a no-op the
   second time.

## What's mocked vs. real

- **Mailbox data** (`src/data/mailbox.mock.json`): fully mocked, matches
  Titan's thread/message shape closely enough to swap for real reads — the
  service already accepts real thread/message data from the client and only
  falls back to the mock when none is sent (see `buildMailboxContext` in
  [`llm.service.js`](src/services/llm.service.js)).
- **Query answering** ([`ask-titan.service.js`](src/services/ask-titan.service.js)):
  live LLM call (OpenAI `gpt-4o`) for classification and phrasing; the
  structured data returned to the frontend always comes from our own
  deterministic functions, never from the model.
- **Waiting-on, commitments, security guardrail**: fully deterministic,
  rule-based logic — not mocked, this is how they should work even in a
  production version. Security decisions must never be delegated to an LLM.

## Roadmap

- `ask-titan` frontend module in the `nike` repo
  (`temp_hackathon_2026_juggadexe` branch) calling this service.
- Swap the in-memory action store for a `hack_juggadexe_actions` table if
  persistence across restarts is needed.
- AI Activity/transparency panel using the `accessed` field already returned
  by `/ask-titan/query`.
