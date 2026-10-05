import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Regression test for the §5B fail-safe chain:
// 1. dreaming-curator.mjs must report status: 'unavailable' (never a silent
//    empty candidate list) when no phase input file exists for the day.
// 2. dreaming-review-delivery.mjs must refuse to render anything — even a
//    non-empty candidates array — when the canonical file says 'unavailable'.
// Both scripts resolve their own imports relative to their file location and
// treat process.cwd() as the data root, so they can be run unmodified against
// a disposable temp directory instead of the real workspace memory/ tree.

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const CURATOR = path.join(SCRIPTS_DIR, 'dreaming-curator.mjs');
const DELIVERY = path.join(SCRIPTS_DIR, 'dreaming-review-delivery.mjs');

function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dreaming-guard-test-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runNode(script, args, cwd) {
  return execFileSync('node', [script, ...args], { cwd, encoding: 'utf8' });
}

function candidatesFile(root, day) {
  return path.join(root, 'memory', 'review-candidates', `${day}-promotion-candidates.json`);
}

// --- Case 1: missing phase input must produce status 'unavailable' ---------
withTempRoot((root) => {
  const day = '2026-01-01'; // deterministic day with no phase files anywhere
  const stdout = runNode(CURATOR, [day], root);
  assert.match(stdout, /Input status: UNAVAILABLE/, 'curator stdout should flag unavailable input');

  const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
  assert.equal(report.status, 'unavailable');
  assert.ok(
    report.missingInput && report.missingInput.includes(day),
    'missingInput must name the day',
  );
  assert.deepEqual(report.candidates, []);

  const digest = fs.readFileSync(
    path.join(root, 'memory', 'dreaming', 'digests', `${day}.md`),
    'utf8',
  );
  assert.match(digest, /INCOMPLETE\/UNAVAILABLE/);
});

// --- Case 2: a complete light+rem+deep phase set must produce status 'ok'.
// The built-in dreaming plugin emits the three phases as one sweep. This
// fixture reflects the complete-input contract. -----------------------------
withTempRoot((root) => {
  const day = '2026-01-02';
  for (const phase of ['light', 'rem', 'deep']) {
    const dir = path.join(root, 'memory', 'dreaming', phase);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${day}.md`),
      [
        '- Candidate: The user prefers tea over coffee in the evening.',
        '  - confidence: 0.8',
        '  - evidence: memory/2026-01-02.md:5-5',
        '  - status: pending',
        '',
      ].join('\n'),
    );
  }
  runNode(CURATOR, [day], root);
  const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
  assert.equal(report.status, 'ok');
  assert.equal(report.missingInput, null);
});

// --- Case 2b: a partial phase set (only some of light/rem/deep present) must
// be treated as incomplete, not as a healthy reduced-scope result. ----------
withTempRoot((root) => {
  const day = '2026-01-05';
  const lightDir = path.join(root, 'memory', 'dreaming', 'light');
  fs.mkdirSync(lightDir, { recursive: true });
  fs.writeFileSync(
    path.join(lightDir, `${day}.md`),
    [
      '- Candidate: The user prefers tea over coffee in the evening.',
      '  - confidence: 0.8',
      '  - evidence: memory/2026-01-05.md:5-5',
      '  - status: pending',
      '',
    ].join('\n'),
  );
  // rem and deep deliberately absent.
  const stdout = runNode(CURATOR, [day], root);
  assert.match(
    stdout,
    /Input status: UNAVAILABLE/,
    'curator stdout should flag a partial phase set as unavailable',
  );

  const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
  assert.equal(report.status, 'unavailable');
  assert.match(
    report.missingInput,
    /missing rem, deep/,
    'missingInput must name the specific missing phases',
  );
  assert.match(
    report.missingInput,
    /present: light/,
    'missingInput must name the phase(s) that were present',
  );
  assert.deepEqual(report.candidates, []);

  const digest = fs.readFileSync(
    path.join(root, 'memory', 'dreaming', 'digests', `${day}.md`),
    'utf8',
  );
  assert.match(digest, /INCOMPLETE\/UNAVAILABLE/);

  // End-to-end: delivery against the curator's own partial-input output must
  // also fail closed, not just against a hand-crafted fixture (Case 3 below).
  const deliveryStdout = runNode(DELIVERY, [day, '1'], root);
  assert.equal(
    deliveryStdout.trim(),
    'NO_REPLY',
    'delivery must refuse a partial-phase-set unavailable report too',
  );
});

// --- Case 3: fail-closed guard refuses rendering when status is 'unavailable',
//     even if a stale/malformed digest still carries candidates. -----------
withTempRoot((root) => {
  const day = '2026-01-03';
  const reviewDir = path.join(root, 'memory', 'review-candidates');
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(
    candidatesFile(root, day),
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        mode: 'report-only',
        status: 'unavailable',
        missingInput: 'synthetic unavailable fixture',
        note: 'test fixture',
        candidates: [
          {
            text: 'The user prefers tea over coffee in the evening.',
            title: 'Evening beverage preference',
            proposal: 'The user prefers tea over coffee in the evening.',
            why: 'Stated preference.',
            target: 'USER.md',
            evidence: 'memory/2026-01-03.md:1-1',
            sourceFile: 'memory/2026-01-03.md',
            score: 0.9,
            confidence: 0.8,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  const stdout = runNode(DELIVERY, [day, '1'], root);
  assert.equal(
    stdout.trim(),
    'NO_REPLY',
    'renderer must refuse an unavailable-status report regardless of candidates',
  );
});

// --- Case 3b: malformed or unknown canonical envelopes must fail closed. ---
withTempRoot((root) => {
  const day = '2026-01-06';
  const reviewDir = path.join(root, 'memory', 'review-candidates');
  fs.mkdirSync(reviewDir, { recursive: true });
  const validEnvelope = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'report-only',
    status: 'ok',
    missingInput: null,
    note: 'test fixture',
    candidates: [
      {
        text: 'The user prefers tea over coffee in the evening.',
        title: 'Evening beverage preference',
        proposal: 'The user prefers tea over coffee in the evening.',
        why: 'Stated preference.',
        target: 'USER.md',
        evidence: 'memory/2026-01-06.md:1-1',
        sourceFile: 'memory/2026-01-06.md',
        score: 0.9,
        confidence: 0.8,
      },
    ],
  };
  const malformed = [
    { ...validEnvelope, schemaVersion: 2 },
    { ...validEnvelope, schemaVersion: undefined },
    { ...validEnvelope, generatedAt: 'not-a-date' },
    { ...validEnvelope, status: 'error' },
    { ...validEnvelope, status: 'ok', missingInput: 'missing producer input' },
    { ...validEnvelope, status: 'unavailable', missingInput: null },
  ];
  for (const [index, report] of malformed.entries()) {
    fs.writeFileSync(candidatesFile(root, day), JSON.stringify(report, null, 2) + '\n');
    const stdout = runNode(DELIVERY, [day, '1'], root);
    assert.equal(
      stdout.trim(),
      'NO_REPLY',
      `malformed canonical envelope ${index + 1} must not render`,
    );
  }
});

// --- Case 4: sanity check — a healthy 'ok' report with a valid candidate
//     still renders normally (guard is status-specific, not overbroad). ----
withTempRoot((root) => {
  const day = '2026-01-04';
  const reviewDir = path.join(root, 'memory', 'review-candidates');
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(
    candidatesFile(root, day),
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        mode: 'report-only',
        status: 'ok',
        missingInput: null,
        note: 'test fixture',
        candidates: [
          {
            text: 'The user prefers tea over coffee in the evening.',
            title: 'Evening beverage preference',
            proposal: 'The user prefers tea over coffee in the evening.',
            why: 'Stated preference.',
            target: 'USER.md',
            evidence: 'memory/2026-01-04.md:1-1',
            sourceFile: 'memory/2026-01-04.md',
            score: 0.9,
            confidence: 0.8,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  const stdout = runNode(DELIVERY, [day, '1'], root);
  assert.match(
    stdout,
    /Evening beverage preference/,
    'a healthy ok-status report with a valid candidate must still render',
  );
  assert.equal(
    runNode(DELIVERY, [day, '1'], root),
    stdout,
    'rendering must be repeatable if transport fails',
  );
  assert.equal(
    fs.existsSync(path.join(root, 'memory', 'dreaming', 'review-state.json')),
    false,
    'stdout rendering must not record confirmed delivery',
  );
});

console.log('dreaming unavailable/missing-input + fail-closed delivery guard tests passed');
