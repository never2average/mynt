import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  activityRows,
  appRows,
  breachRows,
  checkRows,
  connectionRows,
  covenantPauseRows,
  covenantRows,
  customerSections,
  definitionFrom,
  documentRows,
  handoffRows,
  HEALTH_NUMBERS_ONLY,
  healthRows,
  ledgerRows,
  NO_DEFINITION,
  NOT_YET,
  obligationRows,
  riskModelSections,
  section,
  sponsorshipRows,
  subscriptionRows,
  subscriptionsFrom,
  termsSections,
  unavailable,
  versionRows,
  workspaceProductFrom,
  type NotYet,
  type ProductTab,
  type ProductTabData,
  type TabSection,
  type WorkspaceProduct,
} from "./product-panel";
import { fromPromotionChecks } from "./promotions";
import { loadRegister } from "./risk-register-server";
import { nextProductStage } from "./products";
import { callStudioTool, isAuthError, listMyntTools } from "./studio-server";
import { appHref } from "./threads";
import { STAGE_LABELS } from "./workspaces";

// One tab of a financial product's workspace, read from Mynt as the signed-in user and only for that
// product: every call names the product (or reads the user's own list and keeps this product's rows), and
// the product must be one Mynt lists as theirs. A tool this Mynt doesn't offer the user is "not available"
// with why; a figure Mynt doesn't send is never shown as 0.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// The user's own product (archived ones too), or null when it isn't theirs.
export async function workspaceProduct(mynt: Client, id: string): Promise<WorkspaceProduct | null> {
  return workspaceProductFrom(await callStudioTool(mynt, "list_my_products", { include_archived: true }), id);
}

export async function loadProductTab(mynt: Client, product: WorkspaceProduct, tab: ProductTab): Promise<ProductTabData | NotYet> {
  const tools = await listMyntTools(mynt);
  const has = (name: string) => tools.some((t) => t.name === name);
  // A read Mynt refuses is left out (null); a lost sign-in isn't.
  const read = async (name: string, args: Record<string, unknown>): Promise<unknown | null> => {
    if (!has(name)) return null;
    try {
      return await callStudioTool(mynt, name, args);
    } catch (err) {
      if (isAuthError(err)) throw err;
      return null;
    }
  };
  const definition = async () => (has("get_product_definition") ? definitionFrom(await read("get_product_definition", { product_id: product.id })) : null);
  const id = product.id;

  switch (tab) {
    case "terms": {
      const d = await definition();
      if (!d) return NOT_YET("Reading a product's definition comes with Mynt's next update.");
      if (!d.definition) return NOT_YET(NO_DEFINITION);
      return { available: true, sections: termsSections(d.definition) };
    }
    case "customers": {
      const d = await definition();
      if (!d) return NOT_YET("Reading a product's definition comes with Mynt's next update.");
      if (!d.definition) return NOT_YET(NO_DEFINITION);
      return { available: true, sections: customerSections(d.definition) };
    }
    case "risk": {
      const [d, sponsorships, health, covenants, breaches, risks] = await Promise.all([
        definition(),
        read("list_my_sponsorships", { product_id: id }),
        read("list_product_health", { product_id: id, limit: 12 }),
        read("list_covenants", { product_id: id }),
        read("list_covenant_breaches", { product_id: id, open_only: true }),
        // The product's risk register, kept by its own firm (read-only for its sponsors).
        loadRegister(mynt, { type: "product", id }),
      ]);
      const sections: TabSection[] = [];
      if (d?.definition) sections.push(...riskModelSections(d.definition));
      else sections.push(unavailable("risk-models", "Risk models and decisioning", ["Model", "Purpose"], d ? NO_DEFINITION : "Reading a product's definition comes with Mynt's next update."));
      // A licence provider reads its own rules and breach record; the product's firm sees only when one pauses sales.
      if (covenants !== null) sections.push(section("covenants", "Covenants", ["Rule", "Status", "Action", "Since"], covenantRows(covenants), "No covenants on this product."));
      else sections.push(unavailable("covenants", "Covenants", ["Rule", "Status"], "Only the licence provider that sponsors this product reads its covenant rules; you see below when one pauses new sales."));
      if (breaches !== null) sections.push(section("breaches", "Open breaches", ["Rule", "Action", "Where", "Since"], breachRows(breaches), "No open breaches."));
      sections.push(
        sponsorships === null
          ? unavailable("covenant-pauses", "Sales paused by a covenant", ["Licence provider", "Rule", "Since"], has("list_my_sponsorships") ? "Mynt didn't answer with this product's sponsorships." : "Sponsorships come with Mynt's next update.")
          : section("covenant-pauses", "Sales paused by a covenant", ["Licence provider", "Rule", "Since"], covenantPauseRows(sponsorships), "No covenant is pausing this product's sales."),
      );
      sections.push(
        health === null
          ? unavailable("health", "Product health", ["Snapshot", "Status"], has("list_product_health") ? "Mynt didn't answer with this product's health record." : "Product health comes with Mynt's next update.")
          : section("health", "Product health", ["Snapshot", "Period", "Status", "Source", "Verified", "Fingerprint"], healthRows(health, id), "No health snapshot for this product yet: it's recorded once a licence provider sponsors it.", has("get_product_health") ? undefined : HEALTH_NUMBERS_ONLY),
      );
      return { available: true, sections, register: risks.register };
    }
    case "compliance": {
      const next = product.archived ? null : nextProductStage(product.stage);
      const [d, sponsorships, apps, checks] = await Promise.all([
        definition(),
        read("list_my_sponsorships", { product_id: id }),
        read("list_my_apps", {}),
        next ? read("get_product_promotion_checks", { product_id: id, to_stage: next }) : Promise.resolve(null),
      ]);
      // Obligations are read per workspace: the workspaces whose apps use this product (at most five).
      const workspaces = [
        ...new Set(
          (Array.isArray(apps) ? apps : [])
            .filter(isObj)
            .filter((a) => Array.isArray(a.product_ids) && a.product_ids.includes(id) && typeof a.workspace_id === "string" && a.workspace_id)
            .map((a) => a.workspace_id as string),
        ),
      ].slice(0, 5);
      const obligations = has("get_workspace_obligations") ? await Promise.all(workspaces.map((w) => read("get_workspace_obligations", { workspace_id: w }))) : null;
      const parsed = next && checks !== null ? fromPromotionChecks(checks, next) : null;
      const sections: TabSection[] = [
        sponsorships === null
          ? unavailable("sponsorship", "Sponsorship", ["Licence provider", "Component"], has("list_my_sponsorships") ? "Mynt didn't answer with this product's sponsorships." : "Sponsorships come with Mynt's next update.")
          : section("sponsorship", "Sponsorship", ["Licence provider", "Component", "Status", "Licences", "Where"], sponsorshipRows(sponsorships, id), "No licence provider sponsors this product yet. Ask one in the chat, or with request_sponsorship."),
        obligations === null
          ? unavailable("obligations", "Regulatory obligations", ["Obligation", "Status"], "Obligations come with Mynt's next update.")
          : !workspaces.length
            ? unavailable("obligations", "Regulatory obligations", ["Obligation", "Status"], "Mynt reads obligations through the workspaces whose apps use a product, and no app of yours uses this one yet.")
            : section("obligations", "Regulatory obligations", ["Obligation", "Licence holder", "Regulator and licence", "Status", "Evidence"], obligationRows(obligations, id), "No obligation in the regulator's register names this product."),
        d?.definition
          ? section("documents", "Disclosures and documents", ["Document", "Address"], documentRows(d.definition), "The definition lists no disclosure documents.")
          : unavailable("documents", "Disclosures and documents", ["Document", "Address"], d ? NO_DEFINITION : "Reading a product's definition comes with Mynt's next update."),
        product.archived
          ? unavailable("next-stage", "What the next stage needs", ["Check", "Status"], "The product is archived: unarchive it first.")
          : !next
            ? unavailable("next-stage", "What the next stage needs", ["Check", "Status"], "The product is in production: there's no next stage to check it for.")
            : parsed
              ? section("next-stage", `What ${STAGE_LABELS[next]} needs`, ["Check", "Status", "Detail", "To fix"], checkRows(parsed.checks), "Mynt lists no checks for this move.")
              : unavailable("next-stage", "What the next stage needs", ["Check", "Status"], has("get_product_promotion_checks") ? "Mynt didn't answer with this product's checks." : "Promotion checks come with Mynt's next update."),
      ];
      return { available: true, sections };
    }
    case "integrations": {
      const [d, subsReply, health] = await Promise.all([definition(), read("list_my_vendor_subscriptions", {}), read("list_product_health", { product_id: id, limit: 1 })]);
      const subs = subsReply === null ? null : subscriptionsFrom(subsReply);
      const sections: TabSection[] = [
        d?.definition
          ? section("handoffs", "Partner hand-offs", ["Hand-off", "Starts on", "Channel", "Vendor service", "On failure"], handoffRows(d.definition, subs), "The definition declares no partner hand-offs.")
          : unavailable("handoffs", "Partner hand-offs", ["Hand-off", "Vendor service"], d ? NO_DEFINITION : "Reading a product's definition comes with Mynt's next update."),
        subs === null
          ? unavailable("subscriptions", "Vendor services", ["Vendor", "Service"], has("list_my_vendor_subscriptions") ? "Mynt didn't answer with your firm's vendor services." : "Vendor services come with Mynt's next update.")
          : section("subscriptions", "Vendor services", ["Vendor", "Service", "Offering", "Mode", "This product"], subscriptionRows(subs, d?.definition ?? null), "Your firm subscribes to no vendor services yet."),
        d?.definition
          ? section("connections", "Connections", ["Kind", "From", "To"], connectionRows(d.definition), "The definition declares no other connections.")
          : unavailable("connections", "Connections", ["Kind", "From", "To"], d ? NO_DEFINITION : "Reading a product's definition comes with Mynt's next update."),
        health === null
          ? unavailable("ledger", "Partner ledger", ["Record", "Source"], has("list_product_health") ? "Mynt didn't answer with this product's health record." : "The partner ledger's status comes with Mynt's next update.")
          : section("ledger", "Partner ledger", ["Record", "Latest figures from", "Period end", "On-chain record", "Gaps"], ledgerRows(health, id), "No ledger is connected for this product yet: its licence provider connects one when it sponsors it."),
      ];
      return { available: true, sections };
    }
    case "apps": {
      const apps = await read("list_my_apps", {});
      if (apps === null) return NOT_YET("Mynt didn't answer with your apps.");
      return { available: true, sections: [section("apps", "Apps built on this product", ["App", "Stage", "Last changed"], appRows(apps, id, (s) => STAGE_LABELS[s], (a) => appHref(a)), "No app of yours is built on this product yet. Start one from Build.")] };
    }
    case "activity": {
      const [versions, activity] = await Promise.all([read("list_product_versions", { id }), read("list_product_activity", { id, limit: 50 })]);
      const sections: TabSection[] = [
        versions === null
          ? unavailable("versions", "Versions", ["Version", "Status"], has("list_product_versions") ? "Mynt didn't answer with this product's versions." : "Versions come with Mynt's next update.")
          : section("versions", "Versions", ["Version", "Status", "Changelog", "Tests", "Published"], versionRows(versions), "No version recorded yet: the first is recorded when the product is published."),
        activity === null
          ? unavailable("events", "Stage moves, drift and archiving", ["When", "What"], has("list_product_activity") ? "Mynt didn't answer with this product's activity." : "The product's activity comes with Mynt's next update.")
          : section("events", "Stage moves, drift and archiving", ["When", "What", "Details", "Who"], activityRows(activity), "Nothing has happened to this product yet."),
      ];
      return { available: true, sections };
    }
  }
}
