import { describe, expect, it } from "vitest";
import {
  feedSignatures,
  formatChecksums,
  releasePackages,
  requiredFeedPlatforms,
  verifyChecksums,
} from "./verify-release-assets.mjs";

const base = [
  "Control.Room_1.0.0_x64-setup.exe",
  "Control.Room_1.0.0_amd64.AppImage",
  "Control.Room_1.0.0_amd64.deb",
  "latest.json",
];
const macos = [
  "Control.Room_1.0.0_aarch64.dmg",
  "Control.Room_1.0.0_x64.dmg",
  "Control.Room_aarch64.app.tar.gz",
  "Control.Room_x64.app.tar.gz",
];

describe("release asset list", () => {
  it("returns the packages for Windows and Linux", () => {
    expect(releasePackages([...base, "SHA256SUMS.txt"], { includeMacos: false })).toEqual([
      "Control.Room_1.0.0_amd64.AppImage",
      "Control.Room_1.0.0_amd64.deb",
      "Control.Room_1.0.0_x64-setup.exe",
    ]);
  });

  it("includes the DMGs and updater archives when macOS is enabled", () => {
    expect(releasePackages([...base, ...macos], { includeMacos: true })).toHaveLength(7);
    expect(() => releasePackages(base, { includeMacos: true })).toThrow(/macOS disk image/);
    expect(() => releasePackages([...base, ...macos], { includeMacos: false })).toThrow(/macOS/);
  });

  it("rejects signature and per-package checksum assets", () => {
    for (const extra of [
      "Control.Room_1.0.0_x64-setup.exe.sig",
      "Control.Room_1.0.0_amd64.deb.sha256",
      "Control.Room_aarch64.app.tar.gz.sig",
    ]) {
      expect(() => releasePackages([...base, extra], { includeMacos: false })).toThrow(
        /Signature or per-package checksum/,
      );
    }
  });

  it("rejects a missing feed, a duplicate installer, and unknown assets", () => {
    expect(() => releasePackages(base.slice(0, 3), { includeMacos: false })).toThrow(/latest/);
    expect(() =>
      releasePackages([...base, "Control.Room_1.0.1_x64-setup.exe"], { includeMacos: false }),
    ).toThrow(/Windows installer/);
    expect(() => releasePackages([...base, "notes.txt"], { includeMacos: false })).toThrow(
      /Unexpected/,
    );
  });
});

describe("updater feed signatures", () => {
  const assets = base.map((name, index) => ({ name, apiUrl: "https://api/assets/" + index }));
  const entry = (index, signature = "sig" + index) => ({
    url: "https://api/assets/" + index,
    signature,
  });
  const feed = {
    platforms: {
      "windows-x86_64": entry(0),
      "windows-x86_64-nsis": entry(0),
      "linux-x86_64": entry(1),
      "linux-x86_64-appimage": entry(1),
      "linux-x86_64-deb": entry(2),
    },
  };
  const required = requiredFeedPlatforms({ includeMacos: false });

  it("pairs every feed entry with its published asset and inline signature", () => {
    expect(feedSignatures(feed, assets, required)).toContainEqual({
      platform: "linux-x86_64-deb",
      name: "Control.Room_1.0.0_amd64.deb",
      signature: "sig2",
    });
  });

  it("requires the macOS entries only when macOS is enabled", () => {
    expect(requiredFeedPlatforms({ includeMacos: true })).toEqual(
      expect.arrayContaining(["darwin-aarch64", "darwin-x86_64"]),
    );
    expect(() =>
      feedSignatures(feed, assets, requiredFeedPlatforms({ includeMacos: true })),
    ).toThrow(/darwin-aarch64/);
  });

  it("rejects a missing entry, an unknown URL, and an empty signature", () => {
    const withoutLinux = { ...feed.platforms };
    delete withoutLinux["linux-x86_64"];
    expect(() => feedSignatures({ platforms: withoutLinux }, assets, required)).toThrow(
      /linux-x86_64 entry/,
    );
    const wrongUrl = {
      platforms: { ...feed.platforms, "windows-x86_64": { url: "x", signature: "s" } },
    };
    expect(() => feedSignatures(wrongUrl, assets, required)).toThrow(/uploaded release asset/);
    const unsigned = { platforms: { ...feed.platforms, "linux-x86_64": entry(1, " ") } };
    expect(() => feedSignatures(unsigned, assets, required)).toThrow(/no signature/);
  });
});

describe("SHA256SUMS.txt", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const hashes = new Map([
    ["Control.Room_1.0.0_x64-setup.exe", b],
    ["Control.Room_1.0.0_amd64.deb", a],
  ]);

  it("writes sorted sha256sum lines", () => {
    expect(formatChecksums(hashes)).toBe(
      `${a}  Control.Room_1.0.0_amd64.deb\n${b}  Control.Room_1.0.0_x64-setup.exe\n`,
    );
  });

  it("accepts its own output, including CRLF and binary-mode markers", () => {
    expect(() => verifyChecksums(formatChecksums(hashes), hashes)).not.toThrow();
    const crlf = `${a} *Control.Room_1.0.0_amd64.deb\r\n${b}  Control.Room_1.0.0_x64-setup.exe\r\n`;
    expect(() => verifyChecksums(crlf, hashes)).not.toThrow();
  });

  it("rejects a missing entry, a wrong hash, an extra file, and malformed lines", () => {
    expect(() => verifyChecksums(`${a}  Control.Room_1.0.0_amd64.deb\n`, hashes)).toThrow(
      /no entry for Control.Room_1.0.0_x64-setup.exe/,
    );
    expect(() =>
      verifyChecksums(
        formatChecksums(new Map([...hashes, ["Control.Room_1.0.0_amd64.deb", b]])),
        hashes,
      ),
    ).toThrow(/wrong hash/);
    expect(() =>
      verifyChecksums(formatChecksums(new Map([...hashes, ["extra.bin", a]])), hashes),
    ).toThrow(/not release packages/);
    expect(() => verifyChecksums(`${a.toUpperCase()}  x\n`, hashes)).toThrow(/malformed/);
    expect(() =>
      verifyChecksums(formatChecksums(hashes) + `${a}  Control.Room_1.0.0_amd64.deb\n`, hashes),
    ).toThrow(/twice/);
  });
});
