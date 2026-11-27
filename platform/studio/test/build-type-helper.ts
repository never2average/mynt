// The Build page's Type dropdown ("Type: App"), as the tests use it: opened from the keyboard (Enter on its labelled
// button), then one of its three choices picked. It replaced the two-way App / Financial product switch.
import { act, fireEvent } from "@testing-library/react";

export type TypeChoice = "app" | "product" | "service";
export const typeTrigger = () => document.querySelector("[data-type-trigger]") as HTMLButtonElement;
export const typeOption = (type: TypeChoice) => document.querySelector(`[data-type-option="${type}"]`) as HTMLElement | null;

export async function openTypeMenu() {
  if (document.querySelector("[data-type-menu]")) return;
  typeTrigger().focus();
  await act(async () => void fireEvent.keyDown(typeTrigger(), { key: "Enter" }));
}

export async function pickType(type: TypeChoice) {
  await openTypeMenu();
  const option = typeOption(type);
  if (!option) throw new Error(`The Type menu has no ${type} choice`);
  await act(async () => void fireEvent.click(option));
}
