import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  DELIVERY,
  candidate,
  candidatesFile,
  envelope,
  runNode,
  withTempRoot,
  writeCanonical,
} from './helpers.mjs';

test('renderer prints NO_REPLY when the canonical report is absent', () => {
  withTempRoot((root) => {
    assert.equal(runNode(DELIVERY, ['2026-01-01', '1'], root).trim(), 'NO_REPLY');
  });
});

test('renderer prints NO_REPLY for malformed JSON', () => {
  withTempRoot((root) => {
    const file = candidatesFile(root, '2026-01-02');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not valid json');
    assert.equal(runNode(DELIVERY, ['2026-01-02', '1'], root).trim(), 'NO_REPLY');
  });
});

test('renderer fails closed on malformed or unknown canonical envelopes', () => {
  withTempRoot((root) => {
    const day = '2026-01-03';
    const malformed = [
      [],
      'string',
      null,
      {},
      envelope({ schemaVersion: 2 }),
      envelope({ mode: 'auto' }),
      envelope({ generatedAt: 'not-a-date' }),
      envelope({ generatedAt: undefined }),
      envelope({ candidates: 'nope' }),
      envelope({ status: 'ok', missingInput: 'missing producer input' }),
      envelope({ status: 'unavailable', missingInput: null }),
      envelope({ status: 'error' }),
    ];
    for (const [index, report] of malformed.entries()) {
      writeCanonical(root, day, report);
      assert.equal(
        runNode(DELIVERY, [day, '1'], root).trim(),
        'NO_REPLY',
        `malformed canonical envelope ${index + 1} must not render`,
      );
    }
  });
});

test('renderer refuses an unavailable report even when candidates are present', () => {
  withTempRoot((root) => {
    const day = '2026-01-04';
    writeCanonical(
      root,
      day,
      envelope({
        status: 'unavailable',
        missingInput: 'synthetic unavailable fixture',
        candidates: [candidate()],
      }),
    );
    assert.equal(runNode(DELIVERY, [day, '1'], root).trim(), 'NO_REPLY');
  });
});

test('renderer prints NO_REPLY when no candidate matches the requested slot', () => {
  withTempRoot((root) => {
    const day = '2026-01-05';
    writeCanonical(root, day, envelope({ candidates: [candidate()] }));
    assert.equal(runNode(DELIVERY, [day, '2'], root).trim(), 'NO_REPLY');
    assert.equal(runNode(DELIVERY, [day, '0'], root).trim(), 'NO_REPLY');
  });
});

test('renderer prints NO_REPLY when the canonical path is unreadable', () => {
  withTempRoot((root) => {
    const day = '2026-01-11';
    fs.mkdirSync(candidatesFile(root, day), { recursive: true });
    assert.equal(runNode(DELIVERY, [day, '1'], root).trim(), 'NO_REPLY');
  });
});

test('renderer emits one review proposal and stays stateless', () => {
  withTempRoot((root) => {
    const day = '2026-01-06';
    writeCanonical(root, day, envelope({ candidates: [candidate()] }));

    const stdout = runNode(DELIVERY, [day, '1'], root);
    assert.match(stdout, /Dreaming review proposal 1\/1/);
    assert.match(stdout, /Topic: Evening beverage preference/);
    assert.match(stdout, /Suggested destination: USER\.md/);
    assert.match(stdout, /Evidence: memory\/2026-01-01\.md:1-1/);
    assert.match(stdout, /No automatic change will be made\./);

    assert.equal(runNode(DELIVERY, [day, '1'], root), stdout, 'rendering must be repeatable');
    assert.equal(
      fs.existsSync(path.join(root, 'memory', 'dreaming', 'review-state.json')),
      false,
      'stdout rendering must not record confirmed delivery',
    );
  });
});

test('renderer keeps only canonical, durable, evidence-backed candidates', () => {
  withTempRoot((root) => {
    const day = '2026-01-07';
    writeCanonical(
      root,
      day,
      envelope({
        candidates: [
          null,
          42,
          'x',
          {},
          candidate({ text: 'The user prefers tea over coffee in the evening.' }),
          candidate({ text: 'x'.repeat(601) }),
          candidate({ text: 'and then it happened' }),
          candidate({ text: 'System report: all good.' }),
          candidate({ text: 'Random weather observation.' }),
          candidate({
            text: 'The user prefers tea.',
            evidence: '',
            sourceFile: '',
            path: undefined,
          }),
          candidate({ text: 'Preference: keep NO_REPLY internal.' }),
        ],
      }),
    );
    const stdout = runNode(DELIVERY, [day, '1'], root);
    assert.match(stdout, /Evening beverage preference/);
    assert.doesNotMatch(stdout, /System report/);
    assert.doesNotMatch(stdout, /Random weather/);
  });
});

test('renderer prints NO_REPLY when every candidate is filtered out', () => {
  withTempRoot((root) => {
    const day = '2026-01-08';
    writeCanonical(
      root,
      day,
      envelope({ candidates: [candidate({ text: 'System report: all good.' })] }),
    );
    assert.equal(runNode(DELIVERY, [day, '1'], root).trim(), 'NO_REPLY');
  });
});

test('renderer suppresses an internal control marker that leaked into metadata', () => {
  withTempRoot((root) => {
    const day = '2026-01-09';
    writeCanonical(root, day, envelope({ candidates: [candidate({ title: 'ANNOUNCE_SKIP' })] }));
    assert.equal(runNode(DELIVERY, [day, '1'], root).trim(), 'NO_REPLY');
  });
});

test('renderer resolves field fallbacks and default destination/why', () => {
  withTempRoot((root) => {
    const day = '2026-01-10';
    writeCanonical(
      root,
      day,
      envelope({
        candidates: [
          {
            snippet: 'The user prefers tea over coffee in the evening.',
            path: 'memory/2026-01-10.md',
            key: 'Evening beverage preference',
          },
        ],
      }),
    );
    const stdout = runNode(DELIVERY, [day, '1'], root);
    assert.match(stdout, /Topic: Evening beverage preference/);
    assert.match(stdout, /Suggested destination: MEMORY\.md if still relevant/);
    assert.match(stdout, /This may be a durable fact worth preserving\./);
    assert.match(stdout, /Evidence: memory\/2026-01-10\.md/);
  });
});
