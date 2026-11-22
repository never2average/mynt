// Screenshots of the visual harness's screens (vite.config.ts builds them), at desktop and phone
// sizes, light and dark, with a note of anything wider than the page. Playwright is the machine's
// own (not a dependency): PLAYWRIGHT=<path to the playwright package>. Run under the browser lock:
//   with-browser-lock node test/visual/shoot.mjs <built dir> <out dir> [screen-prefix ...]
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const [dist, out, ...only] = process.argv.slice(2);
const { chromium } = await import(process.env.PLAYWRIGHT ?? "/usr/lib/node_modules/playwright/index.mjs");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const path = join(dist, decodeURIComponent(new URL(req.url, "http://h").pathname).replace(/^\/$/, "/index.html"));
  try {
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const click = (sel) => async (p) => p.locator(sel).first().click({ timeout: 5000 });
const SHOTS = [
  ["dashboard"],
  ["dashboard-empty"],
  ["investor", "dashboard", [click("[data-mode-trigger]"), async (p) => p.getByRole("menuitem", { name: /Investor/ }).click({ timeout: 5000 })]],
  ["sidebar-collapsed", "dashboard", [async (p) => p.locator("[data-site-header] [data-sidebar=trigger]").first().click()], "desktop"],
  ["sidebar-open-mobile", "dashboard", [async (p) => p.locator("[data-site-header] [data-sidebar=trigger]").first().click()], "mobile"],
  ["earn-start"],
  ["earn-slash", "earn-start", [async (p) => p.getByRole("textbox", { name: "Message input" }).fill("/")]],
  ["earn-wallet", "earn-start", [click('[data-wallet-picker="wallets"]')]],
  ["earn-pools"],
  ["earn-my-pools"],
  ["earn-strategies"],
  ["earn-approval", "earn-strategies", [click("[data-review]")], "desktop"],
  ["builds"],
  ["builds-empty"],
  ["licences"],
  ["licences-map"],
  ["audits-security"],
  ["audits-obligations"],
  ["audits-financial"],
  ["audits-workspace"],
  ["settings-members"],
  ["settings-invitations"],
  ["settings-apps"],
  ["settings-repositories"],
  ["connect"],
  ["new"],
  ["app"],
  ...["pnl", "licences", "security", "sdk", "activity"].map((t) => [`app-${t}`, "app", [click(`[data-panel-tab="${t}"]`)], "desktop"]),
];
const SIZES = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const notes = [];
for (const [name, screen = name, steps = [], onlySize] of SHOTS) {
  if (only.length && !only.some((o) => name.startsWith(o))) continue;
  for (const [size, viewport] of Object.entries(SIZES)) {
    if (onlySize && onlySize !== size) continue;
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport, colorScheme: theme, isMobile: size === "mobile", hasTouch: size === "mobile" });
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e.stack ?? e.message).split("\n").slice(0, 4).join(" | ").slice(0, 400)));
      await page.goto(`${origin}/?screen=${screen}&theme=${theme}`);
      await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 2000)); // charts finish animating
      try {
        for (const s of steps) {
          await s(page);
          await page.waitForTimeout(1500);
        }
      } catch (e) {
        errors.push(`step: ${String(e.message).split("\n")[0]}`);
      }
      // What sticks out past the right edge of the page, outside anything that scrolls sideways.
      const wide = await page.evaluate(() => {
        const W = window.innerWidth;
        const scrolls = (el) => {
          for (let a = el.parentElement; a; a = a.parentElement) {
            const o = getComputedStyle(a).overflowX;
            if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return a !== document.body && a !== document.documentElement;
          }
          return false;
        };
        const hits = [];
        for (const el of document.querySelectorAll("body *")) {
          const r = el.getBoundingClientRect();
          if (r.width && r.right > W + 1 && !scrolls(el)) hits.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className).split(" ").slice(0, 3).join(".")} right=${Math.round(r.right)}`);
        }
        return { page: document.documentElement.scrollWidth > W, hits: hits.slice(0, 5) };
      });
      const file = `${name}.${size}.${theme}.png`;
      await page.screenshot({ path: join(out, file) });
      notes.push({ file, errors, wide });
      await page.close();
    }
  }
}
await browser.close();
server.close();
await writeFile(join(out, "notes.json"), JSON.stringify(notes, null, 1));
for (const n of notes) if (n.errors.length || n.wide.page || n.wide.hits.length) console.log(n.file, JSON.stringify({ errors: n.errors, wide: n.wide }));
console.log(`${notes.length} screenshots in ${out}`);
