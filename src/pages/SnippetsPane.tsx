import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Pencil, Plus, SquareTerminal, Trash2 } from "lucide-react";
import { Modal } from "../components/Modal";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import {
  CREDENTIAL_WARNING,
  INSERTION_NOTICE,
  MAX_PARAMETERS,
  SHELL_NOTICE,
  blankParameter,
  errorFor,
  generalErrors,
  initialValues,
  parameterHint,
  parseBound,
  parseChoices,
  scopeLabel,
  templatePlaceholders,
} from "../lib/snippet-form";
import type {
  CommandSnippet,
  SavedConnection,
  SnippetParameter,
  SnippetParameterKind,
  SnippetRender,
} from "../types";

interface Draft {
  id: string | null;
  name: string;
  template: string;
  parameters: SnippetParameter[];
  scoped: boolean;
}

function draftFrom(snippet: CommandSnippet | null): Draft {
  if (!snippet) {
    return { id: null, name: "", template: "", parameters: [], scoped: false };
  }
  return {
    id: snippet.id,
    name: snippet.name,
    template: snippet.template,
    parameters: snippet.parameters.map((parameter) => ({ ...parameter })),
    scoped: Boolean(snippet.connectionId),
  };
}

export function SnippetsPane({
  connection,
  onPaste,
  canPaste,
}: {
  connection: SavedConnection;
  onPaste: (command: string) => void;
  canPaste: boolean;
}) {
  const [snippets, setSnippets] = useState<CommandSnippet[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Values are keyed by the snippet they belong to, so a selection change
  // starts from that snippet's defaults in the same render rather than one
  // render later with an empty set.
  const [valueState, setValueState] = useState<{
    snippetId: string | null;
    values: Record<string, string>;
  }>({ snippetId: null, values: {} });
  const [render, setRender] = useState<SnippetRender | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const listed = await api.listCommandSnippets(connection.id);
      setSnippets(listed);
      setListError(null);
      setSelectedId((current) =>
        current && listed.some((snippet) => snippet.id === current)
          ? current
          : (listed[0]?.id ?? null),
      );
    } catch (caught) {
      setListError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [connection.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = snippets.find((snippet) => snippet.id === selectedId) ?? null;

  const values =
    valueState.snippetId === selectedId
      ? valueState.values
      : selected
        ? initialValues(selected)
        : {};

  function setValues(next: Record<string, string>) {
    setValueState({ snippetId: selectedId, values: next });
  }

  // Every change re-renders in Rust, so the preview is never a local guess at
  // what insertion would produce.
  useEffect(() => {
    if (!selected) {
      setRender(null);
      setRenderError(null);
      return;
    }
    let active = true;
    void api
      .renderCommandSnippet(selected.id, values)
      .then((result) => {
        if (active) {
          setRender(result);
          setRenderError(null);
        }
      })
      .catch((caught) => {
        if (active) {
          setRender(null);
          setRenderError(errorMessage(caught));
        }
      });
    return () => {
      active = false;
    };
  }, [selected, values]);

  async function save() {
    if (!draft) return;
    try {
      const saved = await api.saveCommandSnippet({
        id: draft.id,
        name: draft.name,
        template: draft.template,
        parameters: draft.parameters,
        connectionId: draft.scoped ? connection.id : null,
      });
      setDraft(null);
      setSaveError(null);
      await load();
      setSelectedId(saved.id);
    } catch (caught) {
      setSaveError(errorMessage(caught));
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteCommandSnippet(id);
      await load();
    } catch (caught) {
      setListError(errorMessage(caught));
    }
  }

  async function move(id: string, direction: "up" | "down") {
    try {
      setSnippets(await api.moveCommandSnippet(id, direction, connection.id));
    } catch (caught) {
      setListError(errorMessage(caught));
    }
  }

  if (loading && !snippets.length) return <LoadingState label="Reading snippets…" />;
  if (listError && !snippets.length) {
    return (
      <ErrorState message={listError} action={<button onClick={() => void load()}>Retry</button>} />
    );
  }

  return (
    <section className="feature-page snippets-page">
      <header className="page-heading">
        <div>
          <h2>Snippets</h2>
          <p>{INSERTION_NOTICE}</p>
          <small className="snippets-warning">{CREDENTIAL_WARNING}</small>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => {
            setDraft(draftFrom(null));
            setSaveError(null);
          }}
          aria-label="New snippet"
        >
          <Plus size={16} />
        </button>
      </header>

      {listError && Boolean(snippets.length) && <p className="inline-warning">{listError}</p>}

      <div className="snippets-body">
        <div className="snippets-list">
          {snippets.map((snippet) => (
            <div
              className={snippet.id === selectedId ? "snippets-row selected-row" : "snippets-row"}
              key={snippet.id}
            >
              <button type="button" onClick={() => setSelectedId(snippet.id)}>
                <strong>{snippet.name}</strong>
                <small>{scopeLabel(snippet, connection.displayName)}</small>
              </button>
              <div className="snippets-row-actions">
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => void move(snippet.id, "up")}
                  aria-label={`Move ${snippet.name} up`}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => void move(snippet.id, "down")}
                  aria-label={`Move ${snippet.name} down`}
                >
                  <ChevronDown size={14} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => {
                    setDraft(draftFrom(snippet));
                    setSaveError(null);
                  }}
                  aria-label={`Edit ${snippet.name}`}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => void remove(snippet.id)}
                  aria-label={`Delete ${snippet.name}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
          {!snippets.length && <EmptyState title="No snippets yet" />}
        </div>

        <div className="snippets-detail">
          {selected ? (
            <>
              <h3>{selected.name}</h3>
              <code className="snippets-template">{selected.template}</code>
              {selected.parameters.map((parameter) => {
                const message = errorFor(render, parameter.name);
                return (
                  <label className="snippets-field" key={parameter.name}>
                    <span>
                      {parameter.prompt}
                      <small>{parameterHint(parameter)}</small>
                    </span>
                    {parameter.kind === "choice" ? (
                      <select
                        value={values[parameter.name] ?? ""}
                        onChange={(event) =>
                          setValues({ ...values, [parameter.name]: event.target.value })
                        }
                      >
                        <option value="">Choose</option>
                        {parameter.choices.map((choice) => (
                          <option key={choice} value={choice}>
                            {choice}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={parameter.kind === "integer" ? "number" : "text"}
                        value={values[parameter.name] ?? ""}
                        onChange={(event) =>
                          setValues({ ...values, [parameter.name]: event.target.value })
                        }
                      />
                    )}
                    {message && <small className="snippets-field-error">{message}</small>}
                  </label>
                );
              })}

              {generalErrors(render).map((message) => (
                <p className="inline-warning" key={message}>
                  {message}
                </p>
              ))}
              {renderError && <p className="inline-warning">{renderError}</p>}

              <h4>Preview</h4>
              {render?.command === null || render?.command === undefined ? (
                <p className="snippets-note">
                  {render
                    ? "Fill in the values above to see the command."
                    : "Rendering the command…"}
                </p>
              ) : (
                <pre className="snippets-preview">{render.command}</pre>
              )}
              <p className="snippets-note">{SHELL_NOTICE}</p>

              <button
                className="primary-button"
                type="button"
                disabled={!canPaste || !render?.command}
                onClick={() => render?.command && onPaste(render.command)}
              >
                <SquareTerminal size={15} /> Insert into terminal
              </button>
              <small className="snippets-note">
                {canPaste
                  ? INSERTION_NOTICE
                  : "Reconnect the Terminal Session before inserting a command."}
              </small>
            </>
          ) : (
            <EmptyState title="Select a snippet" />
          )}
        </div>
      </div>

      {draft && (
        <Modal title={draft.id ? "Edit snippet" : "New snippet"} onClose={() => setDraft(null)}>
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              <span>Name</span>
              <input
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                required
              />
            </label>
            <label>
              <span>Template</span>
              <input
                value={draft.template}
                onChange={(event) => setDraft({ ...draft, template: event.target.value })}
                placeholder="journalctl -u {{service}} -n {{lines}}"
                required
              />
              <small>
                One command line. Write a parameter as {"{{name}}"}. Used here:{" "}
                {templatePlaceholders(draft.template).join(", ") || "none yet"}
              </small>
            </label>
            <label className="snippets-checkbox">
              <input
                type="checkbox"
                checked={draft.scoped}
                onChange={(event) => setDraft({ ...draft, scoped: event.target.checked })}
              />
              <span>Only for {connection.displayName}</span>
            </label>

            <h4>Parameters</h4>
            {draft.parameters.map((parameter, index) => (
              <fieldset className="snippets-parameter" key={index}>
                <legend>Parameter {index + 1}</legend>
                <label>
                  <span>Name</span>
                  <input
                    value={parameter.name}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        parameters: draft.parameters.map((entry, at) =>
                          at === index ? { ...entry, name: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  <span>Prompt</span>
                  <input
                    value={parameter.prompt}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        parameters: draft.parameters.map((entry, at) =>
                          at === index ? { ...entry, prompt: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  <span>Type</span>
                  <select
                    value={parameter.kind}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        parameters: draft.parameters.map((entry, at) =>
                          at === index
                            ? { ...entry, kind: event.target.value as SnippetParameterKind }
                            : entry,
                        ),
                      })
                    }
                  >
                    <option value="string">string</option>
                    <option value="integer">integer</option>
                    <option value="choice">choice</option>
                  </select>
                </label>
                {parameter.kind === "choice" && (
                  <label>
                    <span>Choices</span>
                    <input
                      value={parameter.choices.join(", ")}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          parameters: draft.parameters.map((entry, at) =>
                            at === index
                              ? { ...entry, choices: parseChoices(event.target.value) }
                              : entry,
                          ),
                        })
                      }
                      placeholder="--follow, --no-pager"
                    />
                  </label>
                )}
                {parameter.kind === "integer" && (
                  <div className="snippets-bounds">
                    <label>
                      <span>Minimum</span>
                      <input
                        type="number"
                        value={parameter.minimum ?? ""}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            parameters: draft.parameters.map((entry, at) =>
                              at === index
                                ? { ...entry, minimum: parseBound(event.target.value) }
                                : entry,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Maximum</span>
                      <input
                        type="number"
                        value={parameter.maximum ?? ""}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            parameters: draft.parameters.map((entry, at) =>
                              at === index
                                ? { ...entry, maximum: parseBound(event.target.value) }
                                : entry,
                            ),
                          })
                        }
                      />
                    </label>
                  </div>
                )}
                <label>
                  <span>Default</span>
                  <input
                    value={parameter.defaultValue ?? ""}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        parameters: draft.parameters.map((entry, at) =>
                          at === index
                            ? { ...entry, defaultValue: event.target.value || null }
                            : entry,
                        ),
                      })
                    }
                  />
                </label>
                <label className="snippets-checkbox">
                  <input
                    type="checkbox"
                    checked={parameter.required}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        parameters: draft.parameters.map((entry, at) =>
                          at === index ? { ...entry, required: event.target.checked } : entry,
                        ),
                      })
                    }
                  />
                  <span>Required</span>
                </label>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      parameters: draft.parameters.filter((_, at) => at !== index),
                    })
                  }
                >
                  Remove parameter
                </button>
              </fieldset>
            ))}
            <button
              className="secondary-button"
              type="button"
              disabled={draft.parameters.length >= MAX_PARAMETERS}
              onClick={() =>
                setDraft({ ...draft, parameters: [...draft.parameters, blankParameter()] })
              }
            >
              Add parameter
            </button>

            {saveError && <p className="inline-warning">{saveError}</p>}
            <footer className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button className="primary-button" type="submit">
                Save
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </section>
  );
}
