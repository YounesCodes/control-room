const encoder = new TextEncoder();

export const DEFAULT_LOG_MAX_LINES = 10_000;
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

interface BufferedLine {
  value: string;
  bytes: number;
}

export class BoundedLogBuffer {
  private lines: BufferedLine[] = [];
  private head = 0;
  private partial = "";
  private partialBytes = 0;
  private totalBytes = 0;

  constructor(
    private readonly maxLines = DEFAULT_LOG_MAX_LINES,
    private readonly maxBytes = DEFAULT_LOG_MAX_BYTES,
  ) {}

  append(value: string): void {
    if (!value) return;
    const parts = `${this.partial}${value}`.split("\n");
    this.partial = parts.pop() ?? "";
    this.partialBytes = byteLength(this.partial);

    for (const part of parts) {
      const line = `${part}\n`;
      const bytes = byteLength(line);
      this.lines.push({ value: line, bytes });
      this.totalBytes += bytes;
    }
    this.trim();
  }

  clear(): void {
    this.lines = [];
    this.head = 0;
    this.partial = "";
    this.partialBytes = 0;
    this.totalBytes = 0;
  }

  snapshot(): string {
    return this.lines
      .slice(this.head)
      .map((line) => line.value)
      .join("")
      .concat(this.partial);
  }

  get byteCount(): number {
    return this.totalBytes + this.partialBytes;
  }

  get lineCount(): number {
    return this.lines.length - this.head + (this.partial ? 1 : 0);
  }

  private trim(): void {
    if (this.partialBytes > this.maxBytes) {
      this.partial = trimUtf8Tail(this.partial, this.maxBytes);
      this.partialBytes = byteLength(this.partial);
    }

    while (
      this.head < this.lines.length &&
      (this.lineCount > this.maxLines || this.byteCount > this.maxBytes)
    ) {
      this.totalBytes -= this.lines[this.head].bytes;
      this.head += 1;
    }

    if (this.head > 1_000 && this.head * 2 > this.lines.length) {
      this.lines = this.lines.slice(this.head);
      this.head = 0;
    }
  }
}

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function trimUtf8Tail(value: string, maxBytes: number): string {
  let start = Math.max(0, value.length - maxBytes);
  let result = value.slice(start);
  while (byteLength(result) > maxBytes && start < value.length) {
    start += 1;
    result = value.slice(start);
  }
  return result;
}
