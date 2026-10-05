import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  CURATOR,
  candidatesFile,
  digestFile,
  runNode,
  withTempRoot,
  writeDailyNote,
  writeIndex,
  writeOutputFile,
} from './helpers.mjs';

const DAY = '2026-03-10'; // Tuesday, so the weekly auto-pass is off.
const MONDAY = '2026-03-09'; // Monday, so the weekly auto-pass is on.

function richDailyNote() {
  return [
    '# 2026-03-10',
    '',
    '## Memory write pass',
    '',
    '- Communication Preference: the user prefers long summaries split into natural sections.',
    '- Lesson learned: the gateway failed after restart until the config was corrected.',
    '- Media attached: image of the dashboard.',
    '- Newsletter: system report for the day covering operational status.',
    '- Food / health log: breakfast 500 kcal, lunch salad 300 kcal, running total 800 kcal.',
    '- Food / health log: static health rule always breakfast 500 kcal and lunch salad.',
    '- Research notes: GPU model estimates, vacation options, and food log corrections were discussed in detail across the day.',
    '- Something happened today without a durable signal in it at all.',
    '- Model decision: OpenRouter is configured as the fallback for background workers.',
    '- Todo: follow up on the backup migration project next week.',
    "- Family health: the user's daughter is allergic and this is a rule to always avoid peanuts.",
    '- Rule: always cite the source file for durable facts.',
    '- To send an image back, attach the file first.',
    '- Preference: the user prefers concise reports and short status updates.',
    '- Rule: always run the full test suite before committing.',
    '- TODO: review the migration plan.',
    '- backup folder permissions marked done',
    '',
  ].join('\n');
}

test('curator reports status unavailable when outputs/INDEX.md is missing', () => {
  withTempRoot((root) => {
    const day = '2026-02-01';
    const stdout = runNode(CURATOR, [day], root);
    assert.match(stdout, /Input status: UNAVAILABLE/);
    assert.match(stdout, /outputs\/INDEX\.md is missing/);

    const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
    assert.equal(report.status, 'unavailable');
    assert.match(report.missingInput, /outputs\/INDEX\.md/);
    assert.deepEqual(report.candidates, []);
  });
});

test('curator tolerates missing daily notes as long as sources are enumerable', () => {
  withTempRoot((root) => {
    const day = '2026-02-03';
    writeIndex(root, []);
    const stdout = runNode(CURATOR, [day], root);
    assert.match(stdout, /Input status: ok/);
    assert.match(stdout, /Review candidates: 0/);

    const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
    assert.equal(report.status, 'ok');
    assert.equal(report.missingInput, null);
    assert.deepEqual(report.candidates, []);
    assert.equal(report.sources.dailyNotes.found.length, 0);
    assert.equal(report.sources.dailyNotes.missing.length, 7);
  });
});

test('curator treats an unreadable daily note (not merely missing) as unavailable', () => {
  withTempRoot((root) => {
    const day = '2026-02-04';
    writeIndex(root, []);
    // A directory at the expected note path is "exists but unreadable as a file".
    fs.mkdirSync(`${root}/memory/${day}.md`, { recursive: true });
    const stdout = runNode(CURATOR, [day], root);
    assert.match(stdout, /Input status: UNAVAILABLE/);
    assert.match(stdout, /daily note\(s\) exist but could not be read/);
  });
});

test('curator treats an unenumerable memory directory as unavailable', () => {
  withTempRoot((root) => {
    const day = '2026-02-04';
    fs.mkdirSync(`${root}/outputs`, { recursive: true });
    fs.writeFileSync(`${root}/outputs/INDEX.md`, '# Output artifact registry\n\n## Artifacts\n');
    const memoryDir = `${root}/memory`;
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.chmodSync(memoryDir, 0o300); // writable for report output, not enumerable
    try {
      const stdout = runNode(CURATOR, [day], root);
      assert.match(stdout, /Input status: UNAVAILABLE/);
      assert.match(stdout, /memory\/ directory is unreadable/);
    } finally {
      fs.chmodSync(memoryDir, 0o700);
    }
  });
});

test('curator reports an absent daily-note directory before creating its report directory', () => {
  withTempRoot((root) => {
    const day = '2026-02-04';
    fs.mkdirSync(`${root}/outputs`, { recursive: true });
    fs.writeFileSync(`${root}/outputs/INDEX.md`, '# Output artifact registry\n\n## Artifacts\n');

    const stdout = runNode(CURATOR, [day], root);
    assert.match(stdout, /Input status: UNAVAILABLE/);
    assert.match(stdout, /memory\/ directory is missing/);

    const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
    assert.equal(report.status, 'unavailable');
    assert.equal(report.sources.dailyNotes.directoryState, 'missing');
  });
});

test('curator treats a registered output listed but missing from disk as unavailable', () => {
  withTempRoot((root) => {
    const day = '2026-02-05';
    writeIndex(root, [{ date: day, file: `outputs/${day}/ghost.md`, title: 'Ghost artifact' }]);
    const stdout = runNode(CURATOR, [day], root);
    assert.match(stdout, /Input status: UNAVAILABLE/);
    assert.match(stdout, /registered output file\(s\).*are missing on disk/);

    const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
    assert.equal(report.status, 'unavailable');
    assert.deepEqual(report.candidates, []);
  });
});

test('curator rejects registered paths outside outputs without reading them', () => {
  withTempRoot((root) => {
    const day = '2026-02-05';
    writeIndex(root, [{ date: day, file: 'outputs/../outside.md', title: 'Outside path' }]);
    writeOutputFile(
      root,
      'outside.md',
      '- Preference: this outside file must not be read or surfaced as a candidate.\n',
    );

    const stdout = runNode(CURATOR, [day], root);
    assert.match(stdout, /Input status: UNAVAILABLE/);
    assert.match(stdout, /resolve outside outputs/);

    const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
    assert.equal(report.status, 'unavailable');
    assert.deepEqual(report.candidates, []);
    assert.deepEqual(report.sources.registeredOutputs.outsideAllowlist, ['outputs/../outside.md']);
  });
});

test('curator refuses a registered output that is a symlink outside outputs', () => {
  withTempRoot((root) => {
    const day = '2026-02-05';
    const outputDir = `${root}/outputs/${day}`;
    writeIndex(root, [{ date: day, file: `outputs/${day}/linked.md`, title: 'Linked artifact' }]);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      `${root}/outside.md`,
      '- Preference: a symlink target outside outputs must not be read.\n',
    );
    fs.symlinkSync(`${root}/outside.md`, `${outputDir}/linked.md`);

    const stdout = runNode(CURATOR, [day], root);
    assert.match(stdout, /Input status: UNAVAILABLE/);
    assert.match(stdout, /registered output file\(s\) could not be read/);

    const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
    assert.equal(report.status, 'unavailable');
    assert.deepEqual(report.candidates, []);
  });
});

test('curator never reads native memory/dreaming/ phase files (not an approved source)', () => {
  withTempRoot((root) => {
    const day = '2026-02-06';
    writeIndex(root, []);
    writeOutputFile(
      root,
      `memory/dreaming/light/${day}.md`,
      '- Candidate: The user prefers tea.\n  - confidence: 0.95\n',
    );
    const stdout = runNode(CURATOR, [day], root);
    assert.match(stdout, /Input status: ok/);
    // The unapproved phase file must not surface as a review candidate.
    assert.match(stdout, /Review candidates: 0/);
  });
});

test('curator applies the rolling 7-day lookback window to daily notes and registered outputs', () => {
  withTempRoot((root) => {
    const day = '2026-03-10';
    writeIndex(root, [
      // In window (day-6 .. day).
      { date: '2026-03-05', file: 'outputs/2026-03-05/in-window.md', title: 'In window' },
      // Outside window.
      { date: '2026-02-20', file: 'outputs/2026-02-20/too-old.md', title: 'Too old' },
    ]);
    writeOutputFile(
      root,
      'outputs/2026-03-05/in-window.md',
      '- Decision: always route cheap tasks to the configured fallback model.\n',
    );
    writeOutputFile(
      root,
      'outputs/2026-02-20/too-old.md',
      '- Decision: this should never be read because it is outside the window.\n',
    );
    // A daily note inside the window.
    writeDailyNote(root, '2026-03-08', '- Rule: always keep this inside the window.\n');
    // A daily note outside the window (day - 8).
    writeDailyNote(root, '2026-03-02', '- Rule: always keep this outside the window.\n');

    const stdout = runNode(CURATOR, [day], root);
    assert.match(stdout, /Input status: ok/);

    const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
    assert.deepEqual(report.sources.window, { start: '2026-03-04', end: day, days: 7 });
    assert.ok(report.sources.dailyNotes.found.includes('memory/2026-03-08.md'));
    assert.ok(!report.sources.dailyNotes.found.includes('memory/2026-03-02.md'));
    assert.ok(!report.sources.dailyNotes.missing.includes('memory/2026-03-02.md'));
    assert.deepEqual(report.sources.registeredOutputs.found, ['outputs/2026-03-05/in-window.md']);

    const sourceFiles = report.candidates.map((c) => c.sourceFile).join(',');
    assert.doesNotMatch(sourceFiles, /too-old/);
    assert.doesNotMatch(sourceFiles, /2026-03-02/);
  });
});

test('curator parses outputs/INDEX.md entries and skips the literal format-example heading', () => {
  withTempRoot((root) => {
    const day = '2026-03-10';
    // Write a registry containing the literal "## YYYY-MM-DD — Short title"
    // documentation example before the real entries, matching the live file.
    const content = [
      '# Output artifact registry',
      '',
      '## Entry format',
      '',
      '```markdown',
      '## YYYY-MM-DD — Short title',
      '',
      '- **File:** `outputs/YYYY-MM-DD/slug.ext`',
      '```',
      '',
      '## Artifacts',
      '',
      `## ${day} — Real entry`,
      '',
      `- **File:** \`outputs/${day}/real.md\``,
      '- **Type:** Markdown',
      '- **Task:** test',
      '- **Status:** complete',
      '- **Source session:** current session',
      '- **Summary:** test entry.',
      '',
    ].join('\n');
    fs.mkdirSync(`${root}/memory`, { recursive: true });
    fs.mkdirSync(`${root}/outputs`, { recursive: true });
    fs.writeFileSync(`${root}/outputs/INDEX.md`, content);
    writeOutputFile(
      root,
      `outputs/${day}/real.md`,
      '- Decision: always trust only the real registered entry.\n',
    );

    const stdout = runNode(CURATOR, [day], root);
    assert.match(stdout, /Input status: ok/);

    const report = JSON.parse(fs.readFileSync(candidatesFile(root, day), 'utf8'));
    assert.deepEqual(report.sources.registeredOutputs.found, [`outputs/${day}/real.md`]);
    assert.equal(report.sources.registeredOutputs.missing.length, 0);
  });
});

test('curator emits a full digest and canonical report from rich daily-note input', () => {
  withTempRoot((root) => {
    writeIndex(root, []);
    writeDailyNote(root, DAY, richDailyNote());

    const stdout = runNode(CURATOR, [DAY], root);
    assert.match(stdout, /Input status: ok/);
    assert.match(stdout, /Contradiction signals: 1/);
    assert.match(stdout, /Todo hygiene signals: 2/);

    const report = JSON.parse(fs.readFileSync(candidatesFile(root, DAY), 'utf8'));
    assert.equal(report.status, 'ok');
    assert.equal(report.missingInput, null);
    assert.equal(report.mode, 'report-only');
    assert.ok(report.candidates.length > 0);

    const titles = report.candidates.map((candidate) => candidate.title).join('\n');
    assert.match(titles, /Communication preferences/);
    assert.match(titles, /Family health/);
    assert.ok(report.candidates.every((candidate) => candidate.status === 'pending'));
    // Media/newsletter noise and ephemeral meal-ledger entries must never
    // reach the review queue, regardless of how they score.
    assert.doesNotMatch(titles, /Media attached/i);
    assert.doesNotMatch(titles, /Newsletter/i);

    const digest = fs.readFileSync(digestFile(root, DAY), 'utf8');
    assert.match(digest, /## Source Coverage/);
    assert.match(digest, /## Candidate Review Queue/);
    assert.match(digest, /## Low-Confidence \/ Noise Review/);
    assert.match(digest, /Model decision: OpenRouter/);
    assert.match(digest, /## Rejected by Quality Gate/);
    assert.match(digest, /Not due today/);
  });
});

test('curator marks weekly curation due from the --weekly flag', () => {
  withTempRoot((root) => {
    writeIndex(root, []);
    writeDailyNote(root, DAY, '- Rule: always keep weekly fixture minimal.\n');
    const stdout = runNode(CURATOR, [DAY, '--weekly'], root);
    assert.match(stdout, /Input status: ok/);
    const digest = fs.readFileSync(digestFile(root, DAY), 'utf8');
    assert.match(digest, /Weekly pass is due/);
  });
});

test('curator marks weekly curation due automatically on Mondays', () => {
  withTempRoot((root) => {
    writeIndex(root, []);
    writeDailyNote(root, MONDAY, '- Rule: always keep monday fixture minimal.\n');
    runNode(CURATOR, [MONDAY], root);
    const digest = fs.readFileSync(digestFile(root, MONDAY), 'utf8');
    assert.match(digest, /Weekly pass is due/);
  });
});
