import type { CommandSnippet, SnippetParameter, SnippetRender } from "../types";

export const INSERTION_NOTICE =
  "Insert puts this text at the terminal cursor without Enter. Nothing runs until you press it.";

export const CREDENTIAL_WARNING =
  "Snippets are stored on this PC in plain text. Do not put passwords, keys, or tokens in one.";

export const SHELL_NOTICE = "Rendered with Bash quoting rules.";

export const MAX_PARAMETERS = 8;

export function blankParameter(): SnippetParameter {
  return {
    name: "",
    prompt: "",
    kind: "string",
    required: true,
    choices: [],
    minimum: null,
    maximum: null,
    defaultValue: null,
  };
}

// An author-set default is a starting value in the form, not a stored entry.
export function initialValues(snippet: CommandSnippet): Record<string, string> {
  const values: Record<string, string> = {};
  for (const parameter of snippet.parameters) {
    values[parameter.name] = parameter.defaultValue ?? "";
  }
  return values;
}

export function errorFor(render: SnippetRender | null, parameterName: string): string | null {
  if (!render) return null;
  return render.errors.find((error) => error.parameter === parameterName)?.message ?? null;
}

export function generalErrors(render: SnippetRender | null): string[] {
  if (!render) return [];
  return render.errors.filter((error) => error.parameter === null).map((error) => error.message);
}

export function scopeLabel(snippet: CommandSnippet, connectionName: string): string {
  return snippet.connectionId ? connectionName : "Every connection";
}

// An editor hint only. Rust parses the template for real and refuses anything
// this misses, so this never decides whether a snippet is valid.
export function templatePlaceholders(template: string): string[] {
  const found: string[] = [];
  const pattern = /\{\{([a-z][a-z0-9_]*)\}\}/g;
  for (const match of template.matchAll(pattern)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

export function parameterHint(parameter: SnippetParameter): string {
  const parts: string[] = [parameter.kind];
  if (!parameter.required) parts.push("optional");
  if (parameter.kind === "integer") {
    if (parameter.minimum !== null && parameter.maximum !== null) {
      parts.push(`${parameter.minimum} to ${parameter.maximum}`);
    } else if (parameter.minimum !== null) {
      parts.push(`${parameter.minimum} or more`);
    } else if (parameter.maximum !== null) {
      parts.push(`${parameter.maximum} or less`);
    }
  }
  if (parameter.kind === "choice") parts.push(parameter.choices.join(" / "));
  return parts.join(" · ");
}

export function parseChoices(value: string): string[] {
  return value
    .split(",")
    .map((choice) => choice.trim())
    .filter((choice) => choice.length > 0);
}

export function parseBound(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}
