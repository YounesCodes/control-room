import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { InspectorDisclosure } from "./InspectorDisclosure";
import "../styles.css";

afterEach(() => {
  cleanup();
});

it("keeps native keyboard toggling for inspector sections", async () => {
  render(
    <InspectorDisclosure title="Mounts">
      <p>No mounts</p>
    </InspectorDisclosure>,
  );
  const summary = screen.getByText("Mounts");
  summary.focus();
  await userEvent.keyboard("{Enter}");
  expect(summary.closest("details")!.open).toBe(true);
  await userEvent.keyboard(" ");
  expect(summary.closest("details")!.open).toBe(false);
});

it("replays the shared fade and slide each time a section expands", async () => {
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
    animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
    const opacity = Number(getComputedStyle(body).opacity);
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
    expect(getComputedStyle(body).transform).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
    animation.finish();
    expect(getComputedStyle(body).opacity).toBe("1");
    await userEvent.click(summary);
    expect(summary.closest("details")!.open).toBe(false);
  }
});
