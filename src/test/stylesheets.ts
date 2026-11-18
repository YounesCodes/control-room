/// <reference types="node" />

import { readFileSync } from "node:fs";

export const stylesEntry = new URL("../styles.css", import.meta.url);

export type StylesheetDeclaration = { property: string; value: string; important: boolean };

export type StylesheetRule = {
  sheet: string;
  selector: string;
  conditions: string[];
  declarations: StylesheetDeclaration[];
};

export type StylesheetAtRule = { sheet: string; name: string; prelude: string };

export type ParsedStylesheet = {
  sheet: string;
  imports: string[];
  rules: StylesheetRule[];
  atRules: StylesheetAtRule[];
};

const conditionalGroupRules = new Set(["media", "container", "supports", "layer"]);

function stylesheetImports(source: string): string[] {
  return parseStylesheet("", source).imports;
}

export function stylesheetPaths(): string[] {
  return stylesheetImports(readFileSync(stylesEntry, "utf8"));
}

function readStylesheet(relativePath: string): string {
  return readFileSync(new URL(relativePath, stylesEntry), "utf8");
}

export const stylesSource = stylesheetPaths().map(readStylesheet).join("\n");

export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const character of text) {
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(" || character === "[") {
      depth++;
    } else if (character === ")" || character === "]") {
      depth--;
    } else if (character === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function blockEnd(source: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      depth++;
    } else if (character === "}" && --depth === 0) {
      return index;
    }
  }
  throw new Error("Unclosed stylesheet block");
}

export function parseStylesheet(sheet: string, css: string): ParsedStylesheet {
  const parsed: ParsedStylesheet = { sheet, imports: [], rules: [], atRules: [] };
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));

  function walk(start: number, end: number, conditions: string[]) {
    let preludeStart = start;
    let quote = "";
    for (let index = start; index < end; index++) {
      const character = source[index];
      if (quote) {
        if (character === "\\") index++;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ";") {
        const statement = source.slice(preludeStart, index).trim();
        const target = statement.match(/^@import\s+(?:url\()?["']([^"']+)["']\)?/);
        if (target) parsed.imports.push(target[1]);
        else if (statement.startsWith("@"))
          parsed.atRules.push({
            sheet,
            name: statement.slice(1).split(/\s/)[0],
            prelude: statement,
          });
        preludeStart = index + 1;
      } else if (character === "{") {
        const close = blockEnd(source, index);
        const prelude = source.slice(preludeStart, index).trim().replace(/\s+/g, " ");
        const body = source.slice(index + 1, close);
        if (prelude.startsWith("@")) {
          const name = prelude.slice(1).split(/[\s(]/)[0];
          parsed.atRules.push({ sheet, name, prelude });
          if (conditionalGroupRules.has(name)) walk(index + 1, close, [...conditions, prelude]);
        } else {
          parsed.rules.push({
            sheet,
            selector: prelude,
            conditions,
            declarations: splitTopLevel(body, ";").flatMap((declaration) => {
              const colon = declaration.indexOf(":");
              if (colon < 0) return [];
              const value = declaration.slice(colon + 1).trim();
              return [
                {
                  property: declaration.slice(0, colon).trim(),
                  value: value.replace(/\s*!important$/, ""),
                  important: /!important$/.test(value),
                },
              ];
            }),
          });
        }
        index = close;
        preludeStart = close + 1;
      }
    }
  }

  walk(0, source.length, []);
  return parsed;
}

export function parsedStylesheets(): ParsedStylesheet[] {
  return stylesheetPaths().map((path) => parseStylesheet(path, readStylesheet(path)));
}
