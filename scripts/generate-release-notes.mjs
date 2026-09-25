import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const RELEASE_COMMIT = /^chore(?:\(release\))?!?:\s*release\s+v?\d/i;
const CONVENTIONAL_PREFIX =
  /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]+\))?!?:\s*/i;
const BULLET = /^\s*[-*+•]\s+(.+)$/;
const HEADING = /^\s*#{1,6}\s+/;
const FULL_CHANGELOG = /^(?:\*\*|__)?full changelog(?:\*\*|__)?\s*:/i;
const MAINTENANCE = /^(?:chore\(deps(?:-dev)?\):|bump\s|dependabot\b)/i;
const MERGE_COMMIT = /^merge pull request #\d+/i;
const PR_CONTRIBUTION =
  /\s+by\s+@\S+\s+in\s+https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\s*$/i;
const IGNORED_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "the",
  "to",
  "with",
  "terminal",
  "terminals",
]);

function formatSubject(subject) {
  const text = subject.replace(CONVENTIONAL_PREFIX, "").trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}

export function buildDirectChangeNotes(commits) {
  const changes = commits
    .filter(
      (commit) =>
        commit.pullRequests.length === 0 &&
        !RELEASE_COMMIT.test(commit.subject) &&
        !MERGE_COMMIT.test(commit.subject) &&
        !MAINTENANCE.test(commit.subject),
    )
    .map((commit) => formatSubject(commit.subject))
    .filter(Boolean);
  return changes.map((change) => `* ${change}`).join("\n");
}

function changeWords(change) {
  return change
    .toLowerCase()
    .replace(/\(#\d+\)/g, "")
    .split(/[^a-z0-9]+/)
    .map((word) => word.replace(/(?:ed|s)$/, ""))
    .filter((word) => word && !IGNORED_WORDS.has(word));
}

function sameChange(left, right) {
  const a = changeWords(left);
  const b = changeWords(right);
  if (a.join(" ") === b.join(" ")) return true;
  // Only collapse near-identical actions. Sharing a noun (such as "terminal")
  // does not make a UI polish commit the same change as the feature PR.
  return a[0] === b[0] && a.filter((word) => b.includes(word)).length >= 2;
}

function generatedChanges(notes) {
  const changes = [];
  let contributors = false;
  let maintenance = false;
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (HEADING.test(line)) {
      contributors = /contributors?/i.test(line);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (!bullet || contributors) continue;
    const match = PR_CONTRIBUTION.exec(bullet[1]);
    const title = match ? bullet[1].slice(0, match.index) : bullet[1];
    if (MAINTENANCE.test(title)) {
      maintenance = true;
      continue;
    }
    const change = formatSubject(title);
    if (change && !changes.some((existing) => sameChange(existing, change))) {
      changes.push(match ? `${change} (#${match[1]})` : change);
    }
  }
  return { changes, maintenance };
}

export function hasDescribedChanges(notes) {
  let contributorSection = false;
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (HEADING.test(line)) {
      contributorSection = /contributors?/i.test(line);
      continue;
    }
    const bullet = BULLET.exec(line);
    const content = (bullet?.[1] ?? line).trim();
    if (!content || FULL_CHANGELOG.test(content) || contributorSection) continue;
    return true;
  }
  return false;
}

export function combineReleaseNotes(generatedNotes, commits) {
  const { changes: pullChanges, maintenance } = generatedChanges(generatedNotes);
  const changes = [...pullChanges];
  for (const direct of buildDirectChangeNotes(commits).split("\n").filter(Boolean)) {
    const change = direct.slice(2);
    if (!changes.some((existing) => sameChange(existing, change))) changes.push(change);
  }
  if (
    !changes.length &&
    (maintenance || commits.some((commit) => MAINTENANCE.test(commit.subject)))
  ) {
    changes.push("Dependency maintenance");
  }
  return changes.map((change) => `* ${change}`).join("\n");
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function commitsBetween(previousTag, currentTag, repository) {
  const fields = run("git", ["log", "--format=%H%x00%s%x00", `${previousTag}..${currentTag}`])
    .split("\0")
    .map((field) => field.trim())
    .filter(Boolean);
  const commits = [];
  for (let index = 0; index < fields.length; index += 2) {
    const sha = fields[index];
    const subject = fields[index + 1];
    const pulls = JSON.parse(
      run("gh", [
        "api",
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${repository}/commits/${sha}/pulls`,
      ]),
    );
    commits.push({ sha, subject, pullRequests: pulls.map((pull) => pull.number) });
  }
  return commits;
}

function generatedNotes(repository, previousTag, currentTag) {
  return JSON.parse(
    run("gh", [
      "api",
      "--method",
      "POST",
      `repos/${repository}/releases/generate-notes`,
      "-f",
      `tag_name=${currentTag}`,
      "-f",
      `previous_tag_name=${previousTag}`,
    ]),
  ).body;
}

function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is not set");
  const delimiter = `release-notes-${randomUUID()}`;
  appendFileSync(output, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

function validateFeed(path) {
  const feed = JSON.parse(readFileSync(path, "utf8"));
  if (!hasDescribedChanges(feed.notes ?? "")) {
    throw new Error("latest.json does not describe any changes");
  }
}

function main() {
  if (process.argv[2] === "--validate-feed") {
    const path = process.argv[3];
    if (!path) throw new Error("Pass the latest.json path to --validate-feed");
    validateFeed(path);
    return;
  }

  const repository = process.env.GITHUB_REPOSITORY;
  const currentTag = process.env.GITHUB_REF_NAME;
  if (!repository || !currentTag) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_REF_NAME must be set");
  }
  const previousTag = run("git", ["describe", "--tags", "--abbrev=0", `${currentTag}^`]);
  const body = combineReleaseNotes(
    generatedNotes(repository, previousTag, currentTag),
    commitsBetween(previousTag, currentTag, repository),
  );
  if (!hasDescribedChanges(body)) throw new Error("The release notes do not describe any changes");
  writeOutput("body", body);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
