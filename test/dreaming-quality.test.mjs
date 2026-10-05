import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessCandidate,
  cleanText,
  hasFragmentaryShape,
  isMultiTopic,
  isStaleOperationalBlob,
  proposalFor,
} from '../scripts/dreaming-quality.mjs';

test('cleanText trims, collapses whitespace, and strips leading markers', () => {
  assert.equal(cleanText('  a   b \n'), 'a b');
  assert.equal(cleanText('##   Heading'), 'Heading');
  assert.equal(cleanText('- item'), 'item');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText(null), '');
});

test('hasFragmentaryShape flags empty, clipped, dangling, and chat-shaped text', () => {
  assert.equal(hasFragmentaryShape(''), true);
  assert.equal(hasFragmentaryShape('Anything', 'x'.repeat(601)), true);
  assert.equal(hasFragmentaryShape('Trailing colon:'), true);
  assert.equal(hasFragmentaryShape('ends with the'), true);
  assert.equal(hasFragmentaryShape('and then it happened'), true);
  assert.equal(hasFragmentaryShape('assistant: hello there'), true);
  assert.equal(hasFragmentaryShape('```code```'), true);
  assert.equal(hasFragmentaryShape('A complete sentence.'), false);
});

test('isStaleOperationalBlob detects dated headings, stale labels and history blobs', () => {
  assert.equal(isStaleOperationalBlob('# 2026-05-24 archived notes'), true);
  assert.equal(isStaleOperationalBlob('item 1: replaced the cron job'), true);
  assert.equal(isStaleOperationalBlob('notes # A # B'), true);
  assert.equal(isStaleOperationalBlob('gateway healthy and cron alive'), true);
  assert.equal(isStaleOperationalBlob('gateway healthy ' + 'x'.repeat(420)), true);
  assert.equal(isStaleOperationalBlob('A durable rule about naming.'), false);
});

test('isMultiTopic flags multi-heading, multi-clause and multi-domain text', () => {
  assert.equal(isMultiTopic('notes # A # B'), true);
  assert.equal(isMultiTopic('GPU model estimates and vacation options'), true);
  assert.equal(isMultiTopic('one; Two; Three; Four; Five'), true);
  assert.equal(isMultiTopic('A single coherent topic.'), false);
});

test('assessCandidate accepts a coherent durable preference', () => {
  const preference = {
    text: 'Communication Preference: The user prefers long summaries split into natural sections.',
    categories: ['stable-preference'],
  };
  const accepted = assessCandidate(preference);
  assert.equal(accepted.accepted, true, accepted.reasons.join('; '));
  assert.match(proposalFor(preference).title, /^Communication preferences —/);
  assert.match(proposalFor(preference).proposal, /long summaries/);
});

test('assessCandidate rejects internal control markers', () => {
  for (const marker of ['ANNOUNCE_SKIP', 'NO_REPLY', 'HEARTBEAT_OK']) {
    assert.equal(
      assessCandidate({ text: `Preference: keep ${marker} internal.` }).accepted,
      false,
      marker,
    );
  }
  assert.equal(
    assessCandidate({ text: 'Preference: internal control marker leaked.' }).accepted,
    false,
  );
});

test('assessCandidate rejects fragmentary sources', () => {
  assert.equal(hasFragmentaryShape('OpenClaw Patch: validation passed and the f'), true);
  assert.equal(
    assessCandidate({ text: 'OpenClaw Patch: validation passed and the f' }).accepted,
    false,
  );
});

test('assessCandidate rejects stale operational blobs', () => {
  const history =
    'Cron Changes: replaced several live jobs, changed fallbacks, and verified the running Gateway after restart.';
  assert.equal(isStaleOperationalBlob(history), true);
  assert.equal(assessCandidate({ text: history }).accepted, false);
  assert.equal(
    assessCandidate({ text: '# 2026-05-24 — archived daily notes and timezone discussion.' })
      .accepted,
    false,
  );
});

test('assessCandidate rejects multi-topic text without one coherent fact', () => {
  const unrelated =
    'Research notes: GPU model estimates, vacation options, and food log corrections were discussed.';
  assert.equal(isMultiTopic(unrelated), true);
  assert.equal(assessCandidate({ text: unrelated }).accepted, false);
});

test('assessCandidate allows a coherent decision that mentions several topics', () => {
  const coherent =
    'Model decision: OpenRouter is configured as fallback; family vacation is planned; health log updated.';
  assert.equal(isMultiTopic(coherent), true);
  assert.equal(assessCandidate({ text: coherent }).accepted, true);
});

test('assessCandidate flags active tasks and missing durable signal', () => {
  const actionItem = assessCandidate({ text: 'Action item: ship the release.' });
  assert.equal(actionItem.accepted, false);
  assert.ok(actionItem.reasons.includes('active task rather than durable fact/decision'));
  assert.ok(actionItem.reasons.includes('no clear durable fact or decision'));

  const noSignal = assessCandidate({ text: 'Random observation about the weather.' });
  assert.equal(noSignal.accepted, false);
  assert.ok(noSignal.reasons.includes('no clear durable fact or decision'));
});

test('proposalFor humanizes labels and truncates over-long text', () => {
  const short = proposalFor({ text: 'The user prefers tea.', categories: [] });
  assert.equal(short.title, 'The user prefers tea.');

  const long = proposalFor({ text: 'x'.repeat(95) });
  assert.ok(long.title.endsWith('…'));
  assert.ok(long.title.length <= 90);

  const emDash = proposalFor({ text: 'Model — fallback: OpenRouter is configured.' });
  assert.equal(emDash.title, 'Model — fallback');

  const longDetail = proposalFor({
    text: 'Preference: The user prefers very long summaries that go on and on and on forever.',
  });
  assert.match(longDetail.title, /^preferences — /);
  assert.ok(longDetail.title.endsWith('…'));

  const longProposal = proposalFor({ text: 'Fact: ' + 'y'.repeat(320) });
  assert.ok(longProposal.proposal.endsWith('…'));
  assert.ok(longProposal.proposal.length <= 300);
});

test('proposalFor picks a rationale per category', () => {
  assert.match(
    proposalFor({ text: 'Rule: always A.', categories: ['stable-preference'] }).why,
    /standing preference/,
  );
  assert.match(
    proposalFor({ text: 'Lesson: B.', categories: ['lesson-or-failure'] }).why,
    /lesson/,
  );
  assert.match(
    proposalFor({ text: 'Family: C.', categories: ['family-travel-health'] }).why,
    /personal fact/,
  );
  assert.match(
    proposalFor({ text: 'Config: D.', categories: ['infrastructure-decision'] }).why,
    /operational decision/,
  );
  assert.match(
    proposalFor({ text: 'Fact: E.', categories: ['uncategorized'] }).why,
    /durable fact that may be useful/,
  );
});

test('assessCandidate tolerates an empty or malformed candidate object', () => {
  assert.equal(assessCandidate().accepted, false);
  assert.equal(assessCandidate({}).accepted, false);
  assert.equal(assessCandidate({ text: '   ' }).accepted, false);
});
