import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { ChevronDown } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import type { CatalogFont, FontCatalog, FontProgress } from "../types";

export function FontCatalogPicker({
  value,
  onChange,
  disabled = false,
  onPreview,
  onBusyChange,
  onUse,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  onPreview: (family: string | null) => void;
  onBusyChange: (busy: boolean) => void;
  onUse: (family: string) => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<FontCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [picked, setPicked] = useState<CatalogFont | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [faces, setFaces] = useState<Record<string, string>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<FontProgress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);
  const loaded = useRef(new Map<string, FontFace>());
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  const running = useRef(false);
  const installed = useRef<{ id: string; family: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const catalogRequest = useRef(false);
  const matching = (catalog?.fonts ?? [])
    .filter((font) => font.family.toLowerCase().includes((query ?? "").trim().toLowerCase()))
    .slice(0, 8);
  const results = open ? matching : [];
  const active = picked ?? results.find((font) => font.id === selected) ?? results[0];
  const resultIds = results.map((font) => font.id).join(",");

  function cancelPreview() {
    setOpen(false);
    setQuery(null);
    setPicked(null);
    setSelected(null);
    setFailure(null);
  }

  function choose(font: CatalogFont) {
    void loadPreview(font);
    setPicked(font);
    setQuery(font.family);
    setOpen(false);
    setSelected(null);
    setFailure(null);
    setReady(null);
  }

  function keepTypedValue() {
    if (query === null || !query.trim()) return;
    onChange(query.trim());
    cancelPreview();
    setReady(null);
  }

  useEffect(() => {
    alive.current = true;
    const fonts = loaded.current;
    return () => {
      alive.current = false;
      for (const face of fonts.values()) document.fonts.delete(face);
      fonts.clear();
    };
  }, []);

  async function loadCatalog() {
    if (catalogRequest.current) return;
    catalogRequest.current = true;
    setLoading(true);
    setCatalogError(null);
    try {
      const response = await api.listCatalogFonts();
      if (alive.current) setCatalog(response);
    } catch (error) {
      if (alive.current) setCatalogError(errorMessage(error));
    } finally {
      catalogRequest.current = false;
      if (alive.current) setLoading(false);
    }
  }

  async function loadPreview(font: CatalogFont) {
    if (loaded.current.has(font.id) || pending.current.has(font.id)) return;
    pending.current.add(font.id);
    try {
      const bytes = await api.previewCatalogFont(font.id);
      const alias = `ControlRoomPreview-${font.id}`;
      const face = await new FontFace(alias, bytes).load();
      if (!alive.current) return;
      document.fonts.add(face);
      loaded.current.set(font.id, face);
      setFaces((current) => ({ ...current, [font.id]: alias }));
      setPreviewErrors((current) => ({ ...current, [font.id]: "" }));
    } catch (error) {
      if (alive.current)
        setPreviewErrors((current) => ({ ...current, [font.id]: errorMessage(error) }));
    } finally {
      pending.current.delete(font.id);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const id of resultIds.split(",").filter(Boolean)) {
        const font = catalog?.fonts.find((item) => item.id === id);
        if (font) void loadPreview(font);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [resultIds, catalog]);

  const activeFace = active ? faces[active.id] : null;
  useEffect(() => {
    if (open && selected)
      document.getElementById(`font-option-${selected}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, selected]);
  useEffect(() => {
    onPreview(activeFace ? `"${activeFace}", monospace` : null);
  }, [activeFace, onPreview]);

  async function install() {
    if (!active || running.current) return;
    choose(active);
    running.current = true;
    setBusy(true);
    onBusyChange(true);
    setFailure(null);
    setReady(null);
    setProgress({ stage: "downloadingRegular", completed: 0, total: null });
    let installedFace: FontFace | null = null;
    try {
      const channel = new Channel<FontProgress>();
      channel.onmessage = (value) => {
        if (alive.current) setProgress(value);
      };
      let family = installed.current?.id === active.id ? installed.current.family : null;
      if (!family) {
        family = await api.installCatalogFont(active.id, channel);
        installed.current = { id: active.id, family };
      }
      if (!alive.current) return;
      // Reuse bytes cached by the successful Windows installer so the new
      // family renders immediately while the system font cache refreshes.
      const bytes = await api.previewCatalogFont(active.id);
      installedFace = await new FontFace(family, bytes).load();
      if (!alive.current) return;
      const key = "installed:" + active.id;
      const previous = loaded.current.get(key);
      if (previous) document.fonts.delete(previous);
      document.fonts.add(installedFace);
      loaded.current.set(key, installedFace);
      await onUse(family);
      if (alive.current) {
        setReady(
          `${family} is installed and selected for your terminals. If the new font is not visible yet, restart Control Room.`,
        );
        setOpen(false);
        setQuery(null);
        setPicked(null);
      }
    } catch (error) {
      if (installedFace) {
        document.fonts.delete(installedFace);
        loaded.current.delete("installed:" + active.id);
      }
      if (alive.current) setFailure(errorMessage(error));
    } finally {
      running.current = false;
      onBusyChange(false);
      if (alive.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  const progressLabel =
    progress?.stage === "installing"
      ? "Installing for your Windows account"
      : progress?.stage === "ready"
        ? "Applying font"
        : progress?.stage === "downloadingBold"
          ? "Downloading bold font"
          : "Downloading font";

  return (
    <div
      className="font-catalog"
      onBlur={(event) => {
        if (!busy && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
          setSelected(null);
          if (!picked) setQuery(null);
        }
      }}
    >
      <div className="font-family-control">
        <label>
          <span>Font family</span>
          <div className="font-family-input">
            <input
              ref={input}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open && results.length > 0}
              aria-controls="font-suggestions"
              aria-activedescendant={open && selected ? `font-option-${selected}` : undefined}
              aria-describedby="font-catalog-help"
              disabled={disabled || busy}
              value={query ?? value}
              placeholder="Search fonts or enter a font family"
              autoComplete="off"
              spellCheck={false}
              onFocus={(event) => {
                event.currentTarget.select();
                setOpen(true);
                if (!catalog && !loading) void loadCatalog();
              }}
              onClick={(event) => {
                if (query === null || picked !== null) event.currentTarget.select();
                setOpen(true);
              }}
              onBlur={() => {
                setOpen(false);
                setSelected(null);
              }}
              onChange={(event) => {
                setQuery(event.target.value);
                setPicked(null);
                setSelected(null);
                setFailure(null);
                setReady(null);
                setOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelPreview();
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setOpen(true);
                  setPicked(null);
                  if (!matching.length) return;
                  const index = matching.findIndex((font) => font.id === selected);
                  const next =
                    index < 0
                      ? event.key === "ArrowDown"
                        ? 0
                        : matching.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + matching.length) %
                        matching.length;
                  setSelected(matching[next]?.id ?? null);
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  const highlighted = results.find((font) => font.id === selected);
                  if (highlighted) choose(highlighted);
                  else if (!picked) keepTypedValue();
                }
              }}
            />
            <ChevronDown size={15} aria-hidden="true" />
          </div>
        </label>
        <ul
          id="font-suggestions"
          role="listbox"
          aria-label="Font suggestions"
          className="font-suggestions"
          hidden={!open || !results.length}
        >
          {results.map((font) => (
            <li
              key={font.id}
              id={`font-option-${font.id}`}
              role="option"
              aria-selected={font.id === selected}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (!busy) choose(font);
              }}
            >
              <span
                style={{
                  fontFamily: faces[font.id] ? `"${faces[font.id]}", monospace` : undefined,
                }}
              >
                {font.family}
              </span>
              <small>
                {faces[font.id]
                  ? font.license
                  : previewErrors[font.id]
                    ? "Preview unavailable"
                    : "Loading preview…"}
              </small>
            </li>
          ))}
        </ul>
      </div>
      <small id="font-catalog-help">
        Search free fonts or enter installed font names and fallbacks. Previews do not install
        fonts.
      </small>
      {loading && <p role="status">Loading font catalog…</p>}
      {catalog?.stale && <p role="status">Catalog unavailable. Showing fonts from this session.</p>}
      {catalogError && (
        <div className="inline-warning">
          <p role="status">{catalogError} Your current font is unchanged.</p>
          <button
            type="button"
            className="secondary-button compact-button"
            onClick={() => {
              void loadCatalog();
              input.current?.focus();
            }}
            disabled={loading || busy}
          >
            Retry catalog
          </button>
        </div>
      )}
      {open && catalog && !loading && results.length === 0 && (
        <p role="status">No matching catalog fonts. You can still use an installed font.</p>
      )}
      {query !== null && !picked && query.trim() && (
        <div className="font-catalog-actions">
          <button
            type="button"
            className="secondary-button compact-button"
            disabled={busy || disabled}
            onClick={keepTypedValue}
          >
            Use typed font
          </button>
          <small>Enter keeps the typed value. Save settings applies it.</small>
        </div>
      )}
      {picked && (
        <div className="font-catalog-actions">
          <span>Previewing {picked.family}</span>
          <button
            type="button"
            className="primary-button compact-button"
            disabled={busy || disabled}
            onClick={() => void install()}
          >
            {failure
              ? installed.current?.id === picked.id
                ? "Retry apply font"
                : "Retry install and use"
              : "Install and use"}
          </button>
          <button
            type="button"
            className="secondary-button compact-button"
            disabled={busy}
            onClick={cancelPreview}
          >
            Keep current font
          </button>
        </div>
      )}
      {picked && previewErrors[picked.id] && (
        <div className="inline-warning">
          <p role="status">{previewErrors[picked.id]} The preview uses your current font.</p>
          <button
            type="button"
            className="secondary-button compact-button"
            disabled={busy}
            onClick={() => void loadPreview(picked)}
          >
            Retry preview
          </button>
        </div>
      )}
      {busy && progress && (
        <div role="status" className="font-install-progress">
          <span>{progressLabel}…</span>
          <progress
            aria-label={progressLabel}
            value={progress.total ? progress.completed : undefined}
            max={progress.total ?? undefined}
          />
          {progress.total && (
            <small>{Math.round((progress.completed / progress.total) * 100)}%</small>
          )}
        </div>
      )}
      {failure && (
        <p role="alert" className="inline-warning">
          {failure}{" "}
          {installed.current?.id === active?.id
            ? "The font is installed for your Windows account but has not been applied or saved. Retry apply font."
            : "Your current font is unchanged. Retry install and use."}
        </p>
      )}
      {ready && <p role="status">{ready}</p>}
    </div>
  );
}
