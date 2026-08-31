import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Copy, LayoutTemplate, Pencil, Plus, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import {
  duplicateWorkspacePresetInput,
  isSupportedWorkspacePresetView,
  workspacePresetViewLabel,
  workspacePresetViewStatus,
} from "../lib/workspace-presets";
import type {
  HostCapabilities,
  SavedConnection,
  WorkspacePreset,
  WorkspacePresetInput,
  WorkspacePresetSelector,
} from "../types";

function selectorLabel(selector: WorkspacePresetSelector | null) {
  if (!selector) return null;
  if (selector.kind === "systemdUnit") return selector.unit;
  if (selector.kind === "dockerContainer") return selector.container;
  return `${selector.sourceType}: ${selector.id}`;
}

function duplicateName(name: string, presets: WorkspacePreset[]) {
  const names = new Set(presets.map((preset) => preset.name.toLocaleLowerCase()));
  let candidate = `${name} copy`;
  let number = 2;
  while (names.has(candidate.toLocaleLowerCase())) candidate = `${name} copy ${number++}`;
  return candidate;
}

export function WorkspacePresetsDialog({
  presets,
  connections,
  currentConnectionId,
  currentViewCount,
  capabilities,
  onCreateFromCurrent,
  onCreate,
  onUpdate,
  onDelete,
  onApply,
  onClose,
}: {
  presets: WorkspacePreset[];
  connections: SavedConnection[];
  currentConnectionId: string | null;
  currentViewCount: number;
  capabilities: Record<string, HostCapabilities>;
  onCreateFromCurrent: (name: string) => Promise<void>;
  onCreate: (input: WorkspacePresetInput) => Promise<void>;
  onUpdate: (id: string, input: WorkspacePresetInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onApply: (preset: WorkspacePreset, connection: SavedConnection) => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(presets[0]?.id ?? null);
  const [targetId, setTargetId] = useState(currentConnectionId ?? connections[0]?.id ?? "");
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId || !presets.some((preset) => preset.id === selectedId)) {
      setSelectedId(presets[0]?.id ?? null);
    }
  }, [presets, selectedId]);

  const selected = presets.find((preset) => preset.id === selectedId) ?? null;
  const target = connections.find((connection) => connection.id === targetId) ?? null;
  const targetCapabilities = target ? (capabilities[target.id] ?? null) : null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function saveCurrent(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    void run(async () => {
      await onCreateFromCurrent(name);
      setNewName("");
    });
  }

  const unsupportedCount = useMemo(
    () =>
      selected?.views.filter(
        (descriptor) =>
          workspacePresetViewStatus(descriptor, targetCapabilities).supported === false,
      ).length ?? 0,
    [selected, targetCapabilities],
  );
  const hasApplicableView = selected?.views.some((view) =>
    isSupportedWorkspacePresetView(view.view),
  );

  return (
    <Modal title="Workspace Presets" onClose={onClose}>
      <div className="workspace-presets-dialog">
        <form className="preset-create" onSubmit={saveCurrent}>
          <label>
            <span>Preset name</span>
            <input
              aria-label="Preset name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              maxLength={80}
              placeholder="Web Server Troubleshooting"
              disabled={!currentConnectionId || !currentViewCount || busy}
            />
            <small>
              Saves {currentViewCount || "no"} current view{currentViewCount === 1 ? "" : "s"} for
              the active Saved Connection. Live sessions and results are excluded.
            </small>
          </label>
          <button
            className="secondary-button"
            type="submit"
            disabled={!newName.trim() || !currentConnectionId || !currentViewCount || busy}
          >
            <Plus size={14} /> Save current layout
          </button>
        </form>

        {error && <p className="inline-error">{error}</p>}

        <div className="preset-manager">
          <div className="preset-list" aria-label="Saved Workspace Presets">
            {presets.map((preset) => (
              <div
                className={preset.id === selectedId ? "preset-row selected" : "preset-row"}
                key={preset.id}
              >
                {editingId === preset.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = editName.trim();
                      if (!name) return;
                      void run(async () => {
                        await onUpdate(preset.id, {
                          name,
                          views: preset.views,
                          layout: preset.layout,
                        });
                        setEditingId(null);
                      });
                    }}
                  >
                    <input
                      aria-label={`Rename ${preset.name}`}
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      maxLength={80}
                      autoFocus
                    />
                    <button type="submit" disabled={!editName.trim() || busy}>
                      Save
                    </button>
                    <button type="button" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      className="preset-select"
                      type="button"
                      onClick={() => setSelectedId(preset.id)}
                    >
                      <LayoutTemplate size={15} />
                      <span>
                        <strong>{preset.name}</strong>
                        <small>{preset.views.length} views</small>
                      </span>
                    </button>
                    <div className="preset-row-actions">
                      <button
                        type="button"
                        aria-label={`Rename ${preset.name}`}
                        title="Rename"
                        onClick={() => {
                          setEditingId(preset.id);
                          setEditName(preset.name);
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Duplicate ${preset.name}`}
                        title="Duplicate"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            onCreate(
                              duplicateWorkspacePresetInput(
                                preset,
                                duplicateName(preset.name, presets),
                              ),
                            ),
                          )
                        }
                      >
                        <Copy size={13} />
                      </button>
                      <button
                        className={
                          deleteId === preset.id ? "danger-text confirm-delete" : "danger-text"
                        }
                        type="button"
                        aria-label={
                          deleteId === preset.id
                            ? `Confirm delete ${preset.name}`
                            : `Delete ${preset.name}`
                        }
                        title={deleteId === preset.id ? "Confirm delete" : "Delete"}
                        disabled={busy}
                        onClick={() => {
                          if (deleteId !== preset.id) {
                            setDeleteId(preset.id);
                            return;
                          }
                          void run(async () => {
                            await onDelete(preset.id);
                            setDeleteId(null);
                          });
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
            {!presets.length && <p className="preset-empty">No presets saved yet.</p>}
          </div>

          <section className="preset-preview" aria-label="Preset preview">
            {selected ? (
              <>
                <header>
                  <h3>{selected.name}</h3>
                  <span>Schema {selected.schemaVersion}</span>
                </header>
                <label>
                  <span>Apply to Saved Connection</span>
                  <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                    {connections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="preset-view-list">
                  {selected.views.map((descriptor) => {
                    const status = workspacePresetViewStatus(descriptor, targetCapabilities);
                    return (
                      <div className="preset-view-row" key={descriptor.key}>
                        <span
                          className={`preset-support preset-support-${status.supported === false ? "off" : status.supported === null ? "unknown" : "ok"}`}
                        />
                        <span>
                          <strong>
                            {descriptor.label || workspacePresetViewLabel(descriptor.view)}
                          </strong>
                          <small>
                            {workspacePresetViewLabel(descriptor.view)}
                            {selectorLabel(descriptor.selector)
                              ? ` · ${selectorLabel(descriptor.selector)}`
                              : ""}
                          </small>
                          <small>{status.detail}</small>
                        </span>
                      </div>
                    );
                  })}
                </div>
                {unsupportedCount > 0 && (
                  <p className="inline-warning">
                    {unsupportedCount} view{unsupportedCount === 1 ? " is" : "s are"} unsupported by
                    the latest known host capabilities. Other views can still open.
                  </p>
                )}
                <button
                  className="primary-button"
                  type="button"
                  disabled={!target || !hasApplicableView || busy}
                  onClick={() => target && onApply(selected, target)}
                >
                  Apply disconnected
                </button>
                <small className="preset-apply-note">
                  Applying opens disconnected Workspaces and performs no remote operations.
                </small>
              </>
            ) : (
              <p className="preset-empty">Select a preset to preview it.</p>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
