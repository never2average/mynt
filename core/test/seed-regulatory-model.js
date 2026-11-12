import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyRegulatoryModel } from "../scripts/regulatory-model.mjs";

// The four reference definitions (schemas/examples/seed/) run against India's model as production has it, not a
// model built for them. productionLikeModel builds, through admin tools only, a slice of production's shape:
//   - RBI's universal bank licence (rbi_universal_bank) with its own obligations (ucb_ob_*), stakeholders and
//     personas (rbi_retail_individual_resident, rbi_senior_citizen_depositor), and none of what the seeds cite;
//   - IFSCA and BSE licensing the same product types, with more licence types each than RBI. Their ids sort
//     before rbi, which used to make the catalogue cite them instead of RBI.
// regulatoryModel then applies schemas/regulatory/in.additions.json in merge mode, as on production: the personas
// and obligations the seeds cite are added, and nothing already there changes.

export const ADDITIONS = JSON.parse(readFileSync(new URL("../schemas/regulatory/in.additions.json", import.meta.url), "utf8"));

const productTypes = ["in_savings_deposit", "in_term_deposit", "in_bank_payment_services", "in_recurring_mandate", "in_personal_loan", "in_credit_information"];

export async function productionLikeModel({ ok, admin }) {
  const categories = await ok(admin, "list_product_categories");
  const has = (id) => categories.some((c) => c.id === id);
  assert.ok(has("deposits") && has("credit"), "deposits and credit come with the catalogue");
  if (!has("payment_services")) await ok(admin, "define_product_category", { id: "payment_services", name: "Payment services", product_lines: ["payments"] });
  if (!has("credit_information")) await ok(admin, "define_product_category", { id: "credit_information", name: "Credit information", product_lines: ["information"] });
  for (const t of [
    { id: "in_savings_deposit", name: "Savings bank deposit", type_id: "deposits", actions: ["issuance"], underlying: "cash" },
    { id: "in_term_deposit", name: "Term deposit (fixed and recurring)", type_id: "deposits", actions: ["issuance"], underlying: "cash" },
    { id: "in_bank_payment_services", name: "Bank payment services (cards, UPI, IMPS, NEFT, RTGS)", type_id: "payment_services", actions: ["issuance"] },
    { id: "in_recurring_mandate", name: "Recurring payment mandate (standing instruction, NACH, UPI AutoPay)", type_id: "payment_services", actions: ["issuance", "sale"] },
    { id: "in_personal_loan", name: "Personal loan", type_id: "credit", actions: ["issuance", "servicing"], underlying: "cash" },
    { id: "in_credit_information", name: "Credit information (CICRA, 2005)", type_id: "credit_information", actions: ["sale", "purchase"], underlying: "data" },
    { id: "in_listed_debt", name: "Listed debt securities", type_id: "credit", actions: ["issuance"] },
  ])
    await ok(admin, "define_regulated_product_type", { region: "IN", product_type: { ...t, description: "" } });

  const licence = (_id, name, grants) => ({ _id, name, grc: { allowed_product_types: grants } });
  // IFSCA and BSE: their ids sort before rbi, and each has more licence types granting the products than RBI.
  await ok(admin, "define_regulator", {
    region: "IN",
    regulator: {
      id: "ifsca",
      name: "International Financial Services Centres Authority",
      short_name: "IFSCA",
      scope: { product_types: ["in_savings_deposit", "in_term_deposit", "in_personal_loan"].map((id) => ({ id })) },
      license_types: [
        licence("ifsca_ifsc_banking_unit", "IFSC banking unit", ["in_savings_deposit", "in_term_deposit", "in_personal_loan"]),
        licence("ifsca_ifsc_banking_company", "IFSC banking company", ["in_savings_deposit", "in_term_deposit", "in_personal_loan"]),
      ],
    },
  });
  await ok(admin, "define_regulator", {
    region: "IN",
    regulator: {
      id: "bse",
      name: "BSE Limited",
      short_name: "BSE",
      scope: { product_types: [{ id: "in_listed_debt" }] },
      license_types: [licence("bse_listing_debt", "Debt listing", ["in_listed_debt"]), licence("bse_listing_municipal_debt", "Municipal debt listing", ["in_listed_debt"])],
    },
  });
  await ok(admin, "define_regulator", {
    region: "IN",
    regulator: {
      id: "rbi",
      name: "Reserve Bank of India",
      short_name: "RBI",
      scope: {
        product_types: productTypes.map((id) => ({ id })),
        customer_personas: [
          { id: "rbi_retail_individual_resident", name: "Retail individual (resident)", qualification: { entity_type: "individual" }, action: ["deposit", "borrow"] },
          { id: "rbi_senior_citizen_depositor", name: "Senior citizen depositor", qualification: { entity_type: "individual" }, action: ["deposit"] },
        ],
      },
      license_types: [
        {
          _id: "rbi_universal_bank",
          name: "Universal commercial bank (private sector banking licence)",
          application_procedure: ["Apply to the RBI under the guidelines for on-tap licensing of universal banks"],
          grc: {
            registers: {
              obligations: [
                { id: "ucb_ob_kyc_cdd", title: "Customer due diligence and KYC", recurrence: "continuous", owner: "ucb_sh_principal_officer" },
                { id: "ucb_ob_aml_reporting", title: "AML reporting to FIU-IND", owner: "ucb_sh_principal_officer" },
                { id: "ucb_ob_fair_conduct", title: "Fair practices and conduct" },
              ],
              reporting_disclosure_filings: [{ id: "ucb_fl_ctr", name: "Cash transaction report", category: "reporting", frequency: "monthly", obligation_ref: "ucb_ob_aml_reporting" }],
              risks: [{ id: "ucb_rk_aml", title: "Money laundering through deposit accounts" }],
            },
            repositories: { press_releases: [{ title: "Licensing guidelines for universal banks", date: "2016-08-01", summary: "On-tap licensing." }] },
            allowed_product_types: productTypes.map((id) => (id === "in_credit_information" ? { id, actions: ["purchase"] } : id)),
            allowed_customer_segments: ["rbi_retail_individual_resident", "rbi_senior_citizen_depositor"],
            mandatory_stakeholders: {
              internal: [{ id: "ucb_sh_principal_officer", name: "Principal Officer (PMLA)", qualification: {}, action: ["report_to_fiu"], obligations: ["ucb_ob_aml_reporting", "ucb_ob_kyc_cdd"] }],
              external: [{ id: "ucb_sh_fiu", name: "FIU-IND", qualification: {}, action: ["receive_reports"], obligations: ["ucb_ob_aml_reporting"] }],
            },
          },
        },
      ],
    },
  });
  await ok(admin, "define_region", { code: "IN", regulators: ["RBI", "SEBI", "IRDAI", "IFSCA", "BSE"] });
}

// The client's tools as applyRegulatoryModel calls them.
export const toolsOf = (admin) => ({
  call: async (name, args = {}) => {
    const res = await admin.callTool({ name, arguments: args });
    let data;
    try {
      data = JSON.parse(res.content[0].text);
    } catch {
      data = { error: res.content[0].text };
    }
    return { isError: res.isError ?? false, data };
  },
  listTools: async () => (await admin.listTools()).tools,
});

export async function regulatoryModel(w) {
  await productionLikeModel(w);
  const applied = await applyRegulatoryModel({ ...toolsOf(w.admin), model: ADDITIONS });
  assert.equal(applied.applied, true, JSON.stringify(applied.problems));
  return applied;
}
