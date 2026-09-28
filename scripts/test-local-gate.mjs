import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

if (process.platform !== "win32") {
  console.error("The local gate runs on the Windows development checkout.");
  process.exit(1);
}

for (const script of ["check", "test:browser", "test:local-lab"]) {
  console.log(`Running npm run ${script}`);
  const npmCli =
    process.env.npm_execpath ||
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const result = spawnSync(process.execPath, [npmCli, "run", script], { stdio: "inherit" });
  if (result.error || result.status !== 0) process.exit(1);
}
