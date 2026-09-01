import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, RotateCcw, Save } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { settingsHaveChanges } from "../lib/settings-draft";
import type { AppSettings, EnvironmentInfo } from "../types";

const terminalColorFields = [
  ["terminalForeground", "Text and cursor"],
  ["terminalGreen", "Green and prompts"],
  ["terminalBlue", "Blue and directories"],
  ["terminalCyan", "Cyan"],
  ["terminalYellow", "Yellow"],
  ["terminalMagenta", "Magenta"],
  ["terminalRed", "Red and errors"],
] as const;

export function SettingsPane({
  settings,
  defaults,
  logTailOptions,
  environment,
  onSaved,
  onClose,
  onDirtyChange,
}: {
  settings: AppSettings;
  defaults: AppSettings;
  logTailOptions: number[];
  environment: EnvironmentInfo;
  onSaved: (settings: AppSettings) => void;
  onClose: () => boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    onDirtyChange(settingsHaveChanges(settings, draft));
  }, [draft, onDirtyChange, settings]);

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
      <header className="page-heading">
        <div>
          <h2>Settings</h2>
          <p>Terminal, log, and local History preferences.</p>
        </div>
        <button
          className="secondary-button settings-back"
          type="button"
          onClick={() => onClose()}
          aria-label="Back to terminal"
        >
          <ArrowLeft size={14} /> Back to terminal
        </button>
      </header>
      <form className="settings-form" onSubmit={submit}>
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
          <div className="terminal-color-heading">
            <div>
              <strong>ANSI colors</strong>
              <small>
                Remote prompts and tools choose the category. These settings choose its color.
              </small>
            </div>
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() =>
                setDraft({
                  ...draft,
                  terminalForeground: defaults.terminalForeground,
                  terminalRed: defaults.terminalRed,
                  terminalGreen: defaults.terminalGreen,
                  terminalYellow: defaults.terminalYellow,
                  terminalBlue: defaults.terminalBlue,
                  terminalMagenta: defaults.terminalMagenta,
                  terminalCyan: defaults.terminalCyan,
                })
              }
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
              <span style={{ color: draft.terminalGreen, fontWeight: 700 }}>agent@ubuntu</span>:
              <span style={{ color: draft.terminalBlue, fontWeight: 700 }}>~</span>$ ls -la /
            </div>
            <div>
              <span style={{ color: draft.terminalCyan, fontWeight: 700 }}>bin</span> -&gt;{" "}
              <span style={{ color: draft.terminalBlue, fontWeight: 700 }}>usr/bin</span>
              {"   "}
              <span style={{ color: draft.terminalBlue, fontWeight: 700 }}>boot</span>
              {"   "}
              <span style={{ color: draft.terminalBlue, fontWeight: 700 }}>etc</span>
              {"   "}fstab
            </div>
            <div>
              <span style={{ color: draft.terminalYellow, fontWeight: 700 }}>warning:</span> low
              disk space {"  ·  "}
              <span style={{ color: draft.terminalMagenta, fontWeight: 700 }}>note:</span> using
              defaults
            </div>
            <div>
              <span style={{ color: draft.terminalRed, fontWeight: 700 }}>error:</span> permission
              denied
            </div>
          </div>
          <div className="terminal-color-grid">
            {terminalColorFields.map(([field, label]) => (
              <label className="terminal-color-control" key={field}>
                <input
                  type="color"
                  value={draft[field]}
                  onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                  aria-label={label}
                />
                <span>{label}</span>
                <code>{draft[field]}</code>
              </label>
            ))}
          </div>
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
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.terminalContextActionsEnabled}
              onChange={(event) =>
                setDraft({ ...draft, terminalContextActionsEnabled: event.target.checked })
              }
            />{" "}
            Offer inspection actions for the object in the last reported command
          </label>
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
                  ? "Available with loaded identities"
                  : "Unavailable or no loaded identities"}
              </dd>
            </div>
          </dl>
        </fieldset>
        {message && (
          <p className={saveFailed ? "inline-error" : "inline-message"} role="status">
            {message}
          </p>
        )}
        <button className="primary-button settings-save" type="submit" disabled={saving}>
          <Save size={15} /> {saving ? "Saving…" : "Save settings"}
        </button>
      </form>
    </section>
  );
}
