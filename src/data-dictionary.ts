// Mynt's data dictionary: the customer data fields journeys collect, each with its type and validation,
// how sensitive it is (which decides whether it must be captured in a secure field), and the ways it may
// be captured. Products name these fields in their partner handoffs' input schemas ("sends.required"), so
// "ask for their income" always means monthly_income, validated the same way everywhere.

export const SENSITIVITIES = ["public", "personal", "sensitive"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];
export const CAPTURE_METHODS = ["typed", "secure_field", "document_upload", "account_aggregator", "digilocker", "ckyc", "derived"] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];

export interface DataField {
  label: string;
  type: "string" | "integer" | "number" | "date" | "boolean" | "file" | "enum";
  pattern?: string;
  enum?: string[];
  sensitivity: Sensitivity;
  capture: CaptureMethod[];
  countries?: string[]; // where the field applies; omitted means everywhere
}

export const DATA_DICTIONARY: Record<string, DataField> = {
  full_name: { label: "Full name", type: "string", sensitivity: "personal", capture: ["typed", "ckyc", "digilocker"] },
  date_of_birth: { label: "Date of birth", type: "date", sensitivity: "personal", capture: ["typed", "ckyc", "digilocker"] },
  mobile_number: { label: "Mobile number", type: "string", pattern: "^\\+?[0-9]{10,15}$", sensitivity: "personal", capture: ["typed"] },
  email: { label: "Email", type: "string", pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", sensitivity: "personal", capture: ["typed"] },
  address: { label: "Address", type: "string", sensitivity: "personal", capture: ["typed", "ckyc", "digilocker"] },
  residence_state: { label: "US state of residence", type: "string", pattern: "^[Uu][Ss]-[A-Za-z]{2}$", sensitivity: "personal", capture: ["typed"], countries: ["us"] },
  pin_code: { label: "PIN code", type: "string", pattern: "^[1-9][0-9]{5}$", sensitivity: "personal", capture: ["typed", "ckyc"], countries: ["in"] },
  pan: { label: "PAN", type: "string", pattern: "^[A-Z]{5}[0-9]{4}[A-Z]$", sensitivity: "sensitive", capture: ["secure_field", "digilocker", "ckyc"], countries: ["in"] },
  aadhaar_reference: { label: "Aadhaar (reference or masked)", type: "string", sensitivity: "sensitive", capture: ["digilocker", "ckyc"], countries: ["in"] },
  ssn: { label: "Social Security number", type: "string", pattern: "^[0-9]{3}-?[0-9]{2}-?[0-9]{4}$", sensitivity: "sensitive", capture: ["secure_field"], countries: ["us"] },
  employment_type: { label: "Employment type", type: "enum", enum: ["salaried", "self_employed", "business_owner", "student", "retired", "other"], sensitivity: "personal", capture: ["typed"] },
  monthly_income: { label: "Monthly income", type: "number", sensitivity: "personal", capture: ["typed", "account_aggregator"] },
  bank_account_number: { label: "Bank account number", type: "string", pattern: "^[0-9]{9,18}$", sensitivity: "sensitive", capture: ["secure_field", "account_aggregator"] },
  routing_number: { label: "Routing number (ABA)", type: "string", pattern: "^[0-9]{9}$", sensitivity: "personal", capture: ["typed"], countries: ["us"] },
  ifsc: { label: "IFSC", type: "string", pattern: "^[A-Z]{4}0[A-Z0-9]{6}$", sensitivity: "personal", capture: ["typed", "account_aggregator"], countries: ["in"] },
  bank_statement_6m: { label: "Bank statements (6 months)", type: "file", sensitivity: "sensitive", capture: ["account_aggregator", "document_upload"] },
  gst_number: { label: "GSTIN", type: "string", pattern: "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$", sensitivity: "personal", capture: ["typed"], countries: ["in"] },
  business_vintage_months: { label: "Months in business", type: "integer", sensitivity: "personal", capture: ["typed", "derived"] },
  annual_turnover: { label: "Annual turnover", type: "number", sensitivity: "personal", capture: ["typed", "account_aggregator"] },
  nominee_name: { label: "Nominee name", type: "string", sensitivity: "personal", capture: ["typed"] },
  amount: { label: "Amount", type: "number", sensitivity: "public", capture: ["typed"] },
  tenor_months: { label: "Tenor (months)", type: "integer", sensitivity: "public", capture: ["typed"] },
  instalment_amount: { label: "Instalment amount", type: "number", sensitivity: "public", capture: ["typed"] },
  customer_ref: { label: "Your reference for the customer", type: "string", sensitivity: "public", capture: ["derived"] },
  consent_reference: { label: "Consent reference", type: "string", sensitivity: "public", capture: ["derived"] },
};

export const isDataField = (name: string) => Object.prototype.hasOwnProperty.call(DATA_DICTIONARY, name);
