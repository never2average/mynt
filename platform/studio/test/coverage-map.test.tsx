// @vitest-environment jsdom
// The Licences page's map view, drawn (react-simple-maps draws its shapes only in a browser).
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";

import { CoverageMap } from "@/components/coverage-view";
import { LicencesView } from "@/components/licences-view";
import { fromCoverage, fromLicences } from "@/lib/compliance";

afterEach(cleanup);

const coverage = fromCoverage({ states: [{ code: "CA", status: "unlocked", partners: [{ name: "Harbor Bank" }] }, { code: "NY", status: "available" }] });
const licences = fromLicences({
  licences: [
    { partner: "Harbor Bank", number: "MT-1", regulator: "CA DFPI", states: ["CA"], status: "active", expires_at: "2027-06-01" },
    { partner: "Prairie Trust", number: "MT-3", regulator: "TX DOB", states: ["TX"], status: "active", expires_at: "2027-06-01" },
  ],
});

const draw = async (ui: React.ReactElement) => {
  const r = render(ui);
  await act(async () => undefined);
  return r.container;
};

describe("the coverage map", () => {
  it("US: every state and DC, coloured by status (unlocked, available, unavailable)", async () => {
    const c = await draw(<CoverageMap coverage={coverage} region="us" onRegion={() => undefined} />);
    const states = c.querySelectorAll("[data-state]");
    expect(states).toHaveLength(51);
    const fill = (code: string) => c.querySelector(`[data-state="${code}"]`)!.getAttribute("fill");
    expect([fill("CA"), fill("NY"), fill("WY")]).toEqual(["var(--coverage-unlocked)", "var(--coverage-available)", "var(--coverage-unavailable)"]);
    expect(c.querySelector('[data-state="CA"]')!.getAttribute("aria-label")).toBe("California: Unlocked");
  });

  it("World: the US coloured by its coverage, every other country Not available", async () => {
    const c = await draw(<CoverageMap coverage={coverage} region="world" onRegion={() => undefined} />);
    const us = c.querySelector('[data-country="us"]')!;
    expect(us.getAttribute("data-status")).toBe("unlocked");
    expect(us.getAttribute("fill")).toBe("var(--coverage-unlocked)");
    const others = [...c.querySelectorAll("[data-country]")].filter((e) => e !== us);
    expect(others.length).toBeGreaterThan(100);
    expect(new Set(others.map((e) => e.getAttribute("data-status")))).toEqual(new Set(["not-available"]));
    expect(new Set(others.map((e) => e.getAttribute("fill")))).toEqual(new Set(["var(--coverage-unavailable)"]));
    expect(c.querySelector("[data-state]")).toBeNull();
  });

  it("the US / World selector switches the map", async () => {
    const picked: string[] = [];
    const c = await draw(<CoverageMap coverage={coverage} region="us" onRegion={(r) => picked.push(r)} />);
    fireEvent.click(c.querySelector('[data-region="world"]')!);
    expect(picked).toEqual(["world"]);
  });

  it("dims the states the filtered licences don't cover, keeping their colour", async () => {
    const c = await draw(<CoverageMap coverage={coverage} region="us" onRegion={() => undefined} highlight={new Set(["CA"])} />);
    expect(c.textContent).toContain("Showing the 1 state covered by the licences matching your filters");
    expect(c.querySelector('[data-state="CA"]')!.hasAttribute("data-dimmed")).toBe(false);
    const ny = c.querySelector('[data-state="NY"]')!;
    expect(ny.getAttribute("data-dimmed")).toBe("true");
    expect(ny.getAttribute("fill")).toBe("var(--coverage-available)");
    expect(ny.getAttribute("fill-opacity")).toBe("0.3");
  });
});

describe("the Licences toolbar's view toggle", () => {
  it("swaps the table for the map in the same place, keeping the filters", async () => {
    const Harness = () => {
      const [view, setView] = useState<"table" | "map">("table");
      return <LicencesView licences={licences} coverage={{ kind: "ready", data: coverage }} view={view} onView={setView} />;
    };
    const c = await draw(<Harness />);
    fireEvent.change(c.querySelector('select[aria-label="Partner"]')!, { target: { value: "Harbor Bank" } });
    expect(c.querySelectorAll("[data-table-view] tbody tr")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(c.querySelector('[data-view-toggle="map"]')!);
    });
    expect(c.querySelector("[data-table-view]")).toBeNull();
    expect(c.querySelector("[data-map-view]")).not.toBeNull();
    expect((c.querySelector('select[aria-label="Partner"]') as HTMLSelectElement).value).toBe("Harbor Bank");
    // The filtered licence covers California only: the rest are dimmed.
    expect(c.querySelector('[data-state="CA"]')!.hasAttribute("data-dimmed")).toBe(false);
    expect(c.querySelector('[data-state="TX"]')!.getAttribute("data-dimmed")).toBe("true");
    await act(async () => {
      fireEvent.click(c.querySelector('[data-view-toggle="table"]')!);
    });
    expect(c.querySelectorAll("[data-table-view] tbody tr")).toHaveLength(1);
  });

  it("Invite partner opens a form whose sending waits on Mynt; it never emails the partner", async () => {
    const c = await draw(<LicencesView licences={licences} />);
    await act(async () => {
      fireEvent.click(c.querySelector("[data-invite-partner]")!);
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    for (const field of ["Partner firm name", "Contact email", "What they license", "Message to Mynt's admins"]) expect(dialog.textContent).toContain(field);
    expect(dialog.textContent).toContain("nothing is sent to the partner from here");
    const send = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Send request") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(dialog.querySelector("[data-not-yet]")?.textContent).toContain("Coming with Mynt's next update");
  });
});
