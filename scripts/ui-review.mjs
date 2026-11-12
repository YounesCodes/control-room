/* global window, Element, document, requestAnimationFrame, getComputedStyle */
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { parseOptions, registry } from "./ui-review-options.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "test-results/ui-review");
const lockPath = path.join(output, ".lock");
let browser;
let server;
let locked = false;
let stopping;
let session;
const sessionPath = path.join(output, "session.json");
async function cleanup() {
  stopping ??= (async () => {
    await browser?.close().catch(() => {});
    await server?.close();
    if (locked) await rm(lockPath, { force: true });
  })();
  return stopping;
}
async function lock() {
  await mkdir(output, { recursive: true });
  try {
    const file = await open(lockPath, "wx");
    locked = true;
    await file.writeFile(String(process.pid));
    await file.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await readFile(lockPath, "utf8"));
    if (pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if (probe.code === "ESRCH") {
          await rm(lockPath);
          return lock();
        }
      }
    }
    throw new Error("Another UI review owns test-results/ui-review/.lock. Run captures serially.", {
      cause: error,
    });
  }
}

// Sample the real component's WAAPI animation without slowing product CSS.
// This proves transition poses, not real-time frame pacing or native behavior.
async function motion(page, definition, directory) {
  const frames = [];
  const save = async (name, metadata) => {
    await page.screenshot({ path: path.join(directory, name), animations: "allow" });
    frames.push({ path: name, ...metadata });
  };
  await save("00-before.png", { phase: "before" });
  await page.evaluate(() => {
    window.__reviewAnimations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      animation.pause();
      animation.currentTime = 0;
      window.__reviewAnimations.push(animation);
      return animation;
    };
  });
  const select = page.getByRole("combobox", { name: definition.select, exact: true });
  if (await select.isVisible()) await select.selectOption(definition.option);
  else await page.getByRole("button", { name: definition.button, exact: true }).click();
  await page.waitForFunction(() => window.__reviewAnimations.length > 0);
  const samples = [];
  for (const [index, fraction] of [0, 0.5, 1].entries()) {
    const sample = await page.evaluate(
      async ({ target, fraction }) => {
        const element = document.querySelector(target);
        const animation = window.__reviewAnimations.find((item) => item.effect.target === element);
        if (!animation) throw new Error(`No component animation on ${target}`);
        const duration = Number(animation.effect.getComputedTiming().duration);
        if (!(duration > 0 && duration <= 2000)) throw new Error("Unbounded or absent motion");
        animation.currentTime = duration * fraction;
        await new Promise(requestAnimationFrame);
        const style = getComputedStyle(element);
        return { timeMs: duration * fraction, opacity: style.opacity, transform: style.transform };
      },
      { target: definition.target, fraction },
    );
    samples.push(sample);
    await save(`${String(index + 1).padStart(2, "0")}-${["start", "during", "after"][index]}.png`, {
      phase: ["start", "during", "after"][index],
      ...sample,
    });
  }
  const poses = samples.map(({ opacity, transform }) => JSON.stringify({ opacity, transform }));
  if (new Set(poses).size !== 3)
    throw new Error("Transition produced static or missing motion poses");
  return { description: definition.description, method: "paused WAAPI timeline samples", frames };
}

let options;
try {
  options = parseOptions(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
if (options?.help) {
  console.log(`Usage: npm run ui:capture -- --scenario NAME [--state NAME] [--viewport all|${Object.keys(registry.viewports).join("|")}]
       npm run ui:motion -- --scenario settings [--viewport all|${Object.keys(registry.viewports).join("|")}]
All viewports by default. PNGs and manifest.json: test-results/ui-review/SCENARIO/STATE/VIEWPORT/TYPE/
Exit codes: 0 captured, 1 capture failed, 2 invalid arguments. One session at a time.
Motion samples real transitions. Still screenshots finish animations before capture.
${JSON.stringify(registry, null, 2)}`);
} else if (options) {
  const deadline = setTimeout(() => {
    console.error("UI review exceeded its 120 second session budget");
    void cleanup().finally(() => process.exit(1));
  }, 120_000);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => void cleanup().finally(() => process.exit(1)));
  }
  try {
    await lock();
    session = { ...options, status: "running", manifests: [] };
    await writeFile(sessionPath, JSON.stringify(session, null, 2) + "\n");
    server = await createServer({
      root,
      configFile: false,
      envDir: false,
      plugins: [react()],
      resolve: {
        alias: Object.fromEntries(
          [
            "@tauri-apps/api/core",
            "@tauri-apps/api/event",
            "@tauri-apps/api/window",
            "@tauri-apps/plugin-dialog",
          ].map((name) => [name, path.join(root, "src/test/ui-review/native.ts")]),
        ),
      },
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, open: false, hmr: false },
    });
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    browser = await chromium.launch({ headless: true, timeout: 30_000 });
    const viewports =
      options.viewport === "all" ? Object.keys(registry.viewports) : [options.viewport];
    for (const name of viewports) {
      const viewport = registry.viewports[name];
      const directory = path.join(output, options.scenario, options.state, name, options.type);
      await mkdir(directory, { recursive: true });
      const manifestPath = path.join(directory, "manifest.json");
      for (const file of [
        "capture.png",
        "00-before.png",
        "01-start.png",
        "02-during.png",
        "03-after.png",
        "manifest.json",
      ])
        await rm(path.join(directory, file), { force: true });
      const manifest = {
        schemaVersion: 1,
        scenario: options.scenario,
        state: options.state,
        viewport: { name, ...viewport },
        captureType: options.type,
        status: "failed",
        pathsRelativeTo: "manifest directory",
        results: [],
        limitations: [
          "Synthetic React fixtures in Chromium; no SSH, Tauri, WebView2, native windows or terminal process verification.",
          "Motion frames sample paused transition poses, not real-time performance or dropped frames.",
          "Successful capture is not a subjective visual review. Inspect the PNGs.",
        ],
      };
      let context;
      try {
        context = await browser.newContext({
          viewport,
          locale: "en-US",
          timezoneId: "UTC",
          deviceScaleFactor: 1,
        });
        // Fixtures may only load from their ephemeral local server.
        await context.route("**/*", (route) =>
          route.request().url().startsWith(origin) ? route.continue() : route.abort(),
        );
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        await page.clock.setFixedTime(new Date("2026-11-01T10:00:00Z"));
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const definition = registry.scenarios[options.scenario];
        await page.goto(
          `${origin}ui-review/?${new URLSearchParams({ scenario: options.scenario, state: options.state })}`,
          { waitUntil: "networkidle", timeout: 30_000 },
        );
        await page.locator(definition.ready).waitFor();
        for (const action of definition.prepare?.[options.state] ?? []) {
          let locator = action.selector
            ? page.locator(action.selector)
            : page.getByRole(action.role, { name: action.name, exact: true });
          if (action.last) locator = locator.last();
          // Optional steps cover layout-only controls, such as the compact
          // navigation toggle that other viewports never render.
          if (action.optional && !(await locator.isVisible())) continue;
          // Hover steps reveal controls that only appear under the pointer,
          // such as a Saved Connection's actions button.
          if (action.hover) await locator.hover();
          else await locator.click();
        }
        if (definition.settled?.[options.state])
          await page.locator(definition.settled[options.state]).waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(0, 0);
        manifest.layout = await page.evaluate(() => {
          const box = (selector) => {
            const element = document.querySelector(selector);
            return element && element.getBoundingClientRect().toJSON();
          };
          return {
            shell: box(".app-shell"),
            compactNavigation: document.querySelector(".app-shell").hasAttribute("data-compact"),
            header: box(".app-bar"),
            sidebar: box(".sidebar"),
            tabs: box(".session-tabs"),
            content: box(".connection-section"),
            settings: box(".settings-page"),
            documentWidth: document.documentElement.scrollWidth,
          };
        });
        const {
          shell,
          compactNavigation,
          header,
          sidebar,
          tabs,
          content,
          settings: settingsBounds,
        } = manifest.layout;
        if (!shell || !header || header.height <= 0 || Math.abs(shell.width - viewport.width) > 1)
          throw new Error(
            "Capture must render the App shell at the requested viewport without scaling",
          );
        if (
          options.scenario === "systemd" &&
          ((!compactNavigation && (!sidebar || sidebar.width <= 0)) ||
            !tabs ||
            !content ||
            (!compactNavigation && content.left < sidebar.right - 1) ||
            content.top < Math.max(header.bottom, tabs.bottom) - 1 ||
            (!compactNavigation && content.width >= viewport.width - 1))
        )
          throw new Error(
            "Systemd capture must respect the real rail, titlebar, and workspace tabs",
          );
        if (
          options.scenario === "settings" &&
          (!settingsBounds || settingsBounds.top < header.bottom - 1)
        )
          throw new Error("Settings capture must respect the real titlebar");
        if (options.type === "motion") {
          manifest.motion = await motion(page, definition.motion, directory);
          manifest.results = manifest.motion.frames.map((frame) => frame.path);
        } else {
          await page.screenshot({
            path: path.join(directory, "capture.png"),
            animations: "disabled",
          });
          manifest.results = ["capture.png"];
        }
        if (errors.length) throw new Error(errors.join("\n"));
        manifest.status = "passed";
      } catch (error) {
        manifest.error = error.message;
        throw error;
      } finally {
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
        session.manifests.push(path.relative(output, manifestPath));
        console.log(
          JSON.stringify({ manifest: path.relative(root, manifestPath), status: manifest.status }),
        );
        await context?.close();
      }
    }
    session.status = "passed";
  } catch (error) {
    console.error(`UI review failed: ${error.message}`);
    if (session) {
      session.status = "failed";
      session.error = error.message;
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    try {
      if (session) {
        await writeFile(sessionPath, JSON.stringify(session, null, 2) + "\n");
        console.log(
          JSON.stringify({ session: path.relative(root, sessionPath), status: session.status }),
        );
      }
    } finally {
      await cleanup();
    }
  }
}
