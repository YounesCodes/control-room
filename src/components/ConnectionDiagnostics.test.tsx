import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectionDiagnostic } from "../types";
import { ConnectionDiagnostics } from "./ConnectionDiagnostics";

describe("ConnectionDiagnostics", () => {
  it("shows evidence-based stages and the reviewed sanitized detail", () => {
    const diagnostic: ConnectionDiagnostic = {
      schemaVersion: 1,
      category: "authentication",
      summary: "The SSH server rejected authentication.",
      detail: "OpenSSH: permission denied for the offered authentication methods.",
      stages: [
        { id: "configuration", label: "Client configuration", status: "established" },
        { id: "authentication", label: "Authentication", status: "failed" },
        { id: "later", label: "Remote shell", status: "not-established" },
        { id: "ambiguous", label: "Route detail", status: "unknown" },
      ],
    };

    const markup = renderToStaticMarkup(
      <ConnectionDiagnostics diagnostic={diagnostic} onClose={() => undefined} />,
    );

    expect(markup).toContain("Connection diagnostics");
    expect(markup).toContain("Established");
    expect(markup).toContain("Failed");
    expect(markup).toContain("Not established");
    expect(markup).toContain("Unknown");
    expect(markup).toContain(diagnostic.detail);
    expect(markup).toContain("no terminal output or diagnostic record is saved");
  });
});
