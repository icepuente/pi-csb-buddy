/** CHANGELOG.md helpers shared by the release script and the release workflow. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HEADING = /^## (.+)$/gm;

/** The body of one `## <title>` section, without its heading, trimmed. */
export function section(changelog, title) {
  const headings = [...changelog.matchAll(HEADING)];
  const index = headings.findIndex((match) => match[1].split(" — ")[0].trim() === title);
  if (index < 0) return undefined;
  const start = headings[index].index + headings[index][0].length;
  const end = headings[index + 1]?.index ?? changelog.length;
  return changelog.slice(start, end).trim();
}

/** Turn `## Unreleased` into `## <version> — <date>`; refuses when there is nothing to release. */
export function promoteUnreleased(changelog, version, date) {
  if (!section(changelog, "Unreleased")) throw new Error("CHANGELOG.md has no entries under ## Unreleased");
  if (section(changelog, version) !== undefined) throw new Error(`CHANGELOG.md already has a ${version} section`);
  return changelog.replace(/^## Unreleased$/m, `## ${version} — ${date}`);
}

// `node scripts/changelog.mjs <version>` prints that version's notes (used by the release workflow).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const notes = section(readFileSync("CHANGELOG.md", "utf8"), process.argv[2]);
  if (!notes) {
    console.error(`No CHANGELOG.md section for ${process.argv[2]}`);
    process.exit(1);
  }
  console.log(notes);
}
