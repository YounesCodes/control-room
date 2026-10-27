import { describe, expect, it } from "vitest";
import { verifyReleaseCI } from "./verify-release-ci.mjs";

const sha = "123";
const run = {
  databaseId: 42,
  headSha: sha,
  headBranch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
};
const jobs = ["frontend", "validate", "installer", "desktop / desktop", "hosted-ssh"].map(
  (name) => ({
    name,
    status: "completed",
    conclusion: "success",
  }),
);

describe("release CI verification", () => {
  it("accepts a successful main run with all required jobs", () => {
    expect(verifyReleaseCI(sha, [run], jobs)).toBe(42);
  });
  it("rejects another commit, a pull request, and incomplete or failed runs", () => {
    for (const candidate of [
      { ...run, headSha: "other" },
      { ...run, event: "pull_request" },
      { ...run, status: "in_progress" },
      { ...run, conclusion: "failure" },
    ]) {
      expect(() => verifyReleaseCI(sha, [candidate], jobs)).toThrow();
    }
  });
  it("rejects missing, skipped, or failed required jobs", () => {
    expect(() => verifyReleaseCI(sha, [run], jobs.slice(0, -1))).toThrow();
    expect(() =>
      verifyReleaseCI(
        sha,
        [run],
        jobs.map((job) =>
          job.name === "desktop / desktop" ? { ...job, conclusion: "skipped" } : job,
        ),
      ),
    ).toThrow();
    expect(() =>
      verifyReleaseCI(
        sha,
        [run],
        jobs.map((job) => (job.name === "validate" ? { ...job, conclusion: "failure" } : job)),
      ),
    ).toThrow();
  });
});
