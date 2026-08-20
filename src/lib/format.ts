export function connectionTarget(connection: {
  destination: string;
  username: string | null;
  port: number | null;
}): string {
  const user = connection.username ? `${connection.username}@` : "";
  const port = connection.port ? `:${connection.port}` : "";
  return `${user}${connection.destination}${port}`;
}

export function relativeTime(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function timestampFromEpoch(value: string): string {
  const milliseconds = Number(value);
  return new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now()).toISOString();
}
