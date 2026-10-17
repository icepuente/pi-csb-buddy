/**
 * Cut a release: `npm run release -- <patch|minor|major|x.y.z> [--dry-run]`.
 *
 * Checks the tree, runs typecheck and tests, moves the CHANGELOG's Unreleased entries under the new
 * version, bumps package.json, commits, tags and pushes. The tag starts .github/workflows/release.yml,
 * which publishes to npm through trusted publishing and creates the GitHub release; this script then
 * watches that run and confirms the version on npm. --dry-run stops before anything is written.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promoteUnreleased, section } from "./changelog.mjs";

const PACKAGE = "pi-csb-buddy";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const bump = args.find((arg) => !arg.startsWith("--"));

const step = (message) => console.log(`\n▶ ${message}`);
const fail = (message) => { console.error(`\n✖ ${message}`); process.exit(1); };
/**
 * On Windows npm is a .cmd shim, which only runs through a shell; it gets one command string. Every
 * argument here is fixed or a validated x.y.z version, so nothing needs quoting. git and gh are
 * executables and never go through a shell.
 */
function exec(command, commandArgs, options) {
  return command === "npm" && process.platform === "win32"
    ? spawnSync([command, ...commandArgs].join(" "), { ...options, shell: true })
    : spawnSync(command, commandArgs, options);
}
function read(command, commandArgs) {
  const result = exec(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) fail(`${command} ${commandArgs[0]} failed: ${(result.stderr || result.error?.message || "").trim()}`);
  return result.stdout.trim();
}
function parse(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`could not parse ${what}`);
  }
}
/** Run with output streaming straight through, so a long step is visible as it goes. */
function run(command, commandArgs) {
  console.log(`$ ${command} ${commandArgs.join(" ")}`);
  const result = exec(command, commandArgs, { stdio: "inherit" });
  if (result.status !== 0) fail(`${command} ${commandArgs[0]} failed`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nextVersion(current, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [major, minor, patch] = current.split(".").map(Number);
  if (how === "patch") return `${major}.${minor}.${patch + 1}`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  if (how === "major") return `${major + 1}.0.0`;
  fail("usage: npm run release -- <patch|minor|major|x.y.z> [--dry-run]");
}

if (!bump) fail("usage: npm run release -- <patch|minor|major|x.y.z> [--dry-run]");
const current = parse(readFileSync("package.json", "utf8"), "package.json").version;
const version = nextVersion(current, bump);
const tag = `v${version}`;
const date = new Date().toISOString().slice(0, 10);
console.log(`${PACKAGE} ${current} → ${version}${dryRun ? " (dry run)" : ""}`);

step("Checking the working tree");
if (read("git", ["branch", "--show-current"]) !== "main") fail("releases are cut from main");
if (read("git", ["status", "--porcelain"])) fail("the working tree has uncommitted changes");
run("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
if (read("git", ["rev-parse", "HEAD"]) !== read("git", ["rev-parse", "origin/main"])) fail("main is not in sync with origin/main");
if (read("git", ["tag", "--list", tag])) fail(`tag ${tag} already exists`);
let changelog;
try {
  changelog = promoteUnreleased(readFileSync("CHANGELOG.md", "utf8"), version, date);
} catch (error) {
  fail(error.message);
}
console.log(`Release notes:\n${section(changelog, version)}`);

step("Typecheck and tests");
run("npm", ["run", "typecheck"]);
run("npm", ["test"]);

if (dryRun) {
  console.log(`\n✔ Dry run passed. Without --dry-run this commits ${version}, pushes ${tag}, and the workflow publishes it.`);
  process.exit(0);
}

step(`Committing ${version} and tagging ${tag}`);
writeFileSync("CHANGELOG.md", changelog);
run("npm", ["version", version, "--no-git-tag-version"]);
run("git", ["commit", "--quiet", "-am", version]);
run("git", ["tag", "-a", tag, "-m", tag]);
run("git", ["push", "--atomic", "origin", "main", tag]);

step("Waiting for the release workflow");
let runId;
for (let attempt = 0; attempt < 30 && !runId; attempt++) {
  await sleep(2_000);
  const runs = parse(read("gh", ["run", "list", "--workflow", "release.yml", "--branch", tag, "--json", "databaseId", "--limit", "1"]), "gh run list");
  runId = runs[0]?.databaseId;
}
if (!runId) fail(`no release workflow run appeared for ${tag}; check the Actions tab`);
run("gh", ["run", "watch", String(runId), "--exit-status", "--interval", "5"]);

// npm takes a while to process a new version (0.1.4 took about 90 seconds to show).
step("Confirming on npm (can take a few minutes)");
const started = Date.now();
while (Date.now() - started < 5 * 60_000) {
  const published = exec("npm", ["view", `${PACKAGE}@${version}`, "version"], { encoding: "utf8" });
  if ((published.stdout ?? "").trim() === version) {
    console.log(`\n✔ ${PACKAGE}@${version} is live: https://www.npmjs.com/package/${PACKAGE}/v/${version}`);
    process.exit(0);
  }
  console.log(`not on npm yet after ${Math.round((Date.now() - started) / 1000)}s`);
  await sleep(15_000);
}
fail(`npm still does not show ${version} after 5 minutes. If the workflow's publish step says "+ ${PACKAGE}@${version}", ` +
  "it is still processing; if it was staged, approve it in npmjs.com → Staged Packages");
