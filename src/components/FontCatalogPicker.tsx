import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, errorMessage } from "../lib/api";
import type { CatalogFont, FontCatalog, FontProgress } from "../types";

export function FontCatalogPicker({
  disabled = false,
  onPreview,
  onBusyChange,
  onUse,
}: {
  disabled?: boolean;
  onPreview: (family: string | null) => void;
  onBusyChange: (busy: boolean) => void;
  onUse: (family: string) => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<FontCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
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
  const results = open
    ? (catalog?.fonts ?? [])
        .filter((font) => font.family.toLowerCase().includes(query.trim().toLowerCase()))
        .slice(0, 8)
    : [];
  const active = results.find((font) => font.id === selected) ?? results[0];
  const resultIds = results.map((font) => font.id).join(",");

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
    setLoading(true);
    setCatalogError(null);
    try {
      const response = await api.listCatalogFonts();
      if (alive.current) setCatalog(response);
    } catch (error) {
      if (alive.current) setCatalogError(errorMessage(error));
    } finally {
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
    if (open && active)
      document.getElementById(`font-option-${active.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);
  useEffect(() => {
    onPreview(activeFace ? `"${activeFace}", monospace` : null);
  }, [activeFace, onPreview]);

  async function install() {
    if (!active || running.current) return;
    running.current = true;
    setBusy(true);
    onBusyChange(true);
    setFailure(null);
    setReady(null);
    setProgress({ stage: "downloadingRegular", completed: 0, total: null });
    try {
      const channel = new Channel<FontProgress>();
      channel.onmessage = (value) => {
        if (alive.current) setProgress(value);
      };
      const family = await api.installCatalogFont(active.id, channel);
      // Reuse bytes cached by the successful Windows installer so the new
      // family renders immediately while the system font cache refreshes.
      const bytes = await api.previewCatalogFont(active.id);
      const installedFace = await new FontFace(family, bytes).load();
      document.fonts.add(installedFace);
      await onUse(family);
      if (alive.current) {
        setReady(`${family} is ready and applied to your terminals.`);
        setOpen(false);
      }
    } catch (error) {
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
    <div className="font-catalog">
      <label>
        <span>Search free fonts</span>
        <input
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && results.length > 0}
          aria-controls="font-suggestions"
          aria-activedescendant={open && active ? `font-option-${active.id}` : undefined}
          aria-describedby="font-catalog-help"
          disabled={disabled || busy}
          value={query}
          placeholder="Search monospace fonts"
          onFocus={() => {
            setOpen(true);
            if (!catalog && !loading) void loadCatalog();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(null);
            setFailure(null);
            setReady(null);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              const index = results.findIndex((font) => font.id === active?.id);
              const next =
                (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
              setSelected(results[next]?.id ?? null);
            }
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </label>
      <small id="font-catalog-help">
        Fontsource open-source monospace fonts. Previews are temporary. Install and use downloads
        the font for your Windows account and applies it immediately.
      </small>
      {loading && <p role="status">Loading font catalog…</p>}
      {catalog?.stale && <p role="status">Catalog unavailable. Showing fonts from this session.</p>}
      {catalogError && (
        <div className="inline-warning">
          <p role="status">{catalogError} Your current font is unchanged.</p>
          <button
            type="button"
            className="secondary-button compact-button"
            onClick={() => void loadCatalog()}
            disabled={loading || busy}
          >
            Retry catalog
          </button>
        </div>
      )}
      {open && catalog && !loading && results.length === 0 && (
        <p role="status">No matching fonts.</p>
      )}
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
            aria-selected={font.id === active?.id}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!busy) {
                setSelected(font.id);
                setFailure(null);
              }
            }}
          >
            <span
              style={{ fontFamily: faces[font.id] ? `"${faces[font.id]}", monospace` : undefined }}
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
      {open && active && (
        <div className="font-catalog-actions">
          <span>Previewing {active.family}</span>
          <button
            type="button"
            className="primary-button compact-button"
            disabled={busy || disabled}
            onClick={() => void install()}
          >
            {failure ? "Retry install and use" : "Install and use"}
          </button>
          <button
            type="button"
            className="secondary-button compact-button"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Keep current font
          </button>
        </div>
      )}
      {open && active && previewErrors[active.id] && (
        <div className="inline-warning">
          <p role="status">{previewErrors[active.id]} The preview uses your current font.</p>
          <button
            type="button"
            className="secondary-button compact-button"
            disabled={busy}
            onClick={() => void loadPreview(active)}
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
          {failure} Your current font is unchanged. Retry install and use.
        </p>
      )}
      {ready && <p role="status">{ready}</p>}
    </div>
  );
}
