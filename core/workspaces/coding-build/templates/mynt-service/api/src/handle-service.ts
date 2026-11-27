// ============================================================================================================
// THE ONE FUNCTION TO WRITE.
//
// handleService(input) → output: what this service does. Everything around it is done for you
// (vendor-service.ts): by the time this runs, Mynt's signature has been verified and `input` is valid against
// the service type's input schema; whatever this returns is checked against the output schema before it is sent,
// and an output that doesn't fit is never sent.
//
// - `input` holds a customer's data. Never log it, and keep nothing you don't need.
// - Throw a ServiceError to refuse a request you understood but can't serve ("not_found", "unavailable"…).
// - A repeated `request_id` is a replay: answer it the same way, and do the work once.
// - This service calls nobody on a caller's behalf, and never forwards a request to Mynt.
// ============================================================================================================
import type { ServiceContract } from "./vendor-service.js";

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ServiceRequest {
  request_id: string;
  environment: "test" | "live";
  params?: Record<string, unknown>;
  quote?: { quote_id: string };
}

export async function handleService(input: Record<string, unknown>, request: ServiceRequest, contract: ServiceContract): Promise<Record<string, unknown>> {
  void input;
  void request;
  // REPLACE THIS: the contract's example output, so a fresh service answers Mynt's practice and conformance
  // requests with something valid. Compute the real answer from `input` here.
  if (!contract.example_output) throw new ServiceError("not_implemented", "This service isn't implemented yet");
  return contract.example_output;
}
