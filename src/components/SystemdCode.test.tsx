// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SystemdCode } from "./SystemdCode";

afterEach(cleanup);

it("renders host content as selectable text without interpreting markup", () => {
  const text =
    '[Service]\nEnvironment="<img src=x onerror=alert(1)>"\nExecStart=/usr/bin/app ${CONFIG} %i\n';
  render(<SystemdCode text={text} label="Unit files" />);
  const code = screen.getByLabelText("Unit files");
  expect(code.textContent).toBe(text);
  expect(code.querySelector("img, script, svg")).toBeNull();
  expect(code.querySelector(".systemd-code-section")?.textContent).toBe("[Service]");
  expect(code.querySelector(".systemd-code-string")?.textContent).toContain("<img");
});

it("adds visual command metadata breaks without changing copied source text", () => {
  const text = '{ path=/bin/sh ; argv[]=/bin/sh -c "echo a;b" ; ignore_errors=no ; }';
  render(<SystemdCode text={text} label="ExecStart" command />);
  const code = screen.getByLabelText("ExecStart");
  expect(code.textContent).toBe(text);
  expect(code.querySelectorAll(".systemd-code-break")).toHaveLength(3);
  expect(code.querySelector(".systemd-code-string")?.textContent).toBe('"echo a;b"');
  const range = document.createRange();
  range.selectNodeContents(code);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  const setData = vi.fn();
  fireEvent.copy(code, { clipboardData: { setData } });
  expect(setData).toHaveBeenCalledWith("text/plain", text);
  document.getSelection()!.removeAllRanges();
});
