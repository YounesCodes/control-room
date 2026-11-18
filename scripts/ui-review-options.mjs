import { readFileSync } from "node:fs";

const read = (name) =>
  JSON.parse(readFileSync(new URL(`../src/test/ui-review/${name}`, import.meta.url), "utf8"));
export const registry = read("scenarios.json");
export const featureMap = read("features.json");

export function formatFeatures({ features }) {
  const width = Math.max(...features.map(({ name }) => name.length)) + 2;
  const lines = features.map(
    ({ name, capture }) =>
      name.padEnd(width) +
      (capture
        ? capture.map(({ scenario, states }) => `${scenario}: ${states.join(", ")}`).join("; ")
        : "no scenario"),
  );
  const gaps = features.filter(({ capture }) => capture === null).map(({ name }) => name);
  return [
    "Feature map: src/test/ui-review/features.json",
    "Capture a state with npm run ui:capture -- --scenario SCENARIO --state STATE",
    ...lines,
    `No capture scenario (${gaps.length}): ${gaps.join(", ")}`,
  ].join("\n");
}

export function parseOptions(args) {
  const options = { type: args[0], scenario: null, state: "populated", viewport: "all" };
  if (!new Set(["capture", "motion"]).has(options.type))
    throw new Error("Expected capture or motion");
  for (let index = 1; index < args.length; index++) {
    const key = args[index];
    if (key === "--help" || key === "--list") return { ...options, help: true };
    if (key === "--features") return { ...options, features: true };
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
    throw new Error(`Choose --viewport all or ${Object.keys(registry.viewports).join(", ")}`);
  if (options.type === "motion" && !scenario.motion)
    throw new Error(`No motion transition registered for ${options.scenario}`);
  return options;
}
