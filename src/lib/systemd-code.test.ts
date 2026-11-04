import { describe, expect, it } from "vitest";
import { systemdCodeTokens } from "./systemd-code";

describe("systemd code display", () => {
  it("bounds highlighting work for large property dumps without dropping text", () => {
    const source = "Key=value\n".repeat(12000);
    const tokens = systemdCodeTokens(source);
    expect(tokens.length).toBeLessThan(10000);
    expect(tokens.map((token) => token.text).join("")).toBe(source);
  });
  it.each([
    "",
    '# /etc/systemd/system/app.service\r\n[Unit]\r\nDescription=Web worker\r\n\r\n[Service]\r\nExecStart=/usr/bin/worker --name "two words"\r\n',
    "Environment=\"KEY=value#literal\"\nExecStart=/bin/sh -c 'echo a=b; echo $HOME'\\\n --option=value\n",
    'ExecStart={ path=/usr/bin/app ; argv[]=/usr/bin/app --name "a;b" ; ignore_errors=no ; }\n',
    'Environment="unfinished\n<svg onload=alert(1)>\n日本語\t%incomplete ${VARIABLE\n',
  ])("preserves every source character: %s", (source) => {
    expect(
      systemdCodeTokens(source)
        .map((token) => token.text)
        .join(""),
    ).toBe(source);
  });

  it("distinguishes sections, directives, comments, strings, paths, and variables", () => {
    const tokens = systemdCodeTokens(
      '# note\n[Service]\nEnvironment="KEY=a=b#literal"\nExecStart=/usr/bin/app ${CONFIG} %i\n',
    );
    expect(tokens.filter((token) => token.kind !== "plain")).toEqual([
      { kind: "comment", text: "# note" },
      { kind: "section", text: "[Service]" },
      { kind: "key", text: "Environment" },
      { kind: "operator", text: "=" },
      { kind: "string", text: '"KEY=a=b#literal"' },
      { kind: "key", text: "ExecStart" },
      { kind: "operator", text: "=" },
      { kind: "path", text: "/usr/bin/app" },
      { kind: "variable", text: "${CONFIG}" },
      { kind: "variable", text: "%i" },
    ]);
  });

  it("does not split semicolons inside quoted command arguments", () => {
    const tokens = systemdCodeTokens('{ argv[]=/bin/sh -c "echo a;b" ; ignore_errors=no ; }');
    expect(tokens.filter((token) => token.kind === "operator" && token.text === ";")).toHaveLength(
      2,
    );
    expect(tokens).toContainEqual({ kind: "string", text: '"echo a;b"' });
  });
});
