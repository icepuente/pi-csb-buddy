# Changelog

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
