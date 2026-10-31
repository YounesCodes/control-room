import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function readReleaseNotes(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) {
    throw new Error("GITHUB_REF_NAME must be a release tag such as v1.2.3");
  }
  let release;
  try {
    release = JSON.parse(
      execFileSync("gh", ["release", "view", tag, "--json", "databaseId,tagName,isDraft,body"], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    );
  } catch (error) {
    throw new Error(
      `Could not read ${tag}. Create a GitHub draft release with user-facing notes before pushing the tag.`,
      { cause: error },
    );
  }
  if (
    release.tagName !== tag ||
    !Number.isSafeInteger(release.databaseId) ||
    release.databaseId <= 0
  ) {
    throw new Error(`GitHub returned an invalid release for ${tag}`);
  }
  if (typeof release.body !== "string" || !release.body.trim()) {
    throw new Error(`The GitHub release for ${tag} has no notes. Edit its body before releasing.`);
  }
  return release;
}

export function main(args = process.argv.slice(2)) {
  const [mode, path] = args;
  if (mode && mode !== "--sync-feed" && mode !== "--validate-feed") {
    throw new Error(`Unknown argument: ${mode}`);
  }
  if (mode && !path) throw new Error(`Pass the latest.json path to ${mode}`);
  const release = readReleaseNotes(process.env.GITHUB_REF_NAME);
  if (mode) {
    const feed = JSON.parse(readFileSync(path, "utf8"));
    if (mode === "--sync-feed") {
      feed.notes = release.body;
      writeFileSync(path, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
    } else if (feed.notes !== release.body) {
      throw new Error("latest.json notes do not match the GitHub release body");
    }
    return;
  }

  if (!release.isDraft) throw new Error("The release must be a draft before building");
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is not set");
  appendFileSync(output, `id=${release.databaseId}\n`, "utf8");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
