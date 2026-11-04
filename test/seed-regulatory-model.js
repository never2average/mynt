import assert from "node:assert/strict";

const obligation = (id, title, description, extra = {}) => ({ id, title, description, criticality: "high", ...extra });

// The RBI slice of India's regulatory model the four definitions point at: product types (so the
// regime and the catalogue cite RBI), the customer personas their segments map to, and the bank
// licence whose obligations their nodes satisfy.
export async function regulatoryModel({ ok, admin }) {
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
  ])
    await ok(admin, "define_regulated_product_type", { region: "IN", product_type: { ...t, description: "" } });

  const productTypes = ["in_savings_deposit", "in_term_deposit", "in_bank_payment_services", "in_recurring_mandate", "in_personal_loan", "in_credit_information"];
  await ok(admin, "define_regulator", {
    region: "IN",
    regulator: {
      id: "rbi",
      name: "Reserve Bank of India",
      short_name: "RBI",
      scope: {
        product_types: productTypes.map((id) => ({ id })),
        customer_personas: [
          { id: "rbi_resident_individual", name: "Resident individual", qualification: { min_age: 18, resident: true }, action: ["onboarding", "deposit_custody"] },
          { id: "rbi_senior_citizen", name: "Resident senior citizen", qualification: { min_age: 60, resident: true }, action: ["onboarding", "deposit_custody"] },
          { id: "rbi_retail_borrower", name: "Retail (individual) borrower", qualification: { min_age: 18, resident: true }, action: ["onboarding", "credit"] },
        ],
      },
      license_types: [
        {
          _id: "rbi_bank",
          name: "Banking company (Banking Regulation Act, 1949, section 22)",
          application_procedure: ["Apply to the RBI for a licence under section 22 of the Banking Regulation Act, 1949"],
          grc: {
            registers: {
              obligations: [
                obligation("rbi_kyc_cdd", "Customer due diligence and periodic KYC updation", "Master Direction - Know Your Customer (2016): identify and verify customers before account-based relationships, screen against sanctions lists, update KYC periodically by risk category.", { owner: "rbi_principal_officer" }),
                obligation("rbi_aml_monitoring", "Transaction monitoring and suspicious transaction reporting", "Prevention of Money-laundering Act, 2002 and its rules: monitor transactions and report suspicious ones to FIU-IND.", { owner: "rbi_principal_officer" }),
                obligation("rbi_deposit_interest", "Interest on deposits", "Master Direction - Interest Rate on Deposits (2016): savings interest on the daily balance at quarterly or shorter rests; term deposit rates fixed for the tenor; premature withdrawal at the rate for the period run less a disclosed penalty."),
                obligation("rbi_term_deposit_terms", "Term deposit terms", "Tenor 7 days to 10 years; premature withdrawal available on individuals' deposits up to ₹1 crore; penalty disclosed upfront; unclaimed matured deposits earn the lower of the savings and contracted rate."),
                obligation("rbi_min_balance_charges", "Minimum-balance charges", "Notify the customer of a shortfall, allow one month to restore it, keep charges proportionate to the shortfall, never let them make the balance negative."),
                obligation("rbi_unclaimed_deposits", "Inoperative accounts and unclaimed deposits", "Treat accounts without customer-induced transactions for two years as inoperative, reactivate free, transfer balances unclaimed for ten years to the Depositor Education and Awareness Fund (Banking Regulation Act, section 26A)."),
                obligation("rbi_grievance_redressal", "Grievance redressal", "Board-approved grievance policy; customers may escalate to the RBI Integrated Ombudsman Scheme (2021) if not resolved within 30 days.", { owner: "rbi_principal_nodal_officer" }),
                obligation("rbi_kfs_apr", "Key Facts Statement with APR", "Retail and MSME loans: a Key Facts Statement with the annual percentage rate and every charge before the contract is executed."),
                obligation("rbi_penal_charges", "Penal charges in loan accounts", "Charge defaults as penal charges, not penal interest; never capitalise them; keep them reasonable and disclosed in the KFS."),
                obligation("rbi_digital_lending", "Digital lending", "Disburse to and collect from the borrower's own bank account directly; offer a cooling-off period to exit without penalty."),
                obligation("rbi_fair_recovery", "Fair practices in recovery", "Fair Practices Code: no harassment; recovery contact only between 08:00 and 19:00."),
                obligation("rbi_credit_info_reporting", "Credit information reporting", "Credit Information Companies (Regulation) Act, 2005: membership of every credit information company and regular reporting of borrower data."),
                obligation("rbi_asset_classification", "Early stress and asset classification", "Classify overdue loans as SMA-0, SMA-1 and SMA-2 and as non-performing after 90 days overdue."),
              ],
              reporting_disclosure_filings: [],
              risks: [],
              controls: [],
              inspection_events: [],
            },
            allowed_product_types: productTypes.map((id) => (id === "in_credit_information" ? { id, actions: ["purchase"] } : id)),
            allowed_customer_segments: ["rbi_resident_individual", "rbi_senior_citizen", "rbi_retail_borrower"],
            mandatory_stakeholders: {
              internal: [
                { id: "rbi_principal_officer", name: "Principal officer (PMLA)", qualification: {}, action: ["kyc_reporting"] },
                { id: "rbi_principal_nodal_officer", name: "Principal nodal officer (RB-IOS 2021)", qualification: {}, action: ["grievance_redressal"] },
              ],
              external: [],
            },
          },
        },
      ],
    },
  });
}
