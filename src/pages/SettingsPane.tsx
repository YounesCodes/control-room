import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, RefreshCw, RotateCcw, Save } from "lucide-react";
import { FontCatalogPicker } from "../components/FontCatalogPicker";
import { LocalShellIcon } from "../components/LocalShellIcon";
import { StepSlider } from "../components/StepSlider";
import { api, errorMessage } from "../lib/api";
import {
  DEFAULT_HEADER_METRICS,
  HEADER_METRIC_LABELS,
  displayedHeaderMetrics,
} from "../lib/header-metrics";
import { offeredLocalShells } from "../lib/offered-local-shells";
import { settingsHaveChanges } from "../lib/settings-draft";
import type { AppSettings, EnvironmentInfo, LocalShellProfile } from "../types";
import type { ManualCheckResult } from "../hooks/use-app-updater";
import { Search } from "../components/MagnifierIcon";

const categories = [
  ["general", "General & Monitoring"],
  ["terminal", "Terminal"],
  ["logs", "Logs & History"],
  ["connections", "Connections & Permissions"],
  ["app", "App & Diagnostics"],
] as const;
type Category = (typeof categories)[number][0];
const sections = {
  metrics: [
    "general",
    "Host metrics",
    "header cpu ram gpu disk io uptime refresh polling interval monitoring",
  ],
  appearance: [
    "terminal",
    "Terminal appearance",
    "font family size colors ansi palette preview contrast",
  ],
  behavior: [
    "terminal",
    "Tabs & naming",
    "automatic current command process terminal names titles scrollback lines output history",
  ],
  shells: [
    "terminal",
    "Local terminal",
    "shell startup default offered powershell cmd git bash administrator elevated focus mode",
  ],
  logs: ["logs", "Logs and History", "default log tail enhanced command history ssh"],
  permissions: [
    "connections",
    "Elevated commands",
    "sudo permissions root passwordless structured operations",
  ],
  updates: ["app", "Control Room updates", "version automatic check download restart"],
  ssh: ["app", "SSH environment", "ssh.exe openssh config agent paths diagnostics"],
} satisfies Record<string, [Category, string, string]>;

const terminalTabs = [
  ["appearance", "Appearance"],
  ["behavior", "Tabs & naming"],
  ["shells", "Local shells"],
] as const;
type TerminalSection = (typeof terminalTabs)[number][0];

function SettingsSection({
  id,
  category,
  query,
  terminalSection,
  children,
  className = "",
}: {
  id: keyof typeof sections;
  category: Category;
  query: string;
  terminalSection: TerminalSection;
  children: ReactNode;
  className?: string;
}) {
  const [group, title, keywords] = sections[id];
  const context = categories.find(([key]) => key === group)![1];
  const matches = query
    ? query
        .split(/\s+/)
        .every((word) => `${context} ${title} ${keywords}`.toLowerCase().includes(word))
    : category === group && (group !== "terminal" || id === terminalSection);
  const fieldset = (
    <fieldset id={`settings-${id}`} className={className} hidden={!matches}>
      <legend>{title}</legend>
      {query && <small className="settings-result-category">{context}</small>}
      {children}
    </fieldset>
  );
  return group === "terminal" ? (
    <div
      className="settings-terminal-panel"
      id={`settings-panel-${id}`}
      role={!query && category === "terminal" ? "tabpanel" : undefined}
      aria-labelledby={!query && category === "terminal" ? `settings-tab-${id}` : undefined}
      hidden={!matches}
    >
      {fieldset}
    </div>
  ) : (
    fieldset
  );
}

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
    localTerminalMode: settings.localTerminalMode ?? false,
    defaultLocalShellId: settings.defaultLocalShellId || null,
  }));
  const savedSettings = useRef(settings);
  savedSettings.current = settings;
  const [saving, setSaving] = useState(false);
  const [fontBusy, setFontBusy] = useState(false);
  const [previewFont, setPreviewFont] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<ManualCheckResult | null>(null);
  const [category, setCategory] = useState<Category>("general");
  const [terminalSection, setTerminalSection] = useState<TerminalSection>("appearance");
  const [search, setSearch] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const view = `${category}:${category === "terminal" ? terminalSection : ""}`;
  const previousView = useRef(view);
  const categoryScrollFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (categoryScrollFrame.current !== null) cancelAnimationFrame(categoryScrollFrame.current);
    },
    [],
  );

  function selectTerminalSection(next: TerminalSection) {
    if (categoryScrollFrame.current !== null) {
      cancelAnimationFrame(categoryScrollFrame.current);
      categoryScrollFrame.current = null;
    }
    setTerminalSection(next);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }
  useLayoutEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    const form = formRef.current;
    if (!form?.animate) return;
    const styles = getComputedStyle(document.documentElement);
    const time = /^(\d*\.?\d+)(ms|s)$/.exec(styles.getPropertyValue("--motion-med").trim());
    const animation = form.animate(
      [
        { opacity: 0.7, transform: "translateY(4px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      {
        duration: time ? Number(time[1]) * (time[2] === "s" ? 1000 : 1) : 180,
        easing: styles.getPropertyValue("--ease").trim() || "ease-out",
      },
    );
    return () => animation.cancel();
  }, [view]);
  const positions = useRef<Partial<Record<Category, number>>>({});
  const query = search.trim().toLowerCase();
  const sectionProps = { category, query, terminalSection };
  const hasResults = Object.values(sections).some(([group, title, keywords]) => {
    const context = categories.find(([key]) => key === group)![1];
    return query
      .split(/\s+/)
      .every((word) => `${context} ${title} ${keywords}`.toLowerCase().includes(word));
  });
  function navigate(next: Category) {
    if (bodyRef.current && !query) positions.current[category] = bodyRef.current.scrollTop;
    setSearch("");
    setCategory(next);
    if (categoryScrollFrame.current !== null) cancelAnimationFrame(categoryScrollFrame.current);
    categoryScrollFrame.current = requestAnimationFrame(() => {
      categoryScrollFrame.current = null;
      if (bodyRef.current) bodyRef.current.scrollTop = positions.current[next] ?? 0;
    });
  }

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
        <LocalShellIcon kind={shell.kind} elevated={shell.elevated} />
        {shell.label}
      </label>
    );
  }

  const enabledStandardProfiles = offeredLocalShells(localShells, hiddenIds).filter(
    (shell) => !shell.elevated,
  );
  const defaultProfile = draft.defaultLocalShellId
    ? enabledStandardProfiles.find((shell) => shell.id === draft.defaultLocalShellId)
    : enabledStandardProfiles[0];

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
            disabled={fontBusy || saving}
            onClick={() => onClose()}
            aria-label="Close Settings"
          >
            <ArrowLeft size={17} />
          </button>
          <div className="settings-heading-text">
            <h2>Settings</h2>
          </div>
          <div className="search-field settings-search">
            <Search size={15} />
            <input
              type="search"
              aria-label="Search settings"
              placeholder="Search settings"
              value={search}
              disabled={fontBusy || saving}
              onChange={(event) => {
                setSearch(event.target.value);
                if (bodyRef.current) bodyRef.current.scrollTop = 0;
              }}
            />
          </div>
          <div className="settings-heading-actions">
            <p
              className={
                message
                  ? saveFailed
                    ? "settings-status failed"
                    : "settings-status saved"
                  : "settings-status"
              }
              role={message ? "status" : undefined}
            >
              {message ?? (dirty ? "Unsaved changes" : "")}
            </p>
            {/* Outside the form it submits, which is what keeps it on screen
                while the form itself scrolls. */}
            <button
              className="primary-button settings-save"
              type="submit"
              form="settings-form"
              disabled={saving || fontBusy || !dirty}
            >
              <Save size={15} /> {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </div>
      </header>
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Settings categories">
          {categories.map(([id, label], index) => (
            <button
              key={id}
              type="button"
              aria-current={!query && category === id ? "page" : undefined}
              tabIndex={category === id ? 0 : -1}
              disabled={fontBusy || saving}
              onClick={() => navigate(id)}
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                const next =
                  event.key === "ArrowDown"
                    ? Math.min(index + 1, categories.length - 1)
                    : event.key === "ArrowUp"
                      ? Math.max(index - 1, 0)
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? categories.length - 1
                          : null;
                if (next === null) return;
                event.preventDefault();
                const button =
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[
                    next
                  ];
                if (!button || button.disabled) return;
                button.focus();
                navigate(categories[next][0]);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <label className="settings-category-select">
          <span className="sr-only">Settings category</span>
          <select
            value={category}
            disabled={fontBusy || saving}
            onChange={(event) => navigate(event.target.value as Category)}
          >
            {categories.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="settings-content">
          {category === "terminal" && !query && (
            <div className="settings-subnavigation" role="tablist" aria-label="Terminal settings">
              {terminalTabs.map(([id, label], index) => (
                <button
                  key={id}
                  id={`settings-tab-${id}`}
                  type="button"
                  role="tab"
                  aria-selected={terminalSection === id}
                  tabIndex={terminalSection === id ? 0 : -1}
                  disabled={fontBusy || saving}
                  aria-controls={`settings-panel-${id}`}
                  onClick={() => selectTerminalSection(id)}
                  onKeyDown={(event) => {
                    if (event.altKey || event.ctrlKey || event.metaKey) return;
                    const next =
                      event.key === "ArrowRight"
                        ? (index + 1) % terminalTabs.length
                        : event.key === "ArrowLeft"
                          ? (index + terminalTabs.length - 1) % terminalTabs.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? terminalTabs.length - 1
                              : null;
                    if (next === null) return;
                    event.preventDefault();
                    const buttons =
                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                        "button",
                      );
                    buttons?.[next]?.focus();
                    selectTerminalSection(terminalTabs[next][0]);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="settings-body" ref={bodyRef}>
            {query && !hasResults && (
              <p className="settings-empty" role="status">
                No settings match "{search.trim()}".
              </p>
            )}
            <form
              ref={formRef}
              id="settings-form"
              className="settings-form"
              data-category={query ? undefined : category}
              onSubmit={submit}
              onInvalid={(event) => {
                const input = event.target as HTMLInputElement;
                const section = input
                  .closest<HTMLElement>("fieldset[id]")
                  ?.id.replace("settings-", "") as keyof typeof sections | undefined;
                if (section) {
                  setSearch("");
                  setCategory(sections[section][0]);
                  if (section === "appearance" || section === "behavior" || section === "shells") {
                    selectTerminalSection(section);
                  }
                  requestAnimationFrame(() => input.focus());
                }
              }}
            >
              <SettingsSection id="metrics" {...sectionProps} className="host-metrics-settings">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={draft.hostMetricsEnabled ?? false}
                    onChange={(event) =>
                      setDraft({ ...draft, hostMetricsEnabled: event.target.checked })
                    }
                  />
                  Show host metrics in header
                </label>
                <fieldset className="host-metrics-options" disabled={!draft.hostMetricsEnabled}>
                  <legend>Displayed metrics</legend>
                  <div className="host-metrics-choices">
                    {DEFAULT_HEADER_METRICS.map((metric) => (
                      <label className="checkbox-label" key={metric}>
                        <input
                          type="checkbox"
                          checked={(draft.hostMetrics ?? DEFAULT_HEADER_METRICS).includes(metric)}
                          onChange={(event) => {
                            const selected = new Set(draft.hostMetrics ?? DEFAULT_HEADER_METRICS);
                            if (event.target.checked) selected.add(metric);
                            else selected.delete(metric);
                            setDraft({
                              ...draft,
                              hostMetrics: DEFAULT_HEADER_METRICS.filter((value) =>
                                selected.has(value),
                              ),
                            });
                          }}
                        />
                        {HEADER_METRIC_LABELS[metric]}
                      </label>
                    ))}
                  </div>
                  <StepSlider
                    className="host-metrics-refresh"
                    label="Host metrics refresh interval"
                    unit="seconds"
                    options={[2, 5, 10, 30]}
                    value={draft.hostMetricsIntervalSeconds ?? 5}
                    format={(seconds) => `Every ${seconds} seconds`}
                    onChange={(seconds) =>
                      setDraft({ ...draft, hostMetricsIntervalSeconds: seconds })
                    }
                  />
                </fieldset>
                <small>Monitoring pauses while Settings is open or the window is hidden.</small>
                {draft.hostMetricsEnabled &&
                  displayedHeaderMetrics(draft.hostMetrics).length === 0 && (
                    <small>Select a metric to display the header.</small>
                  )}
              </SettingsSection>
              <SettingsSection id="appearance" {...sectionProps}>
                <div className="terminal-appearance-layout">
                  <div className="terminal-appearance-controls">
                    <FontCatalogPicker
                      value={draft.terminalFontFamily}
                      onChange={(terminalFontFamily) =>
                        setDraft((current) => ({ ...current, terminalFontFamily }))
                      }
                      disabled={saving}
                      onBusyChange={setFontBusy}
                      onPreview={setPreviewFont}
                      onUse={async (family) => {
                        const updated = {
                          ...savedSettings.current,
                          terminalFontFamily: `"${family}", Cascadia Mono, Consolas, monospace`,
                        };
                        await api.saveSettings(updated);
                        onSaved(updated);
                        setDraft((current) => ({
                          ...current,
                          terminalFontFamily: updated.terminalFontFamily,
                        }));
                      }}
                    />
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
                    <div className="terminal-color-heading">
                      <div>
                        <strong>Terminal colors</strong>
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
                  </div>
                  <div className="terminal-appearance-preview">
                    <strong>Live preview</strong>
                    <div
                      className="ansi-preview"
                      style={{
                        color: draft.terminalForeground,
                        fontFamily: previewFont ?? draft.terminalFontFamily,
                        fontSize: draft.terminalFontSize,
                      }}
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
                  </div>
                </div>
              </SettingsSection>
              <SettingsSection id="behavior" {...sectionProps}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={draft.automaticTerminalTitles ?? true}
                    onChange={(event) =>
                      setDraft({ ...draft, automaticTerminalTitles: event.target.checked })
                    }
                  />
                  Show current command/process in terminal tab titles
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
              </SettingsSection>
              <SettingsSection id="shells" {...sectionProps}>
                <div className="local-terminal-mode-option">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={draft.localTerminalMode}
                      onChange={(event) =>
                        setDraft({ ...draft, localTerminalMode: event.target.checked })
                      }
                    />
                    Local Terminal Mode
                  </label>
                  <small>Start the default local terminal in Focus Mode on launch.</small>
                </div>
                <label>
                  <span>Default local terminal</span>
                  <div className="local-shell-default">
                    {defaultProfile && <LocalShellIcon kind={defaultProfile.kind} />}
                    <select
                      value={draft.defaultLocalShellId ?? ""}
                      onChange={(event) =>
                        setDraft({ ...draft, defaultLocalShellId: event.target.value || null })
                      }
                    >
                      <option value="">First enabled terminal</option>
                      {draft.defaultLocalShellId &&
                        !enabledStandardProfiles.some(
                          (shell) => shell.id === draft.defaultLocalShellId,
                        ) && (
                          <option value={draft.defaultLocalShellId} disabled>
                            Saved terminal unavailable or disabled
                          </option>
                        )}
                      {enabledStandardProfiles.map((shell) => (
                        <option key={shell.id} value={shell.id}>
                          {shell.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
                {localShells.length === 0 ? (
                  <small>No local shells are installed on this machine.</small>
                ) : (
                  <>
                    <div className="local-shell-toggle-group">
                      <div className="local-shell-toggle-heading">
                        <strong>Local terminals</strong>
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
              </SettingsSection>
              <SettingsSection id="logs" {...sectionProps}>
                <StepSlider
                  label="Default log tail"
                  unit="lines"
                  options={logTailOptions}
                  value={draft.defaultLogTail}
                  format={(count) => `${count} lines`}
                  onChange={(count) => setDraft({ ...draft, defaultLogTail: count })}
                />
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
              </SettingsSection>
              <SettingsSection id="permissions" {...sectionProps}>
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
                  wherever the account has passwordless sudo, and run unelevated everywhere else.
                  This overrides the per-connection setting while it is on. Control Room never
                  stores a sudo password, and elevation never turns a read into a change.
                </small>
              </SettingsSection>
              <SettingsSection id="updates" {...sectionProps}>
                {/* Control Room updating itself. Named "Control Room updates" rather
                than "Updates" so it can never be read as updating packages on a
                Remote Host, which Control Room does not do. */}
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
                          <span className="settings-update-reason">
                            {checkResult.failure.message}
                          </span>
                        </>
                      )}
                    </p>
                  )}
                </div>
              </SettingsSection>
              <SettingsSection id="ssh" {...sectionProps}>
                <dl className="detail-list settings-ssh">
                  <div>
                    <dt>ssh.exe</dt>
                    {environment.sshPath ? (
                      <dd className="technical">{environment.sshPath}</dd>
                    ) : (
                      <dd>
                        <span className="settings-ssh-state">
                          <span className="status-dot status-error" aria-hidden="true" />
                          Not detected
                        </span>
                      </dd>
                    )}
                  </div>
                  <div>
                    <dt>OpenSSH config</dt>
                    <dd className="technical">{environment.sshConfigPath}</dd>
                  </div>
                  <div>
                    <dt>ssh-agent</dt>
                    <dd>
                      <span className="settings-ssh-state">
                        <span
                          className={`status-dot${environment.sshAgentAvailable ? " status-connected" : ""}`}
                          aria-hidden="true"
                        />
                        {environment.sshAgentAvailable ? "Identity loaded" : "No identity loaded"}
                      </span>
                      {!environment.sshAgentAvailable && (
                        <span className="settings-ssh-hint">
                          The agent may be stopped or holding no keys. Check with{" "}
                          <code>ssh-add -l</code> in a terminal.
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>
              </SettingsSection>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}
