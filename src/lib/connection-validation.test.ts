import { describe, expect, it } from "vitest";
import { validateConnectionDraft } from "./connection-validation";
import type { SavedConnectionInput } from "../types";

function input(patch: Partial<SavedConnectionInput> = {}): SavedConnectionInput {
  return {
    displayName: "Laptop",
    destination: "192.0.2.10",
    username: "test-user",
    port: 22,
    identityFile: null,
    historyEnabled: false,
    sudoEnabled: false,
    groupId: null,
    tagNames: [],
    ...patch,
  };
}

describe("validateConnectionDraft", () => {
  it("accepts a normal host, alias, and IPv6 address", () => {
    expect(validateConnectionDraft(input())).toBeNull();
    expect(validateConnectionDraft(input({ destination: "debian-laptop", port: null }))).toBeNull();
    expect(validateConnectionDraft(input({ destination: "fe80::1" }))).toBeNull();
  });

  it("rejects option-shaped and whitespace-separated destinations", () => {
    expect(validateConnectionDraft(input({ destination: "-oProxyCommand=bad" }))).toContain(
      "SSH destination",
    );
    expect(validateConnectionDraft(input({ destination: "host another" }))).toContain(
      "SSH destination",
    );
  });

  it("rejects invalid usernames and ports", () => {
    expect(validateConnectionDraft(input({ username: "" }))).toBe("Username is required");
    expect(validateConnectionDraft(input({ username: "user name" }))).toContain("Username");
    expect(validateConnectionDraft(input({ port: 0 }))).toContain("Port");
  });
});
