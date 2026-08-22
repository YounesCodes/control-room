import type { SavedConnectionInput } from "../types";

const USERNAME = /^[A-Za-z0-9._-]+$/;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

export function validateConnectionDraft(input: SavedConnectionInput): string | null {
  const displayName = input.displayName.trim();
  if (!displayName) return "Display name is required";
  if ([...displayName].length > 80 || hasControlCharacter(displayName)) {
    return "Display name must be at most 80 characters";
  }

  const destination = input.destination.trim();
  if (
    !destination ||
    [...destination].length > 255 ||
    destination.startsWith("-") ||
    /\s/.test(destination) ||
    hasControlCharacter(destination)
  ) {
    return "SSH destination must be one host, address, or OpenSSH alias";
  }

  const username = input.username.trim();
  if (!username) return "Username is required";
  if ([...username].length > 64 || !USERNAME.test(username)) {
    return "Username contains unsupported characters";
  }
  if (
    input.port !== null &&
    (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
  ) {
    return "Port must be between 1 and 65535";
  }
  const identityFile = input.identityFile?.trim();
  if (identityFile && ([...identityFile].length > 32_767 || hasControlCharacter(identityFile))) {
    return "Identity-file path is invalid";
  }
  return null;
}
