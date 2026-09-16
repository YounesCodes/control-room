import { describe, expect, it } from "vitest";
import { hostOsKind, hostOsLabel } from "./HostOsIcon";

describe("hostOsKind", () => {
  it("recognizes supported distro IDs without case or whitespace sensitivity", () => {
    expect(hostOsKind("debian")).toBe("debian");
    expect(hostOsKind(" Ubuntu ")).toBe("ubuntu");
  });

  it("uses a neutral fallback when the distro is missing or unsupported", () => {
    expect(hostOsKind(null)).toBe("unknown");
    expect(hostOsKind("fedora")).toBe("unknown");
  });

  it("names a detected distro even when it uses the neutral mark", () => {
    expect(hostOsLabel("fedora")).toBe("fedora host");
    expect(hostOsLabel(null)).toBe("Host OS not detected");
  });
});
