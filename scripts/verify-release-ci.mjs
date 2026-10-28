import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function verifyReleaseCI(sha, runs, jobs) {
  const run = runs.find(
    (item) => item.headSha === sha && item.headBranch === "main" && item.event === "push",
  );
  if (!run || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("The tagged commit has no successful main-branch CI run.");
  }
  for (const name of ["frontend", "validate", "installer", "desktop / desktop", "hosted-ssh"]) {
    const job = jobs.find((item) => item.name === name);
    if (!job || job.status !== "completed" || job.conclusion !== "success") {
      throw new Error(`The tagged commit has no successful ${name} job.`);
    }
  }
  return run.databaseId;
}

function main() {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  const runs = JSON.parse(
    execFileSync(
      "gh",
      [
        "run",
        "list",
        "--workflow",
        "ci.yml",
        "--branch",
        "main",
        "--commit",
        sha,
        "--event",
        "push",
        "--limit",
        "100",
        "--json",
        "databaseId,headSha,headBranch,event,status,conclusion",
      ],
      { encoding: "utf8" },
    ),
  );
  const run = runs.find(
    (item) => item.headSha === sha && item.headBranch === "main" && item.event === "push",
  );
  if (!run) throw new Error("The tagged commit has no main-branch CI run.");
  const result = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${run.databaseId}/jobs?per_page=100`,
      ],
      { encoding: "utf8" },
    ),
  );
  verifyReleaseCI(sha, runs, result.jobs);
  console.log(`Verified main CI run ${run.databaseId} for ${sha}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
