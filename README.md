# juggadexe-titan-service

Standalone backend for the Ask Titan hackathon feature. Per the hackathon
guidelines: this is its own service, makes no changes to existing Titan
services or tables, and every route is prefixed `/hack/juggadexe`.

## Run it

```bash
npm install
npm start        # http://localhost:4700
```

## Endpoints (Milestone 1 + state machine update)

- `GET  /hack/juggadexe/waiting-on` — who the user is waiting on
- `GET  /hack/juggadexe/commitments` — commitments the user has made
- `POST /hack/juggadexe/ask-titan/query` — body `{ "query": "..." }`
- `POST /hack/juggadexe/security-check` — standalone risk preview, body `{ recipient, body, attachmentName, attachmentType, senderEmail }`. Fails closed: internal errors return `risk: "high", blocked: true`.
- `POST /hack/juggadexe/actions` — creates an action and drives it through `CREATED → PLANNED → SECURITY_CHECK → AWAITING_APPROVAL` (or `BLOCKED` if high risk). Body: `{ personEmail, personName, bodyOverride?, attachmentName?, attachmentType?, senderEmail? }`
- `GET  /hack/juggadexe/actions/:id` — fetch current action state
- `POST /hack/juggadexe/actions/:id/approve` — body `{ idempotencyKey }`. Only progresses actions in `AWAITING_APPROVAL`; repeat calls are no-ops that return the existing result (safe against double-clicks). `BLOCKED` actions can never be approved through this endpoint.
- `POST /hack/juggadexe/actions/:id/cancel` — moves `AWAITING_APPROVAL` → `CANCELLED`; no-op otherwise

### Action states
`CREATED → PLANNED → SECURITY_CHECK → AWAITING_APPROVAL → APPROVED → EXECUTING → COMPLETED`, with `BLOCKED / CANCELLED / FAILED / EXPIRED` as terminal states. Transitions are validated in `action-state.service.js` — nothing else is allowed to mutate `action.state` directly. Actions are stored in-memory (fine for a single-instance demo); swap for a `hack_juggadexe_actions` table if you need persistence.

## What's mocked vs. real

- **Mailbox data** (`src/data/mailbox.mock.json`): fully mocked, matches
  Titan's thread/message shape closely enough to swap for real reads later.
- **Query answering** (`src/services/ask-titan.service.js`): currently
  keyword-routed, not an LLM call. This is the one file to change when you
  wire up a real model — pass it the *extracted* waiting-on/commitment data
  as context (not raw email bodies) to keep the prompt small and reduce PII
  exposure.
- **Waiting-on, commitments, security guardrail**: fully deterministic
  rule-based logic — not mocked, this is how they should work even in a
  production version. Security decisions must never be delegated to an LLM.

## Next milestones

- Milestone 2: `ask-titan` frontend module in the `nike` repo
  (`temp_hackathon_2026_juggadexe` branch) calling this service.
- Milestone 3: swap `ask-titan.service.js`'s keyword logic for a real LLM call.
- Milestone 4: AI Activity/transparency panel using the `accessed` field
  already returned by `/ask-titan/query`.
