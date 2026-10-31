import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { useState } from "react";
import { ContainerImageIcon } from "./ContainerImageIcon";
import catalog from "../assets/container-logos/catalog.json";
import "../styles.css";

afterEach(cleanup);
function Fixture() {
  const [selected, setSelected] = useState(false);
  return (
    <>
      <button
        className={`arch-chip${selected ? " selected" : ""}`}
        onClick={() => setSelected(!selected)}
      >
        <ContainerImageIcon image="postgres:17" />
        PostgreSQL
      </button>
      <button className="arch-chip">
        <ContainerImageIcon image="mycompany/redis:7" />
        Custom image
      </button>
    </>
  );
}
it("keeps logos neutral at rest and reveals brand colors on hover, keyboard focus, and selection", async () => {
  render(<Fixture />);
  const icon = screen.getByRole("img", { name: "PostgreSQL image" });
  const color = () => getComputedStyle(icon).color;
  const neutral = color();
  const brand = catalog.postgresql.displayHex.match(/../g)!.map((v) => parseInt(v, 16));
  const branded = `rgb(${brand.join(", ")})`;
  await userEvent.hover(screen.getByRole("button", { name: /PostgreSQL/ }));
  await waitFor(() => expect(color()).toBe(branded));
  await page.getByRole("button", { name: "Custom image" }).click();
  await waitFor(() => expect(color()).toBe(neutral));
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await waitFor(() => expect(color()).toBe(branded));
  await userEvent.keyboard("{Enter}{Tab}");
  await waitFor(() => expect(color()).toBe(branded));
  const mask = getComputedStyle(icon).maskImage;
  const url = mask.slice(5, -2);
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  expect(await response.text()).toContain("<svg");
  const fallback = screen.getByRole("button", { name: "Custom image" });
  expect(fallback.querySelector("svg.lucide-container")).toBeTruthy();
  expect(fallback.querySelector(".docker-image-icon")).toBeNull();
});

it("previews the bundled SVG catalog at graph-card size", async () => {
  await page.viewport(1600, 1300);
  render(
    <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 8, padding: 12 }}>
      {Object.values(catalog).map((logo) => (
        <button
          type="button"
          key={logo.title}
          className="arch-chip selected"
          style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48 }}
        >
          <ContainerImageIcon image={logo.images[0]} />
          {logo.title}
        </button>
      ))}
    </div>,
  );
  expect(screen.getAllByRole("img")).toHaveLength(Object.keys(catalog).length);
  await page.screenshot({ path: "../../test-results/container-image-logos.png" });
});
