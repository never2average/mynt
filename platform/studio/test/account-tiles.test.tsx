import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountTiles } from "@/components/account-tiles";
import { fromAppsAndBuilds, fromDashboardTool, NOT_MEASURED } from "@/lib/dashboard";
import { fromLinkedAccounts, networkOf, NOT_LINKED, shortAddress, UNKNOWN_NETWORK } from "@/lib/linked-accounts";

const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const SOLANA = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const MANAGE = "https://accounts.example.com/user";

describe("linked accounts", () => {
  it("reads the GitHub username, the first wallet and the account page", () => {
    expect(fromLinkedAccounts({ git: { username: "ines" }, wallets: [{ address: SOLANA, chain: "solana" }, { address: "0xother" }], manage_url: MANAGE })).toEqual({
      supported: true,
      github: "ines",
      wallet: { address: SOLANA, chain: "solana", network: "Solana" },
      manageUrl: MANAGE,
    });
    expect(fromLinkedAccounts({ git: null, wallets: [] })).toEqual({ supported: true, github: null, wallet: null, manageUrl: null });
  });

  it("links out only to an https page", () => {
    for (const bad of ["javascript:alert(1)", "http://accounts.example.com", "/user", "https://u:p@accounts.example.com", "data:text/html,x"]) {
      expect(fromLinkedAccounts({ manage_url: bad }).manageUrl, bad).toBeNull();
    }
  });

  it("names the wallet's network only when the address fits it", () => {
    expect(networkOf(SOLANA, "solana")).toBe("Solana");
    expect(networkOf(SOLANA)).toBe("Solana");
    expect(networkOf(ADDRESS, "ethereum")).toBe("Ethereum");
    expect(networkOf(ADDRESS)).toBe("EVM");
    // A mismatch, an unknown chain or an address of neither kind is never guessed.
    expect(networkOf(ADDRESS, "solana")).toBe(UNKNOWN_NETWORK);
    expect(networkOf(SOLANA, "ethereum")).toBe(UNKNOWN_NETWORK);
    expect(networkOf(ADDRESS, "made-up-chain")).toBe(UNKNOWN_NETWORK);
    expect(networkOf("0x1234")).toBe(UNKNOWN_NETWORK);
    expect(networkOf("0OIl" + SOLANA.slice(4))).toBe(UNKNOWN_NETWORK);
    expect(fromLinkedAccounts({ wallets: [{ address: ADDRESS, chain: "solana" }] }).wallet?.network).toBe(UNKNOWN_NETWORK);
  });

  it("shortens an address so it's still recognisable", () => {
    expect(shortAddress(ADDRESS)).toBe("0x5290…9EE7");
    expect(shortAddress("short")).toBe("short");
  });
});

const tiles = (d = fromDashboardTool({ active_products: 3, licences: [{}, {}] }), linked = fromLinkedAccounts({ git: { username: "ines" }, wallets: [{ address: SOLANA, chain: "solana" }], manage_url: MANAGE })) =>
  renderToStaticMarkup(<AccountTiles dashboard={d} linked={linked} />);

describe("dashboard tiles", () => {
  it("show active products, licences, the GitHub username and the shortened wallet with its network", () => {
    const html = tiles();
    expect(html).toMatch(/data-tile="active-products"[\s\S]*?>3</);
    expect(html).toMatch(/data-tile="licences"[\s\S]*?>2</);
    expect(html).toContain("ines");
    expect(html).toContain("7EcDhS…FLtV");
    expect(html).toMatch(/data-network="true"[^>]*>Solana</);
    const mismatch = tiles(undefined, fromLinkedAccounts({ wallets: [{ address: ADDRESS, chain: "solana" }] }));
    expect(mismatch).toContain(UNKNOWN_NETWORK);
    expect(mismatch).not.toMatch(/>Solana</);
    expect(html).not.toContain("Link GitHub");
    expect(html).not.toContain("Link wallet");
  });

  it("say Not measured for unmeasured counts, never 0", () => {
    const html = tiles(fromAppsAndBuilds([], { builds: [] }));
    expect(html).toMatch(new RegExp(`data-tile="active-products"[\\s\\S]*?${NOT_MEASURED}`));
    expect(html).toMatch(new RegExp(`data-tile="licences"[\\s\\S]*?${NOT_MEASURED}`));
    expect(html).not.toMatch(/data-tile="(active-products|licences)"[^]*?>0</);
  });

  it("offer Link GitHub and Link wallet, linking out in the same tab to the account page", () => {
    const html = tiles(undefined, fromLinkedAccounts({ git: null, wallets: [], manage_url: MANAGE }));
    for (const label of ["Link GitHub", "Link wallet"]) {
      const at = html.indexOf(label);
      const anchor = html.slice(html.lastIndexOf("<a", at), at);
      expect(anchor, label).toContain(`href="${MANAGE}"`);
      expect(anchor, label).not.toContain("target=");
    }
    expect(html).not.toContain("<iframe");
  });

  it("before Mynt has linked accounts: the Link buttons are there but disabled", () => {
    const html = tiles(undefined, NOT_LINKED);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Link GitHub/);
    expect(html).not.toContain(`href="${MANAGE}"`);
  });
});
