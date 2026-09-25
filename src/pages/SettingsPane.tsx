import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, RefreshCw, RotateCcw, Save } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { settingsHaveChanges } from "../lib/settings-draft";
import type { AppSettings, EnvironmentInfo, LocalShellProfile } from "../types";
import type { ManualCheckResult } from "../hooks/use-app-updater";
import { contrastRatio } from "../lib/color-contrast";
import { TERMINAL_BACKGROUND } from "../lib/terminal-theme";

const terminalAnsiColors = [
  ["terminalRed", "ANSI 1", "Errors"],
  ["terminalGreen", "ANSI 2", "Prompts"],
  ["terminalYellow", "ANSI 3", "Warnings"],
  ["terminalBlue", "ANSI 4", "Directories"],
  ["terminalMagenta", "ANSI 5", "Highlights"],
  ["terminalCyan", "ANSI 6", "Symlinks"],
] as const;
const terminalColorFields = [
  ["terminalForeground", "Default text and cursor", ""],
  ...terminalAnsiColors,
] as const;
type TerminalColorField = (typeof terminalColorFields)[number][0];

function TerminalColorPicker({
  label,
  descriptionId,
  value,
  onCommit,
}: {
  label: string;
  descriptionId?: string;
  value: string;
  onCommit: (color: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // React's onChange receives the picker's live input events in WebView2. A
  // Settings render during that native popup dismisses it, so commit only on
  // the native change event sent when the picker closes.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const commit = () => onCommit(input.value);
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, [onCommit]);

  // defaultValue leaves the picker alone while it is open. Reset colors still
  // needs to sync a new saved value into that same stable input element.
  useEffect(() => {
    if (inputRef.current && inputRef.current.value !== value) inputRef.current.value = value;
  }, [value]);

  return (
    <input
      ref={inputRef}
      type="color"
      defaultValue={value}
      aria-label={label}
      aria-describedby={descriptionId}
    />
  );
}

export function SettingsPane({
  settings,
  defaults,
  logTailOptions,
  localShells,
  environment,
  appVersion,
  onCheckForUpdates,
  onSaved,
  onClose,
  onDirtyChange,
}: {
  settings: AppSettings;
  defaults: AppSettings;
  logTailOptions: number[];
  /** Every local shell this machine has, the hidden ones included: Settings is
   *  where they are turned back on, so it cannot be handed a filtered list. */
  localShells: LocalShellProfile[];
  environment: EnvironmentInfo;
  /** The running version, read from Tauri package metadata rather than any
   *  constant in this file. */
  appVersion: string | null;
  /** Runs through the application's single update lifecycle, so a manual check
   *  and the automatic one can never both be in flight. */
  onCheckForUpdates: () => Promise<ManualCheckResult>;
  onSaved: (settings: AppSettings) => void;
  onClose: () => boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  /* The list is read from whatever settings the backend sent. An older payload
     simply has no such key, and Settings has to open on it rather than take the
     whole window down: absent means nothing is hidden, same as in Rust. */
  const [draft, setDraft] = useState<AppSettings>(() => ({
    ...settings,
    hiddenLocalShells: settings.hiddenLocalShells ?? [],
  }));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<ManualCheckResult | null>(null);
  const lowContrastColors = terminalColorFields
    .filter(([field]) => contrastRatio(draft[field], TERMINAL_BACKGROUND) < 4.5)
    .map(([, label]) => label);

  /* Manual checks stay available with the automatic preference off: turning the
     schedule off is not the same as refusing to look. */
  async function runManualCheck() {
    setChecking(true);
    setCheckResult(null);
    try {
      setCheckResult(await onCheckForUpdates());
    } finally {
      setChecking(false);
    }
  }

  const dirty = settingsHaveChanges(settings, draft);

  const standardProfiles = localShells.filter((shell) => !shell.elevated);
  const administratorProfiles = localShells.filter((shell) => shell.elevated);
  const hiddenIds = draft.hiddenLocalShells;
  const hiddenCount = localShells.filter((shell) => hiddenIds.includes(shell.id)).length;

  function setColor(field: TerminalColorField, color: string) {
    setDraft((current) => ({ ...current, [field]: color.toLowerCase() }));
  }

  /* One row per profile, in the same two groups the launchers use, so the
     setting and the menu it controls read as the same list. */
  function setOffered(shell: LocalShellProfile, offered: boolean) {
    const remaining = hiddenIds.filter((id) => id !== shell.id);
    setDraft({
      ...draft,
      hiddenLocalShells: offered ? remaining : [...remaining, shell.id],
    });
  }

  function toggleRow(shell: LocalShellProfile) {
    return (
      <label className="checkbox-label" key={shell.id}>
        <input
          type="checkbox"
          checked={!hiddenIds.includes(shell.id)}
          onChange={(event) => setOffered(shell, event.target.checked)}
          aria-label={
            shell.elevated ? `Offer ${shell.label}, run as administrator` : `Offer ${shell.label}`
          }
        />
        {shell.label}
      </label>
    );
  }

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // A save result describes the draft that was saved. Editing again makes it
  // stale, so it clears on the next change rather than sitting next to the
  // button describing an older state.
  useEffect(() => {
    setMessage(null);
    setSaveFailed(false);
  }, [draft]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setSaveFailed(false);
    try {
      await api.saveSettings(draft);
      onSaved(draft);
      onDirtyChange(false);
      setMessage("Settings saved.");
    } catch (caught) {
      setMessage(errorMessage(caught));
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="feature-page settings-page">
      <header className="settings-heading">
        <div className="settings-heading-inner">
          <button
            className="icon-button settings-back"
            type="button"
            onClick={() => onClose()}
            aria-label="Close Settings"
            title="Close Settings"
          >
            <ArrowLeft size={17} />
          </button>
          <div className="settings-heading-text">
            <h2>Settings</h2>
            <p>Terminal, logs, local shells, SSH access, and Control Room updates.</p>
          </div>
          <div className="settings-heading-actions">
            {message ? (
              <p
                className={saveFailed ? "settings-status failed" : "settings-status saved"}
                role="status"
              >
                {message}
              </p>
            ) : (
              dirty && <span className="settings-status">Unsaved changes</span>
            )}
            {/* Outside the form it submits, which is what keeps it on screen
                while the form itself scrolls. */}
            <button
              className="primary-button settings-save"
              type="submit"
              form="settings-form"
              disabled={saving || !dirty}
            >
              <Save size={15} /> {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </div>
      </header>
      <div className="settings-body">
        <form id="settings-form" className="settings-form" onSubmit={submit}>
          <fieldset>
            <legend>Terminal</legend>
            <label>
              <span>Font family</span>
              <input
                value={draft.terminalFontFamily}
                onChange={(event) => setDraft({ ...draft, terminalFontFamily: event.target.value })}
              />
            </label>
            <div className="form-row">
              <label>
                <span>Font size</span>
                <input
                  type="number"
                  min="9"
                  max="32"
                  value={draft.terminalFontSize}
                  onChange={(event) =>
                    setDraft({ ...draft, terminalFontSize: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                <span>Scrollback lines</span>
                <input
                  type="number"
                  min="100"
                  max="100000"
                  value={draft.terminalScrollback}
                  onChange={(event) =>
                    setDraft({ ...draft, terminalScrollback: Number(event.target.value) })
                  }
                />
              </label>
            </div>
            <small>
              A right click copies the selected text, or pastes the clipboard when nothing is
              selected. While a program is reading the mouse, such as Vim or top, the click goes to
              that program instead. Ctrl+Shift+C and Ctrl+Shift+V work everywhere.
            </small>
            <div className="terminal-color-heading">
              <div>
                <strong>Terminal colors</strong>
                <small>Programs choose how to use each ANSI slot.</small>
              </div>
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => {
                  setDraft({
                    ...draft,
                    terminalForeground: defaults.terminalForeground,
                    terminalRed: defaults.terminalRed,
                    terminalGreen: defaults.terminalGreen,
                    terminalYellow: defaults.terminalYellow,
                    terminalBlue: defaults.terminalBlue,
                    terminalMagenta: defaults.terminalMagenta,
                    terminalCyan: defaults.terminalCyan,
                  });
                }}
              >
                <RotateCcw size={13} /> Reset colors
              </button>
            </div>
            <div
              className="ansi-preview"
              style={{ color: draft.terminalForeground }}
              aria-hidden="true"
            >
              <div>
                <span style={{ color: draft.terminalGreen }}>user@host:~$</span> echo sample
              </div>
              <div>sample</div>
              <div className="ansi-preview-slots">
                {terminalAnsiColors.map(([field, label]) => (
                  <span key={field} style={{ color: draft[field] }}>
                    {label}
                  </span>
                ))}
              </div>
            </div>
            <div className="terminal-color-grid">
              {terminalColorFields.map(([field, label, example]) => (
                <label className="terminal-color-control" key={field}>
                  <TerminalColorPicker
                    label={label}
                    descriptionId={example ? `${field}-example` : undefined}
                    value={draft[field]}
                    onCommit={(color) => setColor(field, color)}
                  />
                  <span>{label}</span>
                  {example && (
                    <small className="terminal-color-example" id={`${field}-example`}>
                      {example}
                    </small>
                  )}
                </label>
              ))}
            </div>
            {lowContrastColors.length > 0 && (
              <p className="inline-warning terminal-color-warning" role="status">
                Hard to read on the terminal background: {lowContrastColors.join(", ")}. Choose a
                brighter color or reset the colors.
              </p>
            )}
          </fieldset>
          <fieldset>
            <legend>Local terminal</legend>
            <small>
              Choose which shells the Local terminal button, New terminal, and Split menus offer.
              Turning one off hides it from those menus only: the shell stays installed, a Workspace
              already running it keeps going, and turning it back on brings it back.
            </small>
            {localShells.length === 0 ? (
              <small>No local shells are installed on this machine.</small>
            ) : (
              <>
                <div className="local-shell-toggle-group">
                  <div className="local-shell-toggle-heading">
                    <strong>Local terminals</strong>
                    {hiddenCount > 0 && (
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        onClick={() => setDraft({ ...draft, hiddenLocalShells: [] })}
                      >
                        <RotateCcw size={13} /> Show all
                      </button>
                    )}
                  </div>
                  {standardProfiles.map(toggleRow)}
                </div>
                {administratorProfiles.length > 0 && (
                  <div className="local-shell-toggle-group">
                    <div className="local-shell-toggle-heading">
                      <strong>Run as administrator</strong>
                    </div>
                    {administratorProfiles.map(toggleRow)}
                  </div>
                )}
              </>
            )}
          </fieldset>
          <fieldset>
            <legend>Logs and History</legend>
            <label>
              <span>Default log tail</span>
              <select
                value={draft.defaultLogTail}
                onChange={(event) =>
                  setDraft({ ...draft, defaultLogTail: Number(event.target.value) })
                }
              >
                {logTailOptions.map((count) => (
                  <option key={count}>{count}</option>
                ))}
              </select>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.globalHistoryEnabled}
                onChange={(event) =>
                  setDraft({ ...draft, globalHistoryEnabled: event.target.checked })
                }
              />{" "}
              Enable Enhanced History globally
            </label>
          </fieldset>
          <fieldset>
            <legend>Elevated commands</legend>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.globalSudoEnabled}
                onChange={(event) =>
                  setDraft({ ...draft, globalSudoEnabled: event.target.checked })
                }
              />{" "}
              Allow sudo for Structured Operations on every Saved Connection
            </label>
            <small>
              Reads that need root, such as socket ownership and firewall policy, run under sudo
              wherever the account has passwordless sudo, and run unelevated everywhere else. This
              overrides the per-connection setting while it is on. Control Room never stores a sudo
              password, and elevation never turns a read into a change.
            </small>
          </fieldset>
          <fieldset>
            {/* Control Room updating itself. Named "Control Room updates" rather
                than "Updates" so it can never be read as updating packages on a
                Remote Host, which Control Room does not do. */}
            <legend>Control Room updates</legend>
            <dl className="detail-list settings-version">
              <div>
                <dt>Current version</dt>
                <dd>{appVersion ? `v${appVersion}` : "Unknown"}</dd>
              </div>
            </dl>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.automaticUpdateChecks}
                onChange={(event) =>
                  setDraft({ ...draft, automaticUpdateChecks: event.target.checked })
                }
              />{" "}
              Automatically check for updates
            </label>
            <small>
              Checks GitHub Releases shortly after Control Room starts, then periodically while it
              stays open and when you return to it after being away. Update packages are
              cryptographically signed and verified before anything is installed. This updates
              Control Room on this Windows machine only, and never a Remote Host.
            </small>
            <div className="settings-update-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => void runManualCheck()}
                disabled={checking}
              >
                <RefreshCw size={14} /> {checking ? "Checking…" : "Check for updates"}
              </button>
              {checkResult && (
                <p
                  className={
                    checkResult.outcome === "failed"
                      ? "settings-update-status failed"
                      : "settings-update-status"
                  }
                  role="status"
                >
                  {checkResult.outcome === "current" && "You're up to date."}
                  {checkResult.outcome === "available" &&
                    `Version ${checkResult.version} is available.`}
                  {checkResult.outcome === "failed" && (
                    <>
                      Could not check for updates.
                      <span className="settings-update-reason">{checkResult.failure.message}</span>
                    </>
                  )}
                </p>
              )}
            </div>
          </fieldset>
          <fieldset>
            <legend>SSH environment</legend>
            <dl className="detail-list">
              <div>
                <dt>ssh.exe</dt>
                <dd className="technical">{environment.sshPath ?? "Not detected"}</dd>
              </div>
              <div>
                <dt>OpenSSH config</dt>
                <dd className="technical">{environment.sshConfigPath}</dd>
              </div>
              <div>
                <dt>ssh-agent</dt>
                <dd>
                  {environment.sshAgentAvailable
                    ? "Available, identity loaded"
                    : "No identity available. ssh-agent may be stopped or have no loaded identities; run ssh-add -l outside Control Room to check."}
                </dd>
              </div>
            </dl>
          </fieldset>
        </form>
      </div>
    </section>
  );
}
