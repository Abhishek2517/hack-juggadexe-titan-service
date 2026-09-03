const crypto = require('crypto');

// Per spec: no action may jump straight from PLANNED to EXECUTING, and
// terminal states are final. This table is the single source of truth for
// what transitions are legal — nothing else in the codebase should mutate
// action.state directly.
const TRANSITIONS = {
  CREATED: ['PLANNED', 'FAILED'],
  PLANNED: ['SECURITY_CHECK', 'FAILED'],
  SECURITY_CHECK: ['AWAITING_APPROVAL', 'BLOCKED', 'FAILED'],
  AWAITING_APPROVAL: ['APPROVED', 'CANCELLED', 'EXPIRED'],
  APPROVED: ['EXECUTING'],
  EXECUTING: ['COMPLETED', 'FAILED'],
  // Terminal states — no outgoing transitions.
  COMPLETED: [],
  BLOCKED: [],
  CANCELLED: [],
  FAILED: [],
  EXPIRED: [],
};

const TERMINAL_STATES = ['COMPLETED', 'BLOCKED', 'CANCELLED', 'FAILED', 'EXPIRED'];

// In-memory store — fine for a hackathon demo/single instance. Swap for a
// new `hack_juggadexe_actions` table if you need persistence across restarts.
const actions = new Map();

function createAction({ type, payload }) {
  const id = `action_${crypto.randomUUID()}`;
  const action = {
    id,
    type,
    payload,
    state: 'CREATED',
    riskLevel: null,
    riskScore: null,
    reasons: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvedByIdempotencyKey: null,
  };
  actions.set(id, action);
  return action;
}

function getAction(id) {
  return actions.get(id) || null;
}

/**
 * The only way to move an action forward. Throws on illegal transitions so
 * callers can't accidentally skip a required step (e.g. straight to
 * EXECUTING without APPROVED).
 */
function transition(id, nextState, patch = {}) {
  const action = actions.get(id);
  if (!action) {
    const err = new Error('ACTION_NOT_FOUND');
    err.code = 'ACTION_NOT_FOUND';
    throw err;
  }

  const allowed = TRANSITIONS[action.state] || [];
  if (!allowed.includes(nextState)) {
    const err = new Error(
      `Illegal transition: ${action.state} -> ${nextState}`
    );
    err.code = 'INVALID_STATE_TRANSITION';
    throw err;
  }

  Object.assign(action, patch, {
    state: nextState,
    updatedAt: new Date().toISOString(),
  });
  return action;
}

function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

module.exports = { createAction, getAction, transition, isTerminal, TRANSITIONS };
