# OpenClaw Dreaming Curator

[![CI](https://github.com/sebgru/openclaw-dreaming-curator/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sebgru/openclaw-dreaming-curator/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sebgru/openclaw-dreaming-curator/branch/main/graph/badge.svg)](https://codecov.io/gh/sebgru/openclaw-dreaming-curator)
[![License: MIT](https://img.shields.io/github/license/sebgru/openclaw-dreaming-curator.svg?branch=main)](LICENSE)

A dependency-free, report-only review aid for OpenClaw dreaming phase output. It
does not promote memories, edit startup files, contact a network service, or
configure a schedule. Every suggested change requires human review and a
separate manual edit.

## Scripts

| Script                                 | Role                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/dreaming-curator.mjs`         | Reads the day's dreaming phase files, ranks and quality-gates candidates, and writes a Markdown digest plus a canonical JSON review report. |
| `scripts/dreaming-review-delivery.mjs` | Reads the canonical JSON report and renders one proposed review message for a slot. Stateless: printing to stdout is not delivery.          |
| `scripts/dreaming-quality.mjs`         | Shared text-cleaning, quality-gate, and proposal helpers imported by the other two scripts.                                                 |

### Curator

```sh
node scripts/dreaming-curator.mjs [YYYY-MM-DD] [--weekly]
```

- The day defaults to today (UTC) and `--weekly` forces the weekly curation
  note; Mondays turn it on automatically.
- A candidate is only listed for review when it passes the quality gate, clears
  eligibility, and scores at or above the `0.72` threshold.
- Output is written under the workspace's `memory/` tree (see the contract
  below) and is **advisory only** — nothing is promoted automatically.

### Delivery renderer

```sh
node scripts/dreaming-review-delivery.mjs [YYYY-MM-DD] [SLOT]
```

- The slot defaults to `1`; the renderer prints at most the first two
  candidates.
- It prints `NO_REPLY` for a missing, malformed, unavailable, or empty report,
  and for any slot without a candidate.
- Rendering is repeatable: stdout is **not** a delivery confirmation, so a
  failed transport can retry. The caller owns scheduling and transport.

## Workspace contract

Run the scripts with the **OpenClaw workspace root as the current directory**,
not this repository root (unless this repository is itself the workspace). The
curator expects all three phase files for the requested UTC day:

```text
memory/dreaming/light/YYYY-MM-DD.md
memory/dreaming/rem/YYYY-MM-DD.md
memory/dreaming/deep/YYYY-MM-DD.md
```

For example, with this repository cloned beside the workspace's `memory/`
directory:

```sh
cd /path/to/workspace
node /path/to/openclaw-dreaming-curator/scripts/dreaming-curator.mjs 2026-01-02
node /path/to/openclaw-dreaming-curator/scripts/dreaming-review-delivery.mjs 2026-01-02 1
```

The curator writes only a Markdown digest under `memory/dreaming/digests/` and
a canonical, schema-versioned JSON review report under
`memory/review-candidates/`. These are generated workspace data, not repository
source. The JSON report is the delivery renderer's sole input; the digest is
never used as a fallback.

If any phase file is missing, the report has `status: "unavailable"`, names the
missing input, and has no review candidates. A missing, malformed, or
unavailable report makes the renderer print `NO_REPLY`; it must not be
interpreted as a healthy empty review. With a valid report, the renderer prints
one proposed review message for the requested slot. No scheduler or transport is
included here.

## Development

Requires Node.js 22 or newer.

```sh
npm install
npm run format        # Prettier (write)
npm run format:check  # Prettier (CI check)
npm run lint          # ESLint
npm run check         # node --check syntax pass
npm test              # node --test
npm run test:coverage # c8 with a >= 90% gate
```

Tests live in `test/` and cover all three scripts: the shared quality helpers,
the curator's extraction/ranking/digest output, and the renderer's fail-closed
and stateless-rendering guarantees. Coverage is enforced at ≥ 90% for
statements, branches, functions, and lines.

## CI

- **CI** (`.github/workflows/ci.yml`): two jobs. **Format & lint** runs
  `format:check`, `lint`, and the syntax check together; **Tests & coverage**
  runs the test suite with the coverage gate and uploads `coverage/lcov.info` to
  Codecov.
- **Release** (`.github/workflows/release.yml`): triggered only on version tags
  (`v*.*.*`). It repeats the checks, verifies the tag matches `package.json`,
  and attaches a release tarball to a GitHub Release.

## Releases

Publishing is tag-driven only. Pushing a `v*.*.*` tag builds

```text
openclaw-dreaming-curator-<version>.tar.gz
```

containing exactly `scripts/`, `README.md`, `LICENSE`, and `package.json`, and
attaches it to the GitHub Release for that tag. Nothing is published on ordinary
branch pushes. To cut a release:

```sh
npm version patch          # or minor / major — bumps package.json
git push origin main --follow-tags
```

## Dev container

A ready-to-use dev container lives in `.devcontainer/`. Open the repository in
VS Code and choose **Reopen in Container**, or use the Dev Containers CLI. It is
based on the Node.js 22 image, adds the GitHub CLI and Docker-in-Docker
features, and installs the same tooling used elsewhere (`eslint`, `prettier`,
`vim`, `jq`) plus the Claude Code extension.

Host credentials are reused rather than re-authenticated: the `postCreate`
setup copies your host `.gitconfig`, SSH keys, and `~/.config/gh` into the
container, so `gh` and `git` work with your existing login. Nothing needs to be
installed on the host.

Run the checks inside the container:

```sh
npm test
npm run test:coverage
```
