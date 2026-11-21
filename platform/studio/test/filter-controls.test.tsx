// @vitest-environment jsdom
// The studio's filter controls: a FilterSelect's menu lists the choices without repeating its
// button's label as a heading, and the one Filters popover (FacetChips, tested directly) has a
// heading per facet, chips that pick any number, the count on its button and one Clear all.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { anyOf, FacetChips, facetsOn, FilterSelect, FiltersPopover, picksOf, toggled, type Facet } from "@/components/filter-controls";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
afterEach(cleanup);

describe("FilterSelect", () => {
  it("opens its choices with no heading repeating the button's label", async () => {
    render(<FilterSelect label="Status" value="" onChange={() => undefined} options={[{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }]} />);
    const trigger = document.querySelector('[data-filter="Status"]')!;
    expect(trigger.textContent).toBe("Status");
    fireEvent.keyDown(trigger, { key: "Enter" });
    await act(async () => undefined);
    const menu = document.querySelector('[data-filter-menu="Status"]')!;
    expect([...menu.querySelectorAll("[data-filter-option]")].map((o) => o.textContent)).toEqual(["Open", "Closed"]);
    expect(menu.querySelector('[data-slot="dropdown-menu-label"]')).toBeNull();
    expect(menu.textContent).not.toContain("Status");
  });
});

function Harness() {
  const [line, setLine] = useState<string[]>([]);
  const [money, setMoney] = useState<string[]>(["real"]);
  const facets: Facet[] = [
    { id: "line", label: "Product line", options: [{ value: "credit", label: "credit" }, { value: "deposits", label: "deposits" }], selected: line, onChange: setLine },
    { id: "money", label: "Money", options: [{ value: "sandbox", label: "Sandbox" }, { value: "real", label: "Real money" }], selected: money, onChange: setMoney },
  ];
  const clear = () => {
    setLine([]);
    setMoney([]);
  };
  return (
    <>
      <FiltersPopover facets={facets} onClear={clear} />
      <div data-content>
        <FacetChips facets={facets} onClear={clear} />
      </div>
    </>
  );
}

describe("the Filters popover's content", () => {
  it("one heading per facet, chips that toggle (any number per facet), the count on the button, and one Clear all", () => {
    render(<Harness />);
    const content = document.querySelector("[data-content]")!;
    expect([...content.querySelectorAll("[data-facet-heading]")].map((h) => h.textContent)).toEqual(["Product line", "Money"]);
    // No dropdowns or repeated headings inside: chips only.
    expect(content.querySelector("[data-filter], [role='menu'], select")).toBeNull();
    const button = () => document.querySelector("[data-filters-menu-button]")!;
    expect(button().textContent).toBe("Filters· 1");
    const chip = (facet: string, value: string) => content.querySelector(`[data-facet="${facet}"] [data-chip="${value}"]`) as HTMLButtonElement;
    expect(chip("money", "real").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip("line", "credit"));
    fireEvent.click(chip("line", "deposits"));
    expect([chip("line", "credit"), chip("line", "deposits")].map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "true"]);
    expect(button().textContent).toBe("Filters· 3");
    expect(button().getAttribute("aria-label")).toBe("Filters: 3 on");
    // Clicking a picked chip again un-picks it.
    fireEvent.click(chip("line", "credit"));
    expect(chip("line", "credit").getAttribute("aria-pressed")).toBe("false");
    expect(button().textContent).toBe("Filters· 2");
    const clears = [...content.querySelectorAll("button")].filter((b) => b.textContent === "Clear all");
    expect(clears).toHaveLength(1);
    fireEvent.click(clears[0]);
    expect(button().textContent).toBe("Filters");
    expect((content.querySelector("[data-filters-clear]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("counts picks and toggles values", () => {
    expect(facetsOn([{ id: "a", label: "A", options: [], selected: ["x", "y"], onChange: () => undefined }, { id: "b", label: "B", options: [], selected: [], onChange: () => undefined }])).toBe(2);
    expect(toggled(["a", "b"], "a")).toEqual(["b"]);
    expect(toggled(["b"], "a")).toEqual(["b", "a"]);
  });

  it("reads a facet's picks from many values or one (an older single-value filter), and matches any of them", () => {
    expect([picksOf(["a", "", "b"]), picksOf("a"), picksOf(""), picksOf(undefined)]).toEqual([["a", "b"], ["a"], [], []]);
    expect([anyOf([], "x"), anyOf("", null), anyOf(["a", "b"], "b"), anyOf("a", "b"), anyOf(["a"], null)]).toEqual([true, true, true, false, false]);
    // A row with several values (a licence's states) matches when any of them is picked.
    expect([anyOf(["TX", "NJ"], ["NY", "NJ"]), anyOf(["TX"], ["NY", "NJ"])]).toEqual([true, false]);
  });
});
