import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {}, invoke }));
import { api } from "./api";

const bytes = (text: string) => new TextEncoder().encode(text);
const flush = async () => {
  for (let step = 0; step < 5; step++) await Promise.resolve();
};

describe("terminal input delivery", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
  });

  it("does not submit later input until the preceding write completes", async () => {
    let finish!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const first = api.writeSession("ordered", bytes("ec"));
    await flush();
    const second = api.writeSession("ordered", bytes("ho\r"));
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    expect(invoke.mock.calls.map(([, args]) => args.data)).toEqual([
      [101, 99],
      [104, 111, 13],
    ]);
  });

  it("lets another terminal write while one session is blocked", async () => {
    let finish!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const first = api.writeSession("blocked", bytes("a"));
    await flush();
    await api.writeSession("independent", bytes("b"));
    expect(invoke).toHaveBeenCalledTimes(2);
    finish();
    await first;
  });

  it("reports a failed write and preserves the queued bytes for the next write", async () => {
    invoke.mockRejectedValueOnce(new Error("write failed"));
    const first = api.writeSession("failure", bytes("a"));
    const rejection = expect(first).rejects.toThrow("write failed");
    const input = bytes("b");
    const second = api.writeSession("failure", input);
    input[0] = 99;
    await rejection;
    await second;
    expect(invoke).toHaveBeenLastCalledWith("write_session", { sessionId: "failure", data: [98] });
    await api.writeSession("failure", bytes("d"));
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});
