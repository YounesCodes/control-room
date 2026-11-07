/// Clipboard reading for pasting into a terminal.
///
/// Text always wins: rich clipboard content from word processors carries a
/// text part, and pasting text is what a terminal does. Only when there is no
/// text at all — a screenshot, an image copied from a graphics tool — is an
/// image looked for, staged as a file next to the shell that will read it,
/// and its absolute path handed back to paste. Agent CLIs that accept image
/// input follow paths, so the paste stays a paste.

export interface PasteBlob {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PasteClipboardItem {
  readonly types: readonly string[];
  getType(type: string): Promise<PasteBlob | null>;
}

/// The structural slice of `navigator.clipboard` this module reads, so tests
/// can supply fakes without a real clipboard implementation.
export interface TerminalClipboard {
  readText(): Promise<string>;
  read?(): Promise<readonly PasteClipboardItem[]>;
}

/// Stages image bytes where the target shell can open them, and resolves to
/// the absolute path to paste. For a local shell the file lands on the same
/// machine; for a remote Workspace the bytes are written onto the host.
export type PasteImageStager = (bytes: Uint8Array, extension: string) => Promise<string>;

export type TerminalPasteContent =
  { kind: "text"; text: string } | { kind: "image"; path: string } | { kind: "empty" };

const IMAGE_TYPES: Array<[type: string, extension: string]> = [
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
];

function imageExtension(type: string): string | null {
  const known = IMAGE_TYPES.find(([candidate]) => candidate === type);
  if (known) return known[1];
  if (!type.startsWith("image/")) return null;
  const suffix = type.slice("image/".length).replace(/[^a-z0-9]/gi, "");
  return suffix.length > 0 && !suffix.includes("svg") ? suffix.toLowerCase() : null;
}

/// Reads what a paste should deliver, in order of preference: any text, then
/// the first image representation.
export async function readTerminalPaste(
  clipboard: TerminalClipboard,
  stage: PasteImageStager,
): Promise<TerminalPasteContent> {
  const text = (await clipboard.readText()).replace(/\0/g, "");
  if (text) return { kind: "text", text };
  if (!clipboard.read) return { kind: "empty" };
  const items = await clipboard.read();
  for (const item of items) {
    for (const type of item.types) {
      const extension = imageExtension(type);
      if (!extension) continue;
      try {
        const blob = await item.getType(type);
        if (!blob) continue;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.length === 0) continue;
        return { kind: "image", path: await stage(bytes, extension) };
      } catch {
        // A clipboard item can promise a representation it then refuses to
        // produce, such as a format owned by the source program. Try the next.
      }
    }
  }
  return { kind: "empty" };
}
