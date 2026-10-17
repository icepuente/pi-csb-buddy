/** The CHANGELOG helpers behind `npm run release` and the release workflow. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { promoteUnreleased, section } from "../scripts/changelog.mjs";

const sample = `# Changelog

## Unreleased

- New thing.

## 0.1.3 — 2026-10-17

- Old thing.
`;

test("section returns one version's notes", () => {
  assert.equal(section(sample, "0.1.3"), "- Old thing.");
  assert.equal(section(sample, "Unreleased"), "- New thing.");
  assert.equal(section(sample, "9.9.9"), undefined);
});

test("promoteUnreleased dates the Unreleased entries under the new version", () => {
  const promoted = promoteUnreleased(sample, "0.1.4", "2026-10-18");
  assert.match(promoted, /^## 0\.1\.4 — 2026-10-18$/m);
  assert.doesNotMatch(promoted, /Unreleased/);
  assert.equal(section(promoted, "0.1.4"), "- New thing.");
});

test("promoteUnreleased refuses an empty Unreleased section or a repeated version", () => {
  assert.throws(() => promoteUnreleased("# Changelog\n\n## Unreleased\n\n## 0.1.3\n\n- x\n", "0.1.4", "d"), /no entries/);
  assert.throws(() => promoteUnreleased("# Changelog\n\n## 0.1.3\n\n- x\n", "0.1.4", "d"), /no entries/);
  assert.throws(() => promoteUnreleased(sample, "0.1.3", "d"), /already has/);
});

test("the real CHANGELOG parses: every released version has notes", () => {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  for (const version of ["0.1.1", "0.1.2", "0.1.3"]) assert.ok(section(changelog, version), version);
});
