import { describe, expect, it } from "vitest";
import { hostOsKind, hostOsLabel, windowsVersion } from "./HostOsIcon";

describe("hostOsKind", () => {
  it("recognizes macOS and Darwin with the same accessible name", () => {
    expect(hostOsKind("macos")).toBe("macos");
    expect(hostOsKind(" Darwin ")).toBe("macos");
    expect(hostOsLabel("darwin")).toBe("macOS host");
  });
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

  it("maps the distro IDs /etc/os-release reports to their own marks", () => {
    expect(hostOsKind("fedora")).toBe("fedora");
    expect(hostOsKind("arch")).toBe("arch");
    expect(hostOsKind("archarm")).toBe("arch");
    expect(hostOsKind("opensuse-leap")).toBe("opensuse");
    expect(hostOsKind("opensuse-tumbleweed")).toBe("opensuse");
    expect(hostOsKind("sles")).toBe("suse");
    expect(hostOsKind("sled")).toBe("suse");
    expect(hostOsKind("suse")).toBe("suse");
    expect(hostOsKind("manjaro")).toBe("manjaro");
    expect(hostOsKind("ol")).toBe("oracle");
    expect(hostOsKind("amzn")).toBe("amazon");
    expect(hostOsKind("alpine")).toBe("alpine");
    expect(hostOsKind("linuxmint")).toBe("mint");
    expect(hostOsKind("kali")).toBe("kali");
    expect(hostOsKind("rhel")).toBe("rhel");
    expect(hostOsKind("centos")).toBe("centos");
    expect(hostOsKind("rocky")).toBe("rocky");
    expect(hostOsKind("almalinux")).toBe("alma");
    expect(hostOsKind("nixos")).toBe("nixos");
  });

  it("names each recognized distribution honestly in the accessible label", () => {
    expect(hostOsLabel("fedora")).toBe("Fedora host");
    expect(hostOsLabel("arch")).toBe("Arch Linux host");
    expect(hostOsLabel("opensuse-leap")).toBe("openSUSE host");
    expect(hostOsLabel("alpine")).toBe("Alpine Linux host");
    expect(hostOsLabel("linuxmint")).toBe("Linux Mint host");
    expect(hostOsLabel("kali")).toBe("Kali Linux host");
    expect(hostOsLabel("rhel")).toBe("Red Hat Enterprise Linux host");
    expect(hostOsLabel("centos")).toBe("CentOS host");
    expect(hostOsLabel("rocky")).toBe("Rocky Linux host");
    expect(hostOsLabel("almalinux")).toBe("AlmaLinux host");
    expect(hostOsLabel("nixos")).toBe("NixOS host");
    expect(hostOsLabel("sles")).toBe("SUSE Linux Enterprise host");
    expect(hostOsLabel("manjaro")).toBe("Manjaro host");
    expect(hostOsLabel("ol")).toBe("Oracle Linux host");
    expect(hostOsLabel("amzn")).toBe("Amazon Linux host");
  });

  it("uses a neutral fallback when the distro is missing or unrecognized", () => {
    expect(hostOsKind(null)).toBe("unknown");
    expect(hostOsKind("gentoo")).toBe("unknown");
  });

  it("names a detected distro even when it uses the neutral mark", () => {
    expect(hostOsLabel("gentoo")).toBe("gentoo host");
    expect(hostOsLabel(null)).toBe("Host OS not detected");
  });
});
