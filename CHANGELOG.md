# Changelog

## 0.1.1 — 2026-10-17

- Fix: a tool failure in a parallel batch is no longer hidden when a later tool in the same batch
  succeeds; the buddy now shows `error` once the batch ends.
- Document that backgrounded bash jobs show as `thinking`.
- Add `tsconfig.json`, a `typecheck` script, dev dependencies and an `engines` field.

## 0.1.0 — 2026-10-17

- Initial release, packaged from a standalone `csb-buddy.ts` extension.
