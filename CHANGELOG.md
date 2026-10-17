# Changelog

## Unreleased

- With [`pi-job-listener`](https://github.com/xAndreiLi/pi-job-listener), a run that settles while
  a background job will still wake the agent shows `active` instead of `waiting`. A job that went
  quiet and was already reported (a dev server) no longer counts, until it prints again or exits.
  Only the job's structured bash details and pi-job-listener's event log are read, never output.
- A wake sent while a run settles counts as handled only once its turn starts, so the done animation
  does not flash before pi's deferred wake run.
- Add `npm test`: unit tests, tests against the real pi-job-listener, and end-to-end tests in real
  pi with a scripted `claude-bridge` model (no model calls). `prepublishOnly` runs them too.
- Automate releases: `npm run release -- <patch|minor|major|x.y.z>` bumps, tags and pushes, and a
  GitHub Actions workflow publishes to npm through trusted publishing and creates the GitHub
  release. CI runs the tests on Linux and Windows.

## 0.1.3 — 2026-10-17

- A run that ends on a reply asking you to decide (a "Decision(s)" heading or line, or a closing
  question mark) now shows `awaiting_approval` instead of `waiting`, until your next message.
  Assistant text is checked locally for this only; just a yes/no flag is kept.

## 0.1.2 — 2026-10-17

- Document that questions from `@juicesharp/rpiv-ask-user-question` show as `awaiting_approval`
  (tested with pi 1.3.0); no code change.
- Document installing from npm and the release process.
- Add a `prepublishOnly` typecheck.

## 0.1.1 — 2026-10-17

- Fix: a tool failure in a parallel batch is no longer hidden when a later tool in the same batch
  succeeds; the buddy now shows `error` once the batch ends.
- Document that backgrounded bash jobs show as `thinking`.
- Add `tsconfig.json`, a `typecheck` script, dev dependencies and an `engines` field.

## 0.1.0 — 2026-10-17

- Initial release, packaged from a standalone `csb-buddy.ts` extension.
