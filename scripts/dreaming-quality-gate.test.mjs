import assert from 'node:assert/strict';
import {
  assessCandidate,
  hasFragmentaryShape,
  isMultiTopic,
  isStaleOperationalBlob,
  proposalFor,
} from './dreaming-quality.mjs';

const preference = {
  text: 'Communication Preference: The user prefers long summaries split into natural sections.',
  categories: ['stable-preference'],
};
const accepted = assessCandidate(preference);
assert.equal(accepted.accepted, true, accepted.reasons.join('; '));
assert.match(proposalFor(preference).title, /^Communication preferences —/);
assert.match(proposalFor(preference).proposal, /long summaries/);

for (const marker of ['ANNOUNCE_SKIP', 'NO_REPLY', 'HEARTBEAT_OK']) {
  assert.equal(assessCandidate({ text: `Preference: keep ${marker} internal.` }).accepted, false, marker);
}

assert.equal(hasFragmentaryShape('OpenClaw Patch: validation passed and the f'), true);
assert.equal(assessCandidate({ text: 'OpenClaw Patch: validation passed and the f' }).accepted, false);

const history = 'Cron Changes: replaced several live jobs, changed fallbacks, and verified the running Gateway after restart.';
assert.equal(isStaleOperationalBlob(history), true);
assert.equal(assessCandidate({ text: history }).accepted, false);
assert.equal(assessCandidate({ text: '# 2026-05-24 — archived daily notes and timezone discussion.' }).accepted, false);

const unrelated = 'Research notes: GPU model estimates, vacation options, and food log corrections were discussed.';
assert.equal(isMultiTopic(unrelated), true);
assert.equal(assessCandidate({ text: unrelated }).accepted, false);

const oneDecision = {
  text: 'Model decision: OpenRouter is configured as the fallback for background workers.',
  categories: ['infrastructure-decision'],
};
assert.equal(assessCandidate(oneDecision).accepted, true);

console.log('dreaming quality gate tests passed');
