export type SystemdCodeKind =
  "plain" | "comment" | "section" | "string" | "key" | "variable" | "path" | "operator";
export interface SystemdCodeToken {
  kind: SystemdCodeKind;
  text: string;
}

/** Display-only highlighting that retains every source character verbatim. */
export function systemdCodeTokens(text: string): SystemdCodeToken[] {
  const pattern =
    /(?<comment>^[\t ]*[#;][^\r\n]*)|(?<section>^[\t ]*\[[A-Za-z][^\]\r\n]*\][\t ]*(?=\r?$))|(?<string>"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|(?<key>\b[A-Za-z_][\w.[\]-]*(?=[\t ]*=))|(?<variable>\$(?:\{[^}\r\n]*\}|[A-Za-z_]\w*)|%[A-Za-z%])|(?<path>\/[^\s"'\\;{}]*)|(?<operator>[={};])/gm;
  const tokens: SystemdCodeToken[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    // Bound DOM work for large property dumps; the remaining text stays intact.
    if (tokens.length >= 6000) {
      tokens.push({ kind: "plain", text: text.slice(offset) });
      offset = text.length;
      break;
    }
    if (match.index > offset) tokens.push({ kind: "plain", text: text.slice(offset, match.index) });
    const kind = Object.keys(match.groups!).find(
      (name) => match.groups![name] !== undefined,
    ) as SystemdCodeKind;
    tokens.push({ kind, text: match[0] });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) tokens.push({ kind: "plain", text: text.slice(offset) });
  return tokens;
}
