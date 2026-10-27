import { execFileSync } from "node:child_process";
import { join } from "node:path";
import * as prettier from "prettier";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
git(["diff", "--cached", "--check"]);
const files = git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"])
  .split("\0")
  .filter(Boolean);
let failed = false;
for (const file of files) {
  // Check the index, including partially staged files, without rewriting it.
  if (git(["ls-files", "--stage", "--", file]).startsWith("120000")) continue;
  const filepath = join(root, file);
  const info = await prettier.getFileInfo(filepath, { ignorePath: join(root, ".prettierignore") });
  if (info.ignored || !info.inferredParser) continue;
  const options = { ...(await prettier.resolveConfig(filepath)), filepath };
  if (!(await prettier.check(git(["show", `:${file}`]), options))) {
    console.error(`${file}: staged content needs formatting. Run Prettier and stage the result.`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log(`Checked ${files.length} staged files. Full validation runs in PR CI.`);
