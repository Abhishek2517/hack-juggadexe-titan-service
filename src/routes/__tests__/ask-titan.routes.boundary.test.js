const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../../app');
const boundary = require('../../services/boundary.service');

const PREFIX = '/hack/juggadexe';

test.afterEach(() => {
  boundary.listRules().forEach((r) => boundary.deleteRule(r.id));
});

// --- CRUD ---

test('POST creates a rule, GET lists it, DELETE removes it', async () => {
  const create = await request(app)
    .post(`${PREFIX}/boundary-rules`)
    .send({ ruleType: 'contact', value: 'jane@med.com', enforcementMode: 'complete_exclusion' });
  assert.equal(create.status, 201);
  assert.ok(create.body.id);

  const list = await request(app).get(`${PREFIX}/boundary-rules`);
  assert.equal(list.status, 200);
  assert.equal(
    list.body.items.some((r) => r.id === create.body.id),
    true
  );

  const del = await request(app).delete(`${PREFIX}/boundary-rules/${create.body.id}`);
  assert.equal(del.status, 204);

  const listAfter = await request(app).get(`${PREFIX}/boundary-rules`);
  assert.equal(
    listAfter.body.items.some((r) => r.id === create.body.id),
    false
  );
});

test('POST returns 400 with an error code for an invalid rule', async () => {
  const res = await request(app)
    .post(`${PREFIX}/boundary-rules`)
    .send({ ruleType: 'nope', value: 'x', enforcementMode: 'complete_exclusion' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_RULE_TYPE');
});

test('DELETE returns 404 for an unknown id', async () => {
  const res = await request(app).delete(`${PREFIX}/boundary-rules/nope`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'RULE_NOT_FOUND');
});

// --- Ingestion gate (waiting-on / commitments) ---

test('GET /waiting-on redacts a complete_exclusion folder rule match instead of dropping it', async () => {
  await request(app)
    .post(`${PREFIX}/boundary-rules`)
    .send({ ruleType: 'folder', value: '/HR/Compensation', enforcementMode: 'complete_exclusion' });

  const res = await request(app).get(`${PREFIX}/waiting-on`);
  const item = res.body.items.find((i) => i.threadId === 't4');
  assert.ok(item, 'redacted item must still be present, not dropped');
  assert.equal(item.redacted, true);
  assert.equal(item.zoneLabel, 'HR/Compensation');
  assert.equal(item.subject, undefined);
  assert.equal(item.waitingOn, undefined);
});

test('GET /commitments redacts a complete_exclusion folder rule match instead of dropping it', async () => {
  await request(app)
    .post(`${PREFIX}/boundary-rules`)
    .send({ ruleType: 'folder', value: '/HR', enforcementMode: 'complete_exclusion' });

  const res = await request(app).get(`${PREFIX}/commitments`);
  const item = res.body.items.find((i) => i.threadId === 't4');
  assert.ok(item, 'redacted commitment must still be present, not dropped');
  assert.equal(item.redacted, true);
  assert.equal(item.zoneLabel, 'HR');
  assert.equal(item.subject, undefined);
  assert.equal(item.person, undefined);
  assert.equal(item.commitmentText, undefined);
});

// --- Action gate ---

test('a complete_exclusion rule blocks drafting outright at /actions', async () => {
  await request(app)
    .post(`${PREFIX}/boundary-rules`)
    .send({ ruleType: 'contact', value: 'raj@abc.com', enforcementMode: 'complete_exclusion' });

  const res = await request(app)
    .post(`${PREFIX}/actions`)
    .send({ personEmail: 'raj@abc.com', personName: 'Raj' });

  assert.equal(res.status, 201);
  assert.equal(res.body.state, 'BLOCKED');
  assert.ok(res.body.reasons.some((r) => r.includes('boundary rule')));
});

test('a no_external_actions rule allows drafting but blocks send at /approve', async () => {
  await request(app)
    .post(`${PREFIX}/boundary-rules`)
    .send({ ruleType: 'contact', value: 'raj@abc.com', enforcementMode: 'no_external_actions' });

  const create = await request(app)
    .post(`${PREFIX}/actions`)
    .send({ personEmail: 'raj@abc.com', personName: 'Raj' });
  assert.equal(create.status, 201);
  assert.equal(create.body.state, 'AWAITING_APPROVAL');

  const approve = await request(app)
    .post(`${PREFIX}/actions/${create.body.id}/approve`)
    .send({ idempotencyKey: 'key-1' });
  assert.equal(approve.body.state, 'BLOCKED');
  assert.ok(
    approve.body.reasons.some((r) => r.includes('No External Actions'))
  );
});

test('approve is idempotent even for a boundary-blocked action', async () => {
  await request(app)
    .post(`${PREFIX}/boundary-rules`)
    .send({ ruleType: 'contact', value: 'raj@abc.com', enforcementMode: 'no_external_actions' });

  const create = await request(app)
    .post(`${PREFIX}/actions`)
    .send({ personEmail: 'raj@abc.com', personName: 'Raj' });

  const firstApprove = await request(app)
    .post(`${PREFIX}/actions/${create.body.id}/approve`)
    .send({ idempotencyKey: 'key-2' });
  const secondApprove = await request(app)
    .post(`${PREFIX}/actions/${create.body.id}/approve`)
    .send({ idempotencyKey: 'key-2' });

  assert.equal(firstApprove.body.state, 'BLOCKED');
  assert.equal(secondApprove.body.state, 'BLOCKED');
});

// --- Regression: unchanged behavior when no boundary rule matches ---

test('regression: a low-risk internal recipient still reaches AWAITING_APPROVAL with no rules', async () => {
  const res = await request(app)
    .post(`${PREFIX}/actions`)
    .send({ personEmail: 'raj@abc.com', personName: 'Raj' });
  assert.equal(res.body.state, 'AWAITING_APPROVAL');
});

test('regression: the pre-existing security guardrail alone still blocks external+sensitive sends', async () => {
  const res = await request(app)
    .post(`${PREFIX}/actions`)
    .send({
      personEmail: 'john@vendor.com',
      personName: 'John',
      bodyOverride: 'Please see attached salary details for the team.',
    });
  assert.equal(res.body.state, 'BLOCKED');
  assert.equal(res.body.riskLevel, 'high');
});
