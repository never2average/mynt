// Drives a list toolbar's one Filters popover (components/filter-controls.tsx) in jsdom: open it,
// read its headings, toggle chips, Clear all.
import { act, fireEvent } from "@testing-library/react";
import { expect } from "vitest";

export const filtersButton = (root: ParentNode = document) => root.querySelector("[data-filters-menu-button]") as HTMLButtonElement;

export async function openFilters(root: ParentNode = document) {
  const menu = document.querySelector("[data-filters-menu]");
  if (menu) return menu;
  await act(async () => void fireEvent.click(filtersButton(root)));
  return document.querySelector("[data-filters-menu]")!;
}

export const headings = () => [...document.querySelectorAll("[data-filters-menu] [data-facet-heading]")].map((h) => h.textContent);

export async function toggle(facet: string, value: string) {
  const chip = document.querySelector(`[data-filters-menu] [data-facet="${facet}"] [data-chip="${value}"]`) as HTMLButtonElement | null;
  expect(chip, `chip ${facet}=${value}`).not.toBeNull();
  await act(async () => void fireEvent.click(chip!));
}

export async function clearAll() {
  const clears = [...document.querySelectorAll("[data-filters-menu] button")].filter((b) => b.textContent === "Clear all");
  expect(clears).toHaveLength(1);
  await act(async () => void fireEvent.click(clears[0]));
}

/** The toolbar has one Filters button and no single-select filter dropdowns besides the date range (and `allowed`). */
export function oneFiltersButton(toolbar: ParentNode, allowed: string[] = []) {
  expect(toolbar.querySelectorAll("[data-filters-menu-button]")).toHaveLength(1);
  const others = [...toolbar.querySelectorAll("[data-filter]")].map((e) => e.getAttribute("data-filter")).filter((l) => l !== "Date range" && !allowed.includes(l!));
  expect(others).toEqual([]);
}
