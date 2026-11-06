import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsPane } from "../../pages/SettingsPane";
import { ServicesPane } from "../../pages/ServicesPane";
import { ConnectionSection } from "../../components/ResizablePanels";
import { api } from "../../lib/api";
import { settings, connection, service, failedService } from "../app-fixtures";
import { systemdInspection } from "../systemd-fixtures";
import type { CachedList, SystemdUnit } from "../../types";
import registry from "./scenarios.json";
import "@fontsource-variable/inter/opsz.css";
import "../../styles.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "settings";
const state = params.get("state") ?? "populated";
if (
  !(scenario in registry.scenarios) ||
  !registry.scenarios[scenario as keyof typeof registry.scenarios].states.includes(state)
)
  throw new Error("Unknown UI review scenario/state");

const units = [
  { ...service, id: "worker.service", description: "Example queue worker" },
  { ...failedService, id: "backup.service", description: "Example backup" },
  ...Array.from({ length: state === "overflow" ? 80 : 6 }, (_, index) => ({
    ...service,
    id: `example-${String(index + 1).padStart(2, "0")}.service`,
    description: "Synthetic service",
  })),
];
if (state === "overflow") {
  units[0].id = `example-${"long-unit-name-".repeat(12)}worker.service`;
  units[0].description = "Synthetic long description. ".repeat(15);
}

// Reuse the browser-test data contracts. No native operation or host is contacted.
api.listServices = async () => units;
api.inspectSystemdUnit = async (_connection, id, section) =>
  systemdInspection(
    id,
    section === "properties"
      ? {
          Id: id,
          Description: units.find((unit) => unit.id === id)?.description ?? "Synthetic service",
          ActiveState: "active",
          SubState: "running",
          LoadState: "loaded",
          UnitFileState: "enabled",
          MainPID: "1234",
          MemoryCurrent: "104857600",
          TasksCurrent: "8",
          NRestarts: "0",
          Restart: "on-failure",
          ExecStart: "/usr/bin/example-worker --queue example",
        }
      : {},
    "[Service]\nExecStart=/usr/bin/example-worker\nRestart=on-failure\n",
  );
api.saveSettings = async () => undefined;

function SystemdFixture() {
  const [cache, setCache] = useState<CachedList<SystemdUnit>>({
    items: ["empty", "loading", "error"].includes(state) ? [] : units,
    fetchedAt: Date.now(),
    loading: state === "loading",
    error: ["error", "stale"].includes(state) ? "Synthetic read failure. Try again." : null,
  });
  // Mark the mount, including the early-return loading/empty/error branches.
  useEffect(() => {
    document.getElementById("root")!.setAttribute("data-ui-review-ready", "");
  }, []);
  return (
    <ConnectionSection section="services">
      <ServicesPane
        connection={{ ...connection(), displayName: "Example host" }}
        cache={cache}
        onCacheChange={setCache}
        focusId={["populated", "stale", "overflow"].includes(state) ? units[0].id : null}
        onViewLogs={() => undefined}
      />
    </ConnectionSection>
  );
}

createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    {scenario === "settings" ? (
      <SettingsPane
        settings={settings}
        defaults={settings}
        logTailOptions={[50, 100, 200, 500, 1000]}
        localShells={[
          { id: "powershell-7", kind: "powershell-7", label: "PowerShell 7", elevated: false },
          { id: "git-bash", kind: "git-bash", label: "Git Bash", elevated: false },
        ]}
        environment={{
          sshPath: "example-ssh",
          sshConfigPath: "example-config",
          sshAgentAvailable: false,
          platformSupported: true,
        }}
        appVersion="0.0.0-example"
        onCheckForUpdates={async () => ({ outcome: "current" })}
        onSaved={() => undefined}
        onClose={() => true}
        onDirtyChange={() => undefined}
      />
    ) : (
      <SystemdFixture />
    )}
  </div>,
);
