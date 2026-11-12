"use client";

import { useEffect } from "react";

// Keeps the app sized to the part of the screen the on-screen keyboard leaves visible.
// Chrome on Android already resizes the layout (interactive-widget=resizes-content); iOS Safari
// doesn't, so we follow visualViewport there and the composer stays just above the keyboard.
export function useVisualViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty("--app-height", `${vv.height}px`);
      root.style.setProperty("--app-top", `${vv.offsetTop}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--app-top");
    };
  }, []);
}
