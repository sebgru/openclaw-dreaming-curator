import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CURATOR,
  DELIVERY,
  candidatesFile,
  digestFile,
  runNode,
  withTempRoot,
  writeDailyNote,
  writeIndex,
  writeOutputFile,
} from './helpers.mjs';

// Regression test for the §5B fail-safe chain:
// 1. dreaming-curator.mjs must report status: 'unavailable' (never a silent
//    empty candidate list) when an approved source (outputs/INDEX.md, a
//    registered output file, or an existing-but-unreadable daily note) cannot
//    be enumerated or read.
// 2. dreaming-review-delivery.mjs must refuse to render anything — even a
//    non-empty candidates array — when the canonical file says 'unavailable'.
// Both scripts treat process.cwd() as the data root, so they can be run
// unmodified against a disposable temp directory instead of the real
// workspace.

// --- Case 1: missing outputs/INDEX.md must produce status 'unavailable' ----
withTempRoot((root) => {
  const day = '2026-01-01'; // deterministic day with no approved sources at all
  const stdout = runNode(CURATOR, [day], root);
  assert.match(stdout, /Input status: UNAVAILABLE/, 'curator stdout should flag unavailable input');

  const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
  assert.equal(report.status, 'unavailable');
  assert.ok(
    report.missingInput && report.missingInput.includes('outputs/INDEX.md'),
    'missingInput must name the unreadable/missing approved source',
  );
  assert.deepEqual(report.candidates, []);

  const digest = fs.readFileSync(digestFile(root, day), 'utf8');
  assert.match(digest, /INCOMPLETE\/UNAVAILABLE/);
});

// --- Case 2: a readable but empty set of approved sources is a healthy 'ok'
// report with zero candidates — not an error. --------------------------------
withTempRoot((root) => {
  const day = '2026-01-02';
  writeIndex(root, []);
  const stdout = runNode(CURATOR, [day], root);
  assert.match(stdout, /Input status: ok/);
  const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
  assert.equal(report.status, 'ok');
  assert.equal(report.missingInput, null);
  assert.deepEqual(report.candidates, []);
});

// --- Case 2b: a registered output entry whose file is missing from disk must
// be treated as incomplete, not silently skipped. ---------------------------
withTempRoot((root) => {
  const day = '2026-01-05';
  writeIndex(root, [{ date: day, file: `outputs/${day}/ghost.md`, title: 'Ghost' }]);
  // Registered file deliberately absent.
  const stdout = runNode(CURATOR, [day], root);
  assert.match(
    stdout,
    /Input status: UNAVAILABLE/,
    'curator stdout should flag a registered-but-missing output as unavailable',
  );

  const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
  assert.equal(report.status, 'unavailable');
  assert.match(
    report.missingInput,
    /missing on disk/,
    'missingInput must name the registered output that could not be found',
  );
  assert.deepEqual(report.candidates, []);

  const digest = fs.readFileSync(digestFile(root, day), 'utf8');
  assert.match(digest, /INCOMPLETE\/UNAVAILABLE/);

  // End-to-end: delivery against the curator's own unavailable output must
  // also fail closed, not just against a hand-crafted fixture (Case 3 below).
  const deliveryStdout = runNode(DELIVERY, [day, '1'], root);
  assert.equal(
    deliveryStdout.trim(),
    'NO_REPLY',
    'delivery must refuse an unavailable report from the registered-output path too',
  );
});

// --- Case 2c: a daily note that exists but can't be read as a file (e.g. a
// path collision) must be treated as unavailable, while a day with no note at
// all is tolerated by the rolling lookback window. ---------------------------
withTempRoot((root) => {
  const day = '2026-01-07';
  writeIndex(root, []);
  fs.mkdirSync(path.join(root, 'memory', `${day}.md`), { recursive: true });
  const stdout = runNode(CURATOR, [day], root);
  assert.match(stdout, /Input status: UNAVAILABLE/);
  const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
  assert.match(report.missingInput, /daily note\(s\) exist but could not be read/);
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

// --- Case 5: end-to-end healthy path — real curator run with real daily-note
// and registered-output sources produces a deliverable candidate. ----------
withTempRoot((root) => {
  const day = '2026-01-08';
  writeIndex(root, [{ date: day, file: `outputs/${day}/decision.md`, title: 'Decision' }]);
  writeOutputFile(
    root,
    `outputs/${day}/decision.md`,
    '- Decision: the user always prefers tea over coffee in the evening.\n',
  );
  writeDailyNote(root, day, '- Routine log entry with no durable signal in it whatsoever.\n');
  runNode(CURATOR, [day], root);
  const deliveryStdout = runNode(DELIVERY, [day, '1'], root);
  assert.match(deliveryStdout, /tea over coffee/);
});

console.log('dreaming unavailable/missing-input + fail-closed delivery guard tests passed');
