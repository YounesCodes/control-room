import assert from "node:assert/strict";

export function releaseAsset(release, platform, architecture = process.arch) {
  assert.equal(architecture, "x64", "Native lifecycle lab currently covers x86_64 only");
  const pattern = {
    win32: /(?:x64|x86_64).*setup\.exe$/i,
    linux: /(?:amd64|x86_64).*\.deb$/i,
    darwin: /(?:x64|x86_64).*\.dmg$/i,
  }[platform];
  assert.ok(pattern, `Unsupported lifecycle platform ${platform}`);
  const assets = release.assets.filter((asset) => pattern.test(asset.name));
  assert.equal(
    assets.length,
    1,
    `${release.tag_name} must publish exactly one ${platform} x86_64 installer; found ${assets.length}`,
  );
  return assets[0];
}

export function previousRelease(releases, candidateVersion) {
  const parse = (version) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  const candidate = parse(candidateVersion);
  assert.ok(candidate, "Candidate must have a stable semantic version");
  const eligible = releases.filter((release) => {
    const version = parse(release.tag_name);
    if (release.draft || release.prerelease || !version) return false;
    for (let index = 0; index < 3; index++) {
      if (version[index] !== candidate[index]) return version[index] < candidate[index];
    }
    return false;
  });
  eligible.sort((left, right) => {
    const a = parse(left.tag_name),
      b = parse(right.tag_name);
    for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return b[index] - a[index];
    return 0;
  });
  assert.ok(eligible.length, `No previous published release exists before ${candidateVersion}`);
  return eligible[0];
}
