import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  CURATOR,
  candidatesFile,
  digestFile,
  runNode,
  withTempRoot,
  writePhase,
} from './helpers.mjs';

const DAY = '2026-03-10'; // Tuesday, so the weekly auto-pass is off.
const MONDAY = '2026-03-09'; // Monday, so the weekly auto-pass is on.

function longBlobCandidate() {
  const lines = ['- Candidate: Historical narrative with a lot of detail to process.'];
  for (let i = 1; i <= 12; i += 1) {
    lines.push(`  - detail clause number ${i} describing what happened during that block of time`);
  }
  lines.push('  - confidence: 0.4');
  lines.push(`  - evidence: memory/${DAY}.md:6-6`);
  return lines.join('\n') + '\n';
}

function richLightFixture() {
  return [
    '- Candidate: Communication Preference: The user prefers long summaries split into natural sections.',
    '  - confidence: 0.85',
    '  - evidence: memory/2026-03-09.md:1-1',
    '  - status: pending',
    '- Candidate: Lesson learned: the gateway failed after restart until the config was corrected.',
    '  - confidence: 0.8',
    '  - evidence: memory/2026-01-01.md:3-3',
    '- Candidate: Media attached: image of the dashboard.',
    '  - confidence: 0.9',
    '  - evidence: memory/2026-03-09.md:2-2',
    '- Candidate: Newsletter: system report for the day covering operational status.',
    '  - confidence: 0.9',
    '  - evidence: memory/2026-03-09.md:3-3',
    '- Candidate: Food / health log: breakfast 500 kcal, lunch salad 300 kcal, running total 800 kcal.',
    '  - confidence: 0.6',
    '  - evidence: memory/2026-03-09.md:4-4',
    '- Candidate: Food / health log: static health rule always breakfast 500 kcal and lunch salad.',
    '  - confidence: 0.7',
    '  - evidence: memory/2026-03-09.md:5-5',
    '- Candidate: Research notes: GPU model estimates, vacation options, and food log corrections were discussed.',
    '  - confidence: 0.6',
    '  - evidence: memory/2026-03-09.md:6-6',
    '- Candidate: Something happened today without a durable signal.',
    '  - confidence: 0.5',
    '  - evidence: memory/2026-03-09.md:7-7',
    '- Candidate: Model decision: OpenRouter is configured as the fallback for background workers.',
    '  - also used by deepseek for cheap completions',
    '  - confidence: 0.9',
    '  - evidence: memory/2026-03-10.md:2-2',
    '  - status: pending',
    '- Candidate: Todo: follow up on the backup migration project next week.',
    '  - confidence: 0.7',
    '  - evidence: memory/2026-03-10.md:3-3',
    "- Candidate: Family health: the user's daughter is allergic and this is a rule to always avoid peanuts.",
    '  - confidence: 0.8',
    '  - evidence: memory/2026-03-10.md:4-4',
    '- Candidate: Rule: always cite the source file for durable facts.',
    '  - confidence: 0.75',
    '  - evidence: MEMORY.md',
    '- Candidate: To send an image back, attach the file first.',
    '  - confidence: 0.6',
    '  - evidence: memory/2026-03-10.md:5-5',
    '- Candidate:',
    '  - confidence: 0.5',
    '- Candidate: Preference: the user prefers concise reports and short status updates.',
    '  - confidence: 0.5',
    '- Candidate: Rule: always run the full test suite before committing.',
    '  - confidence: 0.5',
    '  - evidence: memory/2026-03-09.md:8-8',
    longBlobCandidate(),
  ].join('\n');
}

test('curator reports status unavailable when no phase input exists at all', () => {
  withTempRoot((root) => {
    const day = '2026-02-01';
    const stdout = runNode(CURATOR, [day], root);
    assert.match(stdout, /Input status: UNAVAILABLE/);
    assert.match(stdout, /No phase files exist at all/);

    const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
    assert.equal(report.status, 'unavailable');
    assert.match(report.missingInput, /No dreaming phase input found/);
    assert.deepEqual(report.candidates, []);
  });
});

test('curator names the newest unrelated phase file when the day is missing', () => {
  withTempRoot((root) => {
    writePhase(root, '2026-02-02', 'light', '- Candidate: The user prefers tea.\n');
    const stdout = runNode(CURATOR, ['2026-02-03'], root);
    assert.match(stdout, /Newest available phase file is 2026-02-02\.md/);
  });
});

test('curator treats a partial phase set as unavailable', () => {
  withTempRoot((root) => {
    writePhase(root, '2026-02-04', 'light', '- Candidate: The user prefers tea.\n');
    const stdout = runNode(CURATOR, ['2026-02-04'], root);
    assert.match(stdout, /Input status: UNAVAILABLE/);
    assert.match(stdout, /missing rem, deep/);
  });
});

test('curator emits a full digest and canonical report from rich phase input', () => {
  withTempRoot((root) => {
    writePhase(root, DAY, 'light', richLightFixture());
    writePhase(root, DAY, 'rem', '# REM phase notes with no candidates\n');
    writePhase(root, DAY, 'deep', '# Deep phase notes with no candidates\n');

    // Daily notes drive contradiction/todo hygiene signals and recentness scoring.
    fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'memory', '2026-03-09.md'),
      [
        '# 2026-03-09',
        '',
        '- TODO: review the migration plan.',
        '- backup folder permissions marked done',
        '',
      ].join('\n'),
    );

    const stdout = runNode(CURATOR, [DAY], root);
    assert.match(stdout, /Input status: ok/);
    assert.match(stdout, /Contradiction signals: 1/);
    assert.match(stdout, /Todo hygiene signals: 1/);

    const report = JSON.parse(fs.readFileSync(candidatesFile(root, DAY), 'utf8'));
    assert.equal(report.status, 'ok');
    assert.equal(report.missingInput, null);
    assert.equal(report.mode, 'report-only');
    assert.ok(report.candidates.length > 0);

    const titles = report.candidates.map((candidate) => candidate.title).join('\n');
    assert.match(titles, /Communication preferences/);
    assert.match(titles, /Model decision/);
    assert.match(titles, /Family health/);
    assert.ok(report.candidates.every((candidate) => candidate.status === 'pending'));

    const digest = fs.readFileSync(digestFile(root, DAY), 'utf8');
    assert.match(digest, /## Candidate Review Queue/);
    assert.match(digest, /## Low-Confidence \/ Noise Review/);
    assert.match(digest, /## Rejected by Quality Gate/);
    assert.match(digest, /Not due today/);
  });
});

test('curator treats an unreadable phase path as empty input', () => {
  withTempRoot((root) => {
    const day = '2026-02-10';
    for (const phase of ['light', 'rem', 'deep']) {
      fs.mkdirSync(path.join(root, 'memory', 'dreaming', phase, `${day}.md`), { recursive: true });
    }
    const stdout = runNode(CURATOR, [day], root);
    assert.match(stdout, /Input status: ok/);
    assert.match(stdout, /Review candidates: 0/);
  });
});

test('curator marks weekly curation due from the --weekly flag', () => {
  withTempRoot((root) => {
    writePhase(root, DAY, 'light', '- Candidate: The user prefers tea.\n');
    writePhase(root, DAY, 'rem', '# rem\n');
    writePhase(root, DAY, 'deep', '# deep\n');
    const stdout = runNode(CURATOR, [DAY, '--weekly'], root);
    assert.match(stdout, /Input status: ok/);
    const digest = fs.readFileSync(digestFile(root, DAY), 'utf8');
    assert.match(digest, /Weekly pass is due/);
  });
});

test('curator marks weekly curation due automatically on Mondays', () => {
  withTempRoot((root) => {
    writePhase(root, MONDAY, 'light', '- Candidate: The user prefers tea.\n');
    writePhase(root, MONDAY, 'rem', '# rem\n');
    writePhase(root, MONDAY, 'deep', '# deep\n');
    runNode(CURATOR, [MONDAY], root);
    const digest = fs.readFileSync(digestFile(root, MONDAY), 'utf8');
    assert.match(digest, /Weekly pass is due/);
  });
});
