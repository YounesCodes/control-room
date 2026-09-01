import type { ScratchpadScope } from "../types";

export const MAX_SCRATCHPAD_CHARS = 16_384;
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
  } catch {
    // SQLite remains authoritative; a storage-disabled WebView simply has no fallback draft.
  }
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
