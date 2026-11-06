import { readFileSync } from "node:fs";

export const registry = JSON.parse(
  readFileSync(new URL("../src/test/ui-review/scenarios.json", import.meta.url), "utf8"),
);

export function parseOptions(args) {
  const options = { type: args[0], scenario: null, state: "populated", viewport: "all" };
  if (!new Set(["capture", "motion"]).has(options.type))
    throw new Error("Expected capture or motion");
  for (let index = 1; index < args.length; index++) {
    const key = args[index];
    if (key === "--help" || key === "--list") return { ...options, help: true };
    if (!["--scenario", "--state", "--viewport"].includes(key) || !args[index + 1])
      throw new Error(`Unknown or missing option: ${key}. Use --help.`);
    options[key.slice(2)] = args[++index];
  }
  const scenario = Object.hasOwn(registry.scenarios, options.scenario)
    ? registry.scenarios[options.scenario]
    : null;
  if (!scenario) throw new Error("Choose a known --scenario. Use --list.");
  if (!scenario.states.includes(options.state))
    throw new Error(`Unknown state for ${options.scenario}`);
  if (options.viewport !== "all" && !Object.hasOwn(registry.viewports, options.viewport))
    throw new Error("Choose --viewport all, normal, or narrow");
  if (options.type === "motion" && !scenario.motion)
    throw new Error(`No motion transition registered for ${options.scenario}`);
  return options;
}
