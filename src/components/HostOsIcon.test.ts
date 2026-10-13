import { describe, expect, it } from "vitest";
import { hostOsKind, hostOsLabel, windowsVersion } from "./HostOsIcon";

describe("hostOsKind", () => {
  it("uses the detected product name for Windows versions without guessing from NT 10", () => {
    expect(windowsVersion("Microsoft Windows 10 Pro")).toBe("10");
    expect(windowsVersion("Microsoft Windows 11 Enterprise")).toBe("11");
    expect(windowsVersion("Microsoft Windows Server 2022")).toBeNull();
    expect(windowsVersion("10.0.26100")).toBeNull();
  });
  it("recognizes supported distro IDs without case or whitespace sensitivity", () => {
    expect(hostOsKind("debian")).toBe("debian");
    expect(hostOsKind(" Ubuntu ")).toBe("ubuntu");
    expect(hostOsKind(" WINDOWS ")).toBe("windows");
    expect(hostOsLabel("windows")).toBe("Windows host");
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
