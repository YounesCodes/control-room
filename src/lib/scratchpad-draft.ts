import type { ScratchpadScope } from "../types";

export { MAX_SCRATCHPAD_CHARS } from "../generated/ipc";
const DRAFT_PREFIX = "control-room:scratchpad-draft";
interface ScratchpadCoordinator {
  quiesce: () => Promise<void>;
  resume: () => void;
}

const coordinators = new Map<string, ScratchpadCoordinator>();

export function scratchpadDraftKey(scope: ScratchpadScope, ownerId: string): string {
  return `${DRAFT_PREFIX}:${scope}:${ownerId}`;
}

export function readScratchpadDraft(scope: ScratchpadScope, ownerId: string): string | null {
  try {
    return window.localStorage.getItem(scratchpadDraftKey(scope, ownerId));
  } catch {
    return null;
  }
}

export function writeScratchpadDraft(
  scope: ScratchpadScope,
  ownerId: string,
  text: string,
): boolean {
  try {
    window.localStorage.setItem(scratchpadDraftKey(scope, ownerId), text);
    return true;
  } catch {
    return false;
  }
}

export function clearScratchpadDraft(scope: ScratchpadScope, ownerId: string): void {
  try {
    window.localStorage.removeItem(scratchpadDraftKey(scope, ownerId));
  } catch {}
}

export function registerScratchpadQuiesce(
  scope: ScratchpadScope,
  ownerId: string,
  coordinator: ScratchpadCoordinator,
): () => void {
  const key = scratchpadDraftKey(scope, ownerId);
  coordinators.set(key, coordinator);
  return () => {
    if (coordinators.get(key) === coordinator) coordinators.delete(key);
  };
}

export async function quiesceScratchpad(scope: ScratchpadScope, ownerId: string): Promise<void> {
  await coordinators.get(scratchpadDraftKey(scope, ownerId))?.quiesce();
}

export function resumeScratchpad(scope: ScratchpadScope, ownerId: string): void {
  coordinators.get(scratchpadDraftKey(scope, ownerId))?.resume();
}

export interface ScratchpadCaret {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
  scrollTop: number;
}

const carets = new Map<string, ScratchpadCaret>();

export function rememberScratchpadCaret(
  scope: ScratchpadScope,
  ownerId: string,
  caret: ScratchpadCaret,
): void {
  carets.set(scratchpadDraftKey(scope, ownerId), caret);
}

export function recallScratchpadCaret(
  scope: ScratchpadScope,
  ownerId: string,
): ScratchpadCaret | null {
  return carets.get(scratchpadDraftKey(scope, ownerId)) ?? null;
}

export function forgetScratchpadCaret(scope: ScratchpadScope, ownerId: string): void {
  carets.delete(scratchpadDraftKey(scope, ownerId));
}

export function lineAt(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const end = text.indexOf("\n", offset);
  return text.slice(start, end === -1 ? text.length : end);
}
