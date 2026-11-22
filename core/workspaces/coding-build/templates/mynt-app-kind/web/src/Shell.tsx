// The app's screens, from its kind (mynt-kind.json), one at a time by the address's #/<screen>. The
// screens in ./screens start as placeholders: build each out (and swap this for a router if the app grows).
import { useEffect, useState } from "react";
import { SCREENS } from "./screens";

const current = () => location.hash.replace(/^#\/?/, "");

export function Shell() {
  const [id, setId] = useState(current);
  useEffect(() => {
    const on = () => setId(current());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const screen = SCREENS.find((s) => s.id === id) ?? SCREENS[0];
  return (
    <>
      <nav aria-label="Screens">
        {SCREENS.map((s) => (
          <a key={s.id} href={`#/${s.id}`} aria-current={s.id === screen.id ? "page" : undefined} style={{ marginRight: 12 }}>
            {s.title}
          </a>
        ))}
      </nav>
      <screen.Screen />
    </>
  );
}
