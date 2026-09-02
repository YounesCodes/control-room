import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_WARNING,
  INSERTION_NOTICE,
  blankParameter,
  errorFor,
  generalErrors,
  initialValues,
  parameterHint,
  parseBound,
  parseChoices,
  scopeLabel,
  templatePlaceholders,
} from "./snippet-form";
import type { CommandSnippet, SnippetParameter, SnippetRender } from "../types";

function parameter(overrides: Partial<SnippetParameter> = {}): SnippetParameter {
  return { ...blankParameter(), name: "service", prompt: "Unit", ...overrides };
}

function snippet(
  parameters: SnippetParameter[],
  connectionId: string | null = null,
): CommandSnippet {
  return {
    id: "snippet-1",
    name: "Unit journal",
    template: "journalctl -u {{service}}",
    parameters,
    shell: "bash",
    connectionId,
    position: 0,
    createdAt: "",
    updatedAt: "",
  };
}

function render(overrides: Partial<SnippetRender> = {}): SnippetRender {
  return { command: "journalctl -u 'nginx.service'", errors: [], shell: "bash", ...overrides };
}

describe("form values", () => {
  it("starts each field from its author-set default", () => {
    expect(
      initialValues(
        snippet([
          parameter({ name: "service", defaultValue: "nginx.service" }),
          parameter({ name: "lines", defaultValue: null }),
        ]),
      ),
    ).toEqual({ service: "nginx.service", lines: "" });
  });

  it("hands back a blank parameter that is a string and required", () => {
    const blank = blankParameter();
    expect(blank.kind).toBe("string");
    expect(blank.required).toBe(true);
    expect(blank.choices).toEqual([]);
    expect(blank.defaultValue).toBeNull();
  });
});

describe("error placement", () => {
  const failed = render({
    command: null,
    errors: [
      { parameter: "lines", message: "Lines: enter 1 or more" },
      { parameter: null, message: "The result is longer than 4000 characters" },
    ],
  });

  it("finds the message for one field", () => {
    expect(errorFor(failed, "lines")).toBe("Lines: enter 1 or more");
    expect(errorFor(failed, "service")).toBeNull();
    expect(errorFor(null, "lines")).toBeNull();
  });

  it("keeps errors with no field of their own separate", () => {
    expect(generalErrors(failed)).toEqual(["The result is longer than 4000 characters"]);
    expect(generalErrors(render())).toEqual([]);
    expect(generalErrors(null)).toEqual([]);
  });
});

describe("labels", () => {
  it("says which connections a snippet belongs to", () => {
    expect(scopeLabel(snippet([]), "Web 01")).toBe("Every connection");
    expect(scopeLabel(snippet([], "connection-a"), "Web 01")).toBe("Web 01");
  });

  it("describes a parameter by type, requirement, and limits", () => {
    expect(parameterHint(parameter())).toBe("string");
    expect(parameterHint(parameter({ required: false }))).toBe("string · optional");
    expect(parameterHint(parameter({ kind: "integer", minimum: 1, maximum: 1000 }))).toBe(
      "integer · 1 to 1000",
    );
    expect(parameterHint(parameter({ kind: "integer", minimum: 1 }))).toBe("integer · 1 or more");
    expect(parameterHint(parameter({ kind: "integer", maximum: 10 }))).toBe("integer · 10 or less");
    expect(parameterHint(parameter({ kind: "choice", choices: ["--follow", "--no-pager"] }))).toBe(
      "choice · --follow / --no-pager",
    );
  });

  it("states the insertion and storage rules in plain words", () => {
    expect(INSERTION_NOTICE).toContain("without Enter");
    expect(CREDENTIAL_WARNING).toContain("Do not put passwords, keys, or tokens in one");
  });
});

describe("editor input parsing", () => {
  it("lists the placeholders a template uses, once each", () => {
    expect(templatePlaceholders("journalctl -u {{service}} -n {{lines}} {{service}}")).toEqual([
      "service",
      "lines",
    ]);
  });

  it("ignores anything that is not a placeholder", () => {
    expect(templatePlaceholders("awk '{print $1}' {{Service}} {{ bad }} {{}}")).toEqual([]);
  });

  it("reads choices as a trimmed, non-empty list", () => {
    expect(parseChoices(" --follow , --no-pager ,, ")).toEqual(["--follow", "--no-pager"]);
    expect(parseChoices("")).toEqual([]);
  });

  it("reads a bound only when it is a whole number", () => {
    expect(parseBound("50")).toBe(50);
    expect(parseBound("-5")).toBe(-5);
    expect(parseBound("")).toBeNull();
    expect(parseBound("  ")).toBeNull();
    expect(parseBound("5.5")).toBeNull();
    expect(parseBound("ten")).toBeNull();
  });
});
