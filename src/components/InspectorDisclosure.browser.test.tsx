import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { InspectorDisclosure } from "./InspectorDisclosure";
import "../styles.css";

afterEach(() => {
  cleanup();
  document.getElementById("disclosure-motion-test")?.remove();
});

it("keeps native keyboard toggling and reveals content immediately with reduced motion", async () => {
  render(
    <InspectorDisclosure title="Mounts">
      <p>No mounts</p>
    </InspectorDisclosure>,
  );
  const summary = screen.getByText("Mounts");
  summary.focus();
  await userEvent.keyboard("{Enter}");
  expect(summary.closest("details")!.open).toBe(true);
  const body = document.querySelector(".inspector-disclosure-body")!;
  expect(getComputedStyle(body).animationName).toBe("none");
  expect(getComputedStyle(body).opacity).toBe("1");
  await userEvent.keyboard(" ");
  expect(summary.closest("details")!.open).toBe(false);
});

it("replays the shared fade and slide each time a section expands", async () => {
  // The browser suite requests reduced motion; override only this component
  // to inspect the normal animation without changing the rest of the fixture.
  const style = document.createElement("style");
  style.id = "disclosure-motion-test";
  style.textContent =
    "details[open] > .inspector-disclosure-body { animation: inspector-section-in 160ms linear both !important; }";
  document.head.append(style);
  render(
    <InspectorDisclosure title="Host firewall policy">
      <p>Not tested</p>
    </InspectorDisclosure>,
  );
  const summary = screen.getByText("Host firewall policy");
  const body = document.querySelector(".inspector-disclosure-body")!;
  for (let expansion = 0; expansion < 2; expansion += 1) {
    await userEvent.click(summary);
    const animation = body.getAnimations()[0];
    expect(animation).toBeTruthy();
    animation.pause();
    animation.currentTime = 0;
    expect(getComputedStyle(body).opacity).toBe("0");
    animation.currentTime = 80;
    expect(Number(getComputedStyle(body).opacity)).toBeCloseTo(0.5);
    expect(getComputedStyle(body).transform).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
    animation.finish();
    expect(getComputedStyle(body).opacity).toBe("1");
    await userEvent.click(summary);
    expect(summary.closest("details")!.open).toBe(false);
  }
});
