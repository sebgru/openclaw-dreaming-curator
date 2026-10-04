# OpenClaw Dreaming Curator

A dependency-free, report-only review aid for OpenClaw dreaming phase output. It
does not promote memories, edit startup files, contact a network service, or
configure a schedule. Every suggested change requires human review and a
separate manual edit.

## Workspace contract

Run the scripts with the **OpenClaw workspace root as the current directory**,
not this repository root (unless this repository is itself the workspace).
The curator expects all three phase files for the requested UTC day:

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
one proposed review message for the requested slot. Printing to stdout is **not
confirmed delivery**: rendering is stateless so a failed downstream transport
can retry. The caller is responsible for transport and for invoking each review
slot only once in normal operation. No scheduler or transport is included here.

## Development

Requires Node.js 22 or newer. Run `npm test` for the focused quality and
missing-input/delivery-guard checks. There are no external dependencies.
