import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { StepSlider, stepIndex } from "./StepSlider";
import "../styles.css";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

function Fixture({ initial = 5, disabled = false }: { initial?: number; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <form className="settings-form">
      <fieldset disabled={disabled}>
        <StepSlider
          label="Refresh host metrics"
          options={[2, 5, 10, 30]}
          value={value}
          format={(seconds) => `Every ${seconds} seconds`}
          tick={(seconds) => `${seconds}s`}
          onChange={setValue}
        />
      </fieldset>
      <output data-testid="value">{value}</output>
    </form>
  );
}

function mount(element: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(element);
}

const centre = (element: Element) => {
  const bounds = element.getBoundingClientRect();
  return bounds.left + bounds.width / 2;
};

describe("StepSlider", () => {
  it("snaps a saved value that is not a stop to the nearest stop", () => {
    expect(stepIndex([2, 5, 10, 30], 10)).toBe(2);
    expect(stepIndex([2, 5, 10, 30], 3)).toBe(0);
    expect(stepIndex([2, 5, 10, 30], 25)).toBe(3);
  });

  it("steps with the keyboard and moves the emphasized label with its value", async () => {
    await page.viewport(900, 400);
    mount(<Fixture />);
    const slider = page.getByRole("slider", { name: "Refresh host metrics" });
    await expect.element(slider).toHaveAttribute("aria-valuetext", "Every 5 seconds");
    const selected = () => host!.querySelector(".step-slider-ticks > [data-selected]")?.textContent;
    expect(selected()).toBe("5s");
    (slider.element() as HTMLInputElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(slider).toHaveAttribute("aria-valuetext", "Every 10 seconds");
    expect(page.getByTestId("value").element().textContent).toBe("10");
    expect(selected()).toBe("10s");
    // The label is the visible value; no popup repeats it.
    expect(host!.querySelector(".step-slider-bubble")).toBeNull();
    await page.screenshot({
      element: host!.querySelector(".settings-form")!,
      path: "../../test-results/step-slider-focus.png",
    });
    await userEvent.keyboard("{End}");
    expect(page.getByTestId("value").element().textContent).toBe("30");
    await userEvent.keyboard("{Home}");
    expect(page.getByTestId("value").element().textContent).toBe("2");
  });

  it("keeps the thumb, stops, and ticks on the same positions", async () => {
    await page.viewport(900, 400);
    mount(<Fixture initial={10} />);
    await expect
      .element(page.getByRole("slider", { name: "Refresh host metrics" }))
      .toBeInTheDocument();
    const input = host!.querySelector<HTMLInputElement>("input[type=range]")!;
    const stops = [...host!.querySelectorAll(".step-slider-stop")];
    const ticks = [...host!.querySelectorAll(".step-slider-ticks > span")];
    const thumb = 8; // half of the 16px thumb
    const bounds = input.getBoundingClientRect();
    stops.forEach((stop, step) => {
      const expected = bounds.left + thumb + ((bounds.width - thumb * 2) * step) / 3;
      expect(Math.abs(centre(stop) - expected)).toBeLessThanOrEqual(1);
      expect(Math.abs(centre(ticks[step]) - expected)).toBeLessThanOrEqual(1);
    });
    const fill = host!.querySelector(".step-slider-fill")!.getBoundingClientRect();
    expect(Math.abs(fill.right - centre(stops[2]))).toBeLessThanOrEqual(1);
    expect(ticks[2]).toHaveAttribute("data-selected");
    // Tick labels sit below the thumb row, never under the circle.
    expect(ticks[0].getBoundingClientRect().top).toBeGreaterThanOrEqual(bounds.bottom + 4);
    // Clicking a tick label chooses that stop.
    await userEvent.click(ticks[0]);
    expect(page.getByTestId("value").element().textContent).toBe("2");
  });

  it("ignores tick clicks inside a disabled fieldset", async () => {
    await page.viewport(900, 400);
    mount(<Fixture disabled />);
    await expect
      .element(page.getByRole("slider", { name: "Refresh host metrics" }))
      .toBeInTheDocument();
    const ticks = [...host!.querySelectorAll<HTMLElement>(".step-slider-ticks > span")];
    ticks[3].click();
    expect(page.getByTestId("value").element().textContent).toBe("5");
  });
});
