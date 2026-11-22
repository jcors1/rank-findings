# rank-findings

A public copy of four small Node scripts, with no dependencies, used by a set of
scheduled monitoring agents. They are public so that a run that does not have
the private repository on disk can download them.

## The files

- `rank-findings.mjs`: ranks an agent's findings by a written rule (order, cap,
  overflow, alerts and repeats), so the order is computed in code and the model
  only explains it. Makes no network calls.
- `rank-findings-cli.mjs`: runs the ranker on one run's facts, read as JSON from
  a file or stdin, and prints the result as JSON.
- `cve-watch.mjs`: filters the CVE list's change log for new CVE records that
  name a vendor or product in a terms file, and prints the result as JSON.
- `scorecard-rollup.mjs`: reads the scorecard blocks that the runs post to their
  run log, and computes the week's figures and a dashboard page from them.

## How to check them

The files are copied unchanged from a private repository, which holds their
tests and their SHA-256 fingerprints. A run checks a downloaded copy against
those fingerprints before running it. To see the fingerprints of the files
here:

```bash
shasum -a 256 *.mjs
```

## Changes

This repository accepts no changes. Changes are made in the private repository
and the files are copied here.
