// Use registered production IPC commands, never direct writes to the database.
import assert from "node:assert/strict";

export async function seedLifecycleData(invoke, session) {
  const group = await invoke("create_connection_group", { name: "Lifecycle group" });
  await invoke("create_connection_tag", { name: "upgrade", color: "#808080" });
  const connection = await invoke("create_connection", {
    input: {
      displayName: "Lifecycle connection",
      destination: "127.0.0.1",
      username: "tester",
      port: 1,
      identityFile: null,
      historyEnabled: true,
      sudoEnabled: false,
      groupId: group.id,
      tagNames: ["upgrade"],
    },
  });
  await invoke("set_connection_group_collapsed", { id: group.id, collapsed: true });
  const { current } = await invoke("get_settings_contract");
  await invoke("save_settings", {
    settings: {
      ...current,
      automaticUpdateChecks: false,
      terminalFontSize: 17,
      terminalFontFamily: "monospace",
    },
  });
  for (const note of [
    { scope: "global", ownerId: "global", connectionId: null, text: "Global note\nè é 日本語" },
    {
      scope: "connection",
      ownerId: connection.id,
      connectionId: connection.id,
      text: "Connection note\nKeep across upgrade",
    },
  ])
    await invoke("save_scratchpad_note", { input: note });
  await invoke("add_history_entry", {
    input: {
      connectionId: connection.id,
      sessionId: "lifecycle-history",
      command: "printf lifecycle_history",
      cwd: "/srv",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      shell: "bash",
    },
  });
  await invoke("set_connection_history_enabled", { connectionId: connection.id, enabled: false });
  await seedLifecycleLayout(invoke, session);
  return readLifecycleData(invoke, connection.id);
}

export async function readLifecycleData(invoke, connectionId) {
  const settings = (await invoke("get_settings_contract")).current;
  return {
    connections: await invoke("list_connections"),
    groups: await invoke("list_connection_groups"),
    tags: await invoke("list_connection_tags"),
    settings: Object.fromEntries(
      ["automaticUpdateChecks", "terminalFontSize", "terminalFontFamily"].map((key) => [
        key,
        settings[key],
      ]),
    ),
    workspace: await invoke("get_workspace_state"),
    notes: await Promise.all([
      invoke("get_scratchpad_note", { scope: "global", ownerId: "global", connectionId: null }),
      invoke("get_scratchpad_note", { scope: "connection", ownerId: connectionId, connectionId }),
      (async () => {
        const state = await invoke("get_workspace_state");
        return state.workspaces.length
          ? invoke("get_scratchpad_note", {
              scope: "local",
              ownerId: state.workspaces[0].id,
              connectionId: null,
            })
          : null;
      })(),
    ]),
    history: await invoke("get_history", { connectionId, search: "", limit: 500 }),
  };
}

export function assertLifecycleData(expected, actual) {
  assert.deepEqual(actual, expected, "Installed upgrade must preserve every seeded data field");
}

async function seedLifecycleLayout(invoke, session) {
  const dialog = await session.$("[role=dialog]");
  if (await dialog.isExisting()) await dialog.$("button=Cancel").click();
  const catalog = await invoke("list_local_shells");
  const shell = catalog.profiles.find((profile) => !profile.elevated);
  assert.ok(shell, "Lifecycle fixture needs an installed local shell");
  await session.$('button[aria-label="New terminal"]').click();
  await session.$(`.new-terminal-menu [aria-label="Local terminals: ${shell.label}"]`).click();
  await session.$(".terminal-workspace-pane.active .xterm-screen").waitForDisplayed();
  await session.$('[aria-label="Focus terminal"]').click();
  await session.waitUntil(() =>
    session.execute(() => !globalThis.document.documentElement.dataset.focusTransition),
  );
  const legacySplit = await session.$('[aria-label="Split terminal"]');
  if (await legacySplit.isExisting()) {
    // Published v0.9.4 predates the shared New terminal split launcher.
    await legacySplit.click();
    await session.$(".terminal-split-menu").$("button*=Split vertically").click();
    await session
      .$(`.terminal-split-menu [aria-label="New local terminal: ${shell.label}"]`)
      .click();
  } else {
    await session.$('button[aria-label="New terminal"]').click();
    await session.$(".new-terminal-menu").$("button*=Split right").click();
    await session.$(`.new-terminal-menu [aria-label="New local terminal: ${shell.label}"]`).click();
  }
  await session
    .$(".terminal-workspace-pane.active .xterm-helper-textarea")
    .addValue("echo LIFECYCLE_NATIVE_INPUT");
  await session.keys("Enter");
  await session.waitUntil(() =>
    session.execute(() =>
      Array.from(
        globalThis.document.querySelectorAll(".terminal-workspace-pane.active .xterm-rows > div"),
      ).some((row) => row.textContent.trim() === "LIFECYCLE_NATIVE_INPUT"),
    ),
  );
  await session.waitUntil(async () => {
    const state = await invoke("get_workspace_state");
    return state.workspaces.length === 2 && state.terminalGroups.length === 1;
  });
  const divider = await session.$('[aria-label="Resize terminal split 1"]');
  await session.execute((node) => node.focus(), divider);
  await session.keys("ArrowRight");
  await session.waitUntil(
    async () => (await invoke("get_workspace_state")).terminalGroups[0].layout.ratio !== undefined,
  );
  const state = await invoke("get_workspace_state");
  await invoke("save_scratchpad_note", {
    input: {
      scope: "local",
      ownerId: state.workspaces[0].id,
      connectionId: null,
      text: "Local terminal note survives an installed upgrade",
    },
  });
}
