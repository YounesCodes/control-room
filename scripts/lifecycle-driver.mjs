import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { remote } from "webdriverio";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

// Published builds have no WDIO plugin or debug diagnostics. Use only the native
// driver's protocol and the production Tauri bridge already present in the app.
export async function withInstalledApp(application, use, { applicationExits = false } = {}) {
  const port = await freePort(),
    nativePort = await freePort();
  const args = ["--port", String(port), "--native-port", String(nativePort)];
  if (process.env.CONTROL_ROOM_LIFECYCLE_NATIVE_DRIVER)
    args.push("--native-driver", process.env.CONTROL_ROOM_LIFECYCLE_NATIVE_DRIVER);
  const driver = spawn("tauri-driver", args, {
    env: { ...process.env, TAURI_WEBVIEW_AUTOMATION: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startupError,
    diagnostics = "",
    session;
  driver.once("error", (error) => {
    startupError = error;
  });
  for (const stream of [driver.stdout, driver.stderr])
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-16000);
    });
  try {
    const deadline = Date.now() + 30000;
    while (true) {
      if (startupError) throw startupError;
      assert.equal(driver.exitCode, null, `Native driver exited during startup: ${diagnostics}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) break;
      } catch {
        /* Driver is still starting. */
      }
      assert.ok(Date.now() < deadline, `Driver startup timed out: ${diagnostics}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    session = await remote({
      hostname: "127.0.0.1",
      port,
      logLevel: "warn",
      connectionRetryCount: 0,
      capabilities: { "tauri:options": { application } },
    });
    await session.waitUntil(
      () => session.execute(() => typeof globalThis.__TAURI_INTERNALS__?.invoke === "function"),
      { timeout: 30000 },
    );
    const invoke = async (command, args = {}) => {
      const result = await session.executeAsyncScript(
        `
        var done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(
          function(value) { done({ok: true, value: value}); },
          function(error) { done({ok: false, failure: String(error)}); }
        );`,
        [command, args],
      );
      assert.ok(result.ok, `${command}: ${result.failure}`);
      return result.value;
    };
    return await use(invoke, session);
  } finally {
    try {
      if (session) await closeSession(session, applicationExits);
    } finally {
      if (driver.pid && driver.exitCode === null) {
        const stopped = new Promise((resolve) => driver.once("exit", resolve));
        driver.kill();
        await Promise.race([
          stopped,
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error("Owned lifecycle driver did not exit")),
              10000,
            ).unref();
          }),
        ]);
      }
      // Closing the session only asks the app to quit. An installer or
      // uninstaller that starts before it has exited refuses to run.
      if (!applicationExits) await applicationExit(application);
    }
  }
}

function applicationRunning(application) {
  if (process.platform === "win32") {
    const count = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "@(Get-Process | Where-Object { $_.Path -eq $env:CONTROL_ROOM_LIFECYCLE_APPLICATION }).Count",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CONTROL_ROOM_LIFECYCLE_APPLICATION: application },
        windowsHide: true,
      },
    );
    return Number(count.trim()) > 0;
  }
  try {
    // pgrep exits 1 when nothing matches.
    const pattern = application.replace(/[^A-Za-z0-9/_-]/g, (character) => `[${character}]`);
    execFileSync("pgrep", ["-f", "--", pattern], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function applicationExit(application) {
  const deadline = Date.now() + 30000;
  while (applicationRunning(application)) {
    assert.ok(Date.now() < deadline, "The installed application did not exit");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function closeSession(session, applicationExits) {
  try {
    await session.deleteSession();
  } catch (error) {
    if (!applicationExits) throw error;
    // The updater deliberately exits the attached app. The caller must
    // independently prove replacement and the newly launched process.
    console.log(`Updated app closed its original WebDriver session: ${error.message}`);
  }
}
