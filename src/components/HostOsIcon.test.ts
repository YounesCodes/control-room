import { describe, expect, it } from "vitest";
import { hostOsKind } from "./HostOsIcon";

describe("hostOsKind", () => {
  it("recognizes supported distro IDs without case or whitespace sensitivity", () => {
    expect(hostOsKind("debian")).toBe("debian");
    expect(hostOsKind(" Ubuntu ")).toBe("ubuntu");
  });

  it("uses a neutral fallback when the distro is missing or unsupported", () => {
    expect(hostOsKind(null)).toBe("unknown");
    expect(hostOsKind("fedora")).toBe("unknown");
  });
});
