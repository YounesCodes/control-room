import { expect, it } from "vitest";
import { previousRelease, releaseAsset } from "./lifecycle-releases.mjs";

it("upgrades from the newest stable release users can have, regardless of API ordering", () => {
  const releases = ["v0.9.4", "v0.10.0", "v0.9.5", "v0.9.3"].map((tag_name) => ({ tag_name }));
  releases.push({ tag_name: "v0.9.99", draft: true }, { tag_name: "v0.9.98", prerelease: true });
  // A branch that still carries the published version upgrades from that release.
  expect(previousRelease(releases, "0.9.5").tag_name).toBe("v0.9.5");
  expect(previousRelease(releases, "0.9.6").tag_name).toBe("v0.9.5");
  expect(previousRelease(releases, "0.9.5", "v0.9.4").tag_name).toBe("v0.9.4");
  expect(previousRelease(releases, "0.9.5", "0.9.3").tag_name).toBe("v0.9.3");
  expect(() => previousRelease(releases, "0.9.5", "v0.10.0")).toThrow("at or before 0.9.5");
  expect(() => previousRelease(releases, "0.9.5", "v0.9.99")).toThrow("at or before 0.9.5");
  expect(() => previousRelease(releases, "0.9.2")).toThrow("No published release");
});
it("fails when a previous native package is missing instead of passing a same-build restart", () => {
  const release = { tag_name: "v0.9.4", assets: [{ name: "Control.Room_0.9.4_x64-setup.exe" }] };
  expect(releaseAsset(release, "win32", "x64").name).toContain("setup.exe");
  expect(() => releaseAsset(release, "linux", "x64")).toThrow("found 0");
  expect(() => releaseAsset(release, "darwin", "x64")).toThrow("found 0");
});
it("rejects ambiguous packages and ARM rather than selecting a different architecture", () => {
  const asset = { name: "Control.Room_0.9.4_amd64.deb" };
  expect(() =>
    releaseAsset({ tag_name: "v0.9.4", assets: [asset, asset] }, "linux", "x64"),
  ).toThrow("found 2");
  expect(() => releaseAsset({ assets: [asset] }, "darwin", "arm64")).toThrow("x86_64");
});
