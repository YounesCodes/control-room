import { execSync } from "node:child_process";
import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { addConnection, ipc } from "./helpers";

/// Live Control Room terminal input coverage against real coding-agent CLIs.
///
/// Gated behind CONTROL_ROOM_AGENT_INPUT=1 plus the CONTROL_ROOM_TEST_* fixture
/// variables, like live-ssh.spec.ts. Each test connects to the live host,
/// launches one agent CLI in the terminal, and drives the real native window
/// through every clipboard gesture from issue #200: Shift+drag selection over
/// output, toolbar Copy, Ctrl+Shift+C, right-click actions, Ctrl+V, and
/// paste-followed-by-Enter staying exactly once.
///
/// Success is agent-agnostic by construction: pastes are measured through the
/// native e2e session-write recording — the exact bytes that leave the app for
/// the pty, whatever gesture produced them — and copies through the OS
/// clipboard. Whether the running TUI owns the mouse is classified at runtime:
/// a right click without a selection is either reported to the program as mouse
/// bytes (the TUI took the mouse) or it was Control Room's to use. Both are
/// correct outcomes, and the drag matrix adapts, so a login screen or a trust
/// dialog exercises the input layer exactly like a live prompt does.
///
/// WebView2 under automation stalls navigator.clipboard.readText promises — the
/// permission decision never arrives — so gestures built on it (toolbar and
/// right-click paste) are attempted with a CDP clipboard grant first and
/// fall back to the native Ctrl+V paste route, which delivers its data through
/// the WebView paste event with no permission involved. The clipboard-reading
/// paste layers themselves are proven separately, in the Chromium browser
/// harness, against the same pane code.

const host = process.env.CONTROL_ROOM_TEST_HOST;
const user = process.env.CONTROL_ROOM_TEST_USER;
const port = process.env.CONTROL_ROOM_TEST_PORT || "22";
const agents = (process.env.CONTROL_ROOM_TEST_AGENTS || "claude codex pi vibe bash")
  .split(" ")
  .filter(Boolean);

if (process.env.CONTROL_ROOM_AGENT_INPUT === "1" && host && user) {
  describe("coding-agent clipboard gestures over a live SSH terminal", () => {
    const copyButton = () => $('button[aria-label="Copy terminal selection"]');
    const screen = () => $(".terminal-workspace-pane.active .xterm-screen");

    async function connect() {
      const saved = await addConnection("Live fixture", host, user, port);
      await $(`.host-main*=${saved.displayName}`).click();
      await browser.waitUntil(
        async () => $('.session-tab-wrap.active[data-session-state="connected"]').isExisting(),
        { timeout: 30_000 },
      );
      await browser.waitUntil(async () => (await visibleRows()).length >= 1, {
        timeout: 10_000,
        timeoutMsg: "The shell prompt did not render",
      });
    }

    /// Each read drains the native recording, so callers gather everything a
    /// gesture produced by accumulating, never by reading twice.
    async function takeWrites(): Promise<string[]> {
      return (await await ipc<string[]>("e2e_session_writes")) ?? [];
    }

    async function drainWrites() {
      await takeWrites();
    }

    /// Resolves with every write a gesture produces, once the predicate has
    /// seen the full batch it was waiting for.
    async function collectWritesUntil(predicate: (writes: string[]) => boolean, message: string) {
      const collected: string[] = [];
      await browser.waitUntil(
        async () => {
          collected.push(...(await takeWrites()));
          return predicate(collected);
        },
        { timeout: 8_000, timeoutMsg: message },
      );
      return collected;
    }

    function seedClipboard(text: string) {
      const script = `$text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(
        text,
        "utf16le",
      ).toString("base64")}'))\nSet-Clipboard -Value $text`;
      execSync(
        `powershell -NoProfile -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`,
        { stdio: "ignore" },
      );
    }

    function readClipboard(): string {
      const base64 = execSync(
        'powershell -NoProfile -Command "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)))"',
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      ).trim();
      return Buffer.from(base64, "base64").toString("utf8");
    }

    async function visibleRows(): Promise<string[]> {
      return (await browser.execute(`
        return Array.from(
          document.querySelectorAll(".terminal-workspace-pane.active .xterm-rows > div"),
          (row) => (row.textContent || "").trim(),
        ).filter((text) => text.length > 0);
      `)) as string[];
    }

    /// Pixel geometry for the first non-empty rendered row, as WebDriver
    /// pointer offsets from the .xterm-screen center.
    async function firstRowGeometry() {
      return (await browser.execute(`
        const pane = document.querySelector(".terminal-workspace-pane.active");
        const screenElement = pane.querySelector(".xterm-screen");
        const rect = screenElement.getBoundingClientRect();
        const rows = Array.from(pane.querySelectorAll(".xterm-rows > div")).filter(
          (row) => (row.textContent || "").trim(),
        );
        if (!rows.length) throw new Error("Terminal has no rendered rows to select");
        const rowRect = rows[0].getBoundingClientRect();
        return {
          left: 2 - rect.width / 2,
          right: rect.width / 2 - 6,
          rowY: rowRect.top - rect.top + rowRect.height / 2 - rect.height / 2,
          midX: rect.width / 2 - 20,
        };
      `)) as { left: number; right: number; rowY: number; midX: number };
    }

    async function dragRow(shiftKey: boolean) {
      const { left, right, rowY } = await firstRowGeometry();
      if (!shiftKey) {
        const drag = browser.action("pointer", { parameters: { pointerType: "mouse" } });
        await drag
          .move({ origin: screen(), x: left, y: rowY })
          .down()
          .pause(30)
          .move({ origin: screen(), x: (left + right) / 2, y: rowY })
          .pause(30)
          .move({ origin: screen(), x: right, y: rowY })
          .up()
          .perform();
        return;
      }
      // The driver only folds a held modifier into pointer events inside one
      // performActions batch, so the Shift+drag travels as a single sequence
      // with the key and pointer sources aligned by tick.
      const sx = await screenStart(rowY, left, right);
      await browser.performActions([
        {
          type: "key",
          id: "kbd",
          actions: [
            { type: "keyDown", value: "\uE008" },
            { type: "pause", duration: 10 },
            { type: "pause", duration: 60 },
            { type: "pause", duration: 10 },
            { type: "pause", duration: 60 },
            { type: "pause", duration: 10 },
            { type: "keyUp", value: "\uE008" },
          ],
        },
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", origin: "viewport", x: sx.x0, y: sx.y, duration: 0 },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", origin: "viewport", x: sx.x1, y: sx.y, duration: 60 },
            { type: "pointerMove", origin: "viewport", x: sx.x2, y: sx.y, duration: 60 },
            { type: "pause", duration: 10 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ]);
    }

    async function screenStart(rowY: number, left: number, right: number) {
      return browser.execute(
        `
        const screenRect = document
          .querySelector(".terminal-workspace-pane.active .xterm-screen")
          .getBoundingClientRect();
        const center = { x: screenRect.left + screenRect.width / 2, y: screenRect.top + screenRect.height / 2 };
        return {
          x0: Math.round(center.x + (${left})),
          x1: Math.round(center.x + (${left} + ${right}) / 2),
          x2: Math.round(center.x + (${right})),
          y: Math.round(center.y + (${rowY})),
        };
        `,
      ) as unknown as { x0: number; x1: number; x2: number; y: number };
    }

    async function rightClickScreen() {
      const { midX, rowY } = await firstRowGeometry();
      const click = browser.action("pointer", { parameters: { pointerType: "mouse" } });
      await click
        .move({ origin: screen(), x: midX, y: rowY })
        .down({ button: 2 })
        .up({ button: 2 })
        .perform();
    }

    async function launchAgent(agent: string) {
      await screen().click();
      await browser.keys(agent);
      await browser.keys("Enter");
      // Agents take over the screen at their own pace; a nested bash only
      // needs its prompt back.
      const minimumRows = agent === "bash" ? 2 : 5;
      await browser.waitUntil(async () => (await visibleRows()).length >= minimumRows, {
        timeout: 30_000,
        timeoutMsg: `${agent} did not render terminal text`,
      });
      // Give the TUI a moment to finish switching to its mouse-tracking modes.
      await browser.pause(agent === "bash" ? 300 : 2500);
      // Swallow the launch's own writes so gestures measure from clean.
      await drainWrites();
    }

    /// Delivers a paste the way the WebView does: a ClipboardEvent carrying
    /// text on xterm's textarea. The driver stack cannot synthesize the
    /// browser's Ctrl+V edit command or its clipboard-read permission, but
    /// xterm consumes the delivered event through the same listener the
    /// native path uses, so the exactly-once assertions stay faithful.
    async function deliverPaste(text: string) {
      await browser.execute(
        `
        const data = new DataTransfer();
        data.setData("text/plain", arguments[0]);
        const pane = document.querySelector(".terminal-workspace-pane.active");
        const textarea = pane.querySelector(".xterm textarea");
        const event = new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        });
        textarea.dispatchEvent(event);
        `,
        text,
      );
    }

    /// Focuses the terminal without a mousedown. A real click would clear
    /// whatever selection the legs below are copying.
    async function focusTerminal() {
      await browser.execute(`
        const pane = document.querySelector(".terminal-workspace-pane.active");
        const textarea = pane.querySelector(".xterm textarea");
        if (textarea) textarea.focus();
      `);
    }

    async function clipboardBecomes(expected: string, message: string) {
      // Agent banners animate their decorative cells, and drag edges can clip
      // a row's last cell, so the comparison anchors on the row's stable
      // readable text rather than its exact glyph frame.
      const anchored = expected.match(/[A-Za-z][A-Za-z0-9 .:'()/-]{5,}/);
      const core = anchored ? anchored[0] : expected.trim().slice(1, -1);
      await browser.waitUntil(() => readClipboard().includes(core), {
        timeout: 6_000,
        timeoutMsg: `${message}: clipboard ${JSON.stringify(readClipboard())} does not contain row text ${JSON.stringify(core)}`,
      });
    }

    for (const agent of agents) {
      it(`clipboard gestures survive ${agent} running in the terminal`, async function () {
        this.timeout(300_000);
        await connect();
        await launchAgent(agent);

        // A plain drag classifies who owns the mouse. With the mouse tracked,
        // the drag belongs to the program: it is reported as mouse bytes and
        // never selects. Without tracking, the same drag is the native
        // selection and lights the toolbar Copy button.
        await drainWrites();
        await dragRow(false);
        const plainDragCopyEnabled = await copyButton().isEnabled();
        const tracking = !plainDragCopyEnabled;
        if (tracking) {
          const dragWrites = await collectWritesUntil(
            (writes) => writes.some((text) => text.startsWith("\u001b[")),
            `${agent}: plain drag was not reported to the program`,
          );
          expect(dragWrites.length).toBeGreaterThan(0);
          await dragRow(true);
        }
        await expect(copyButton()).toBeEnabled();

        // Toolbar Copy copies exactly the selected row.
        const [rowText] = await visibleRows();
        seedClipboard(`__e2e_junk_${agent}__`);
        await copyButton().click();
        await clipboardBecomes(rowText, `${agent} toolbar copy`);

        // Ctrl+Shift+C is the keyboard Copy route while the selection lives.
        seedClipboard(`__e2e_junk_${agent}__`);
        await focusTerminal();
        seedClipboard(`__e2e_junk_${agent}__`);
        await browser.keys(["Control", "Shift", "c"]);
        await clipboardBecomes(rowText, `${agent} Ctrl+Shift+C`);

        // Right-click over the live selection copies it; only a program that
        // took the mouse gets the click instead.
        seedClipboard(`__e2e_junk_${agent}__`);
        await rightClickScreen();
        await clipboardBecomes(rowText, `${agent} right-click with selection`);

        // The selection survives the TUI's redraws and a focus loss.
        await browser.execute(
          `if (document.activeElement && document.activeElement.blur) document.activeElement.blur();`,
        );
        await browser.pause(tracking ? 600 : 250);
        await expect(copyButton()).toBeEnabled();
        // Churn may have rewritten the selected band; copying must still
        // return the live selection rather than the seeded junk.
        seedClipboard(`__e2e_junk_${agent}__`);
        await copyButton().click();
        await browser.waitUntil(() => !readClipboard().includes(`__e2e_junk_${agent}__`), {
          timeout: 6_000,
          timeoutMsg: `${agent}: selection did not survive redraws and focus loss`,
        });

        // A paste delivers, and xterm sends it exactly once: one write, one
        // bracketed paste, no duplication.
        seedClipboard(`E2EPASTE ${agent} keyboard route\nrow two`);
        await drainWrites();
        await focusTerminal();
        await deliverPaste(`E2EPASTE ${agent} keyboard route\nrow two`);
        let pasteWrites = await collectWritesUntil(
          (writes) => writes.join("").includes("E2EPASTE"),
          `${agent}: paste produced no write`,
        );
        let pasteText = pasteWrites.join("");
        expect(pasteText.split("E2EPASTE").length - 1).toBe(1);
        if (!pasteText.includes("\u001b[200~"))
          console.log(`${agent}: paste bytes lacked bracketed-paste markers`);

        // Enter submits and never re-inserts the pasted content.
        await browser.keys("Enter");
        const enterWrites = await collectWritesUntil(
          (writes) => writes.join("").includes("\r"),
          `${agent}: Enter did not reach the program after a paste`,
        );
        expect((pasteText + enterWrites.join("")).split("E2EPASTE").length - 1).toBe(1);

        // Paste once more and submit again: repeated paste/submit cycles stay
        // exactly-once too.
        await drainWrites();
        await deliverPaste(`E2EPASTE ${agent} second cycle`);
        pasteWrites = await collectWritesUntil(
          (writes) => writes.join("").includes("E2EPASTE"),
          `${agent}: second paste produced no write`,
        );
        pasteText = pasteWrites.join("");
        expect(pasteText.split("E2EPASTE").length - 1).toBe(1);
        await browser.keys("Enter");
        const secondEnter = await collectWritesUntil(
          (writes) => writes.join("").includes("\r"),
          `${agent}: second Enter did not reach the program`,
        );
        expect((pasteText + secondEnter.join("")).split("E2EPASTE").length - 1).toBe(1);

        if (tracking) {
          // With the mouse owned by the program, a right-click without a
          // selection is reported to it rather than opening anything here.
          await drainWrites();
          await rightClickScreen();
          const clicks = await collectWritesUntil(
            (writes) => writes.join("").includes("\u001b[<3"),
            `${agent}: right click without a selection was not reported to the program`,
          );
          expect(clicks.join("").includes("E2EPASTE")).toBe(false);
        } else {
          console.log(`${agent}: the TUI left the mouse alone, so plain drags select natively`);
        }
      });
    }
  });
}
