import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function readReleaseNotes(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) {
    throw new Error("GITHUB_REF_NAME must be a release tag such as v1.2.3");
  }
  const path = `release-notes/${tag}.txt`;
  let notes;
  try {
    notes = readFileSync(path, "utf8").replace(/\r\n/g, "\n").trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Missing ${path}. Write user-facing release notes before tagging.`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!notes) throw new Error(`${path} is empty. Write user-facing release notes before tagging.`);
  return notes;
}

function main() {
  const notes = readReleaseNotes(process.env.GITHUB_REF_NAME);
  if (process.argv[2] === "--validate-feed") {
    const path = process.argv[3];
    if (!path) throw new Error("Pass the latest.json path to --validate-feed");
    const feed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof feed.notes !== "string" || feed.notes.replace(/\r\n/g, "\n").trim() !== notes) {
      throw new Error("latest.json notes do not match the release notes file");
    }
    return;
  }

  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is not set");
  const delimiter = `release-notes-${randomUUID()}`;
  appendFileSync(output, `body<<${delimiter}\n${notes}\n${delimiter}\n`, "utf8");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
