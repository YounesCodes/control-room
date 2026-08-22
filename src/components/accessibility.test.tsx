import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Modal } from "./Modal";
import { ErrorState, LoadingState } from "./PanelState";

describe("shared accessibility markup", () => {
  it("gives dialogs an accessible name and semantic close button", () => {
    const markup = renderToStaticMarkup(
      <Modal title="Add Saved Connection" onClose={() => undefined}>
        <button type="button">Save</button>
      </Modal>,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toMatch(/aria-labelledby="[^"]+"/);
    expect(markup).toContain("Add Saved Connection");
    expect(markup).toContain('aria-label="Close"');
  });

  it("announces loading state and keeps error actions operable", () => {
    expect(renderToStaticMarkup(<LoadingState label="Loading hosts…" />)).toContain(
      'aria-live="polite"',
    );
    const errorMarkup = renderToStaticMarkup(
      <ErrorState message="Connection refused" action={<button type="button">Retry</button>} />,
    );
    expect(errorMarkup).toContain("Connection refused");
    expect(errorMarkup).toContain("Retry");
  });
});
