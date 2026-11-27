import { randomBytes, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inTransaction } from "./db.js";
import { isDirect } from "./freestyle.js";
import type { HostingService } from "./hosting.js";
import { isProduction } from "./promotion-schema.js";
import { effectiveStages } from "./promotions.js";
import { effectiveRoles, type App, type Store, type User } from "./store.js";
import { open, seal, vaultAvailable } from "./vault.js";
import { resolveVendorUrl, type VendorCallOptions } from "./vendor-call.js";
import { appServicePath, vendorOnboarding, type OnboardingStep } from "./vendor-onboarding.js";
import { sandboxOutput } from "./vendor-sandbox.js";
import { conformanceExchange, getOffering, hostedCopy, IN_TESTING_WORDS, inTesting, listingBlockers, rampRefusal, runConformance, serviceType, usageOf, vendorDriftSweep, vendorLicenceGap, type HostedCopy, type Offering, type ServiceType } from "./vendors.js";
import { appRole, createdWorkspaces, isUuid, memberApp, personalWorkspace, workspaceRole } from "./workspaces.js";

// Services: the third kind of thing built on Mynt, beside apps and financial products.
//
// A service is a vendor service its firm builds, verifies and hosts with the same machinery as an app (the builder
// chat, coding agents, builds, hosting, the Idea → Staging → Production stages), and lists in the Marketplace for
// other builders to plug in. It is stored as an app record of kind 'service' (apps.kind, default 'app'), so builds,
// hosting, promotions and workspaces reuse it by id, with exactly one vendor offering made with it (1:1:
// vendor_offerings.app_id), of one admin-defined service type in one region.
//
// What differs from an offering served at a vendor's own endpoint:
//
//  - The endpoint is derived, never typed: the service's hosted address plus /mynt/services/<service type key>. Mynt
//    sets it each time the service is put online.
//  - The service authenticates Mynt by Mynt-Signature alone. Mynt's conformance and live calls go straight to the
//    hosted address with no credential and no app key (the edge adds a hosted app's key only to its own calls out).
//  - The signing secret is the service's own, sealed. Mynt hands it over as a hosted setting
//    (MYNT_VENDOR_SIGNING_SECRET, in the deploy job's environment) and shows it to nobody.
//  - Listing is its stage: Production is listed, and moving back unlists (promotions.ts holds its checks).
//  - Every build that goes online is tested before it serves anyone, and subscribers never wait for that. A first
//    build goes online and Mynt tests it the moment it answers. Every build after it goes online beside the one
//    serving, is tested there, and takes over only if it passes; the serving build answers throughout.
//  - In Staging, once it has passed, builders its firm gives the offering's id to can subscribe and call it in the
//    sandbox only (vendors.ts, inTesting). Production lists it and makes it live-subscribable; they carry over.
//  - Only an owner or admin of its workspace, at its firm, puts a build online or takes the service offline.
//
// Conformance stays Mynt's: it runs from Mynt, outside the service, against the deployed build.

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ...json({ error, ...extra }), isError: true });
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

/** The hosted setting a service reads its vendor signing secret from. */
export const SERVICE_SECRET_ENV = "MYNT_VENDOR_SIGNING_SECRET";
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export { appServicePath };

// ---- the contract a build reads ----

// What a service (or any vendor) implements for a service type: the schemas, the signature rule and fixture requests.
// Nothing here is secret; the build reads it at scaffold time (get_service_type_contract, GET /v1/service_types/<key>/contract,
// job/service-contracts/<key>.json) and keeps a copy in the repository.
export function serviceTypeContract(t: ServiceType) {
  const example = sandboxOutput(t, new Date(0));
  return {
    contract_version: 1,
    service_type: {
      key: t.key,
      region: t.region,
      name: t.name,
      category: t.category,
      description: t.description,
      consent_purpose: t.consent_purpose,
      fills: t.fills,
      vendor_licences: t.vendor_licences,
      subscriber_licences: t.innovator_licences,
      moves_money: t.moves_money,
      quote: t.quote,
      accepts: t.accepts,
    },
    endpoint: {
      method: "POST",
      app_path: appServicePath(t.key),
      note: "A service Mynt hosts answers at app_path on its hosted address. Mynt derives the address; nobody types it. A vendor's own endpoint serves the same contract at <base_url>/v1/<key> instead.",
    },
    signature: {
      header: "Mynt-Signature",
      format: 't=<unix seconds>,v1=<lowercase hex HMAC-SHA256 of "<t>.<raw request body>" with the signing secret>',
      algorithm: "HMAC-SHA256",
      tolerance_seconds: SIGNATURE_TOLERANCE_SECONDS,
      compare: "constant-time",
      refuse_with: 401,
      secret_setting: SERVICE_SECRET_ENV,
      rule: `Verify the signature over the raw body before reading it. Answer 401 to a signature that doesn't verify or a timestamp more than ${SIGNATURE_TOLERANCE_SECONDS} seconds from now. This is the endpoint's only authentication: it needs no app key and no other credential.`,
    },
    request: {
      content_type: "application/json",
      shape: {
        request_id: "string",
        environment: "test | live",
        input: "valid against input_schema",
        ...(t.params_schema ? { params: "valid against params_schema" } : {}),
        ...(t.accepts ? { quote: { quote_id: "string" } } : {}),
        consent: { purpose: t.consent_purpose, artefact_ref: "string", given_at: "ISO 8601" },
      },
      input_schema: t.input_schema,
      params_schema: t.params_schema,
    },
    response: {
      status: 200,
      shape: { request_id: "the same", status: "ok | error", output: "valid against output_schema", error: "null, or { code, message }" },
      output_schema: t.output_schema,
      limits: "Answer within 10 seconds, with at most 256 KiB. Treat a repeated request_id as a replay and answer it once.",
    },
    fixtures: t.fixtures.map((input) => ({ input, ...(t.params_schema ? { params: t.params_fixture ?? {} } : {}) })),
    // An output valid against output_schema, built from the schema alone (what Mynt's practice sandbox answers), when one can be.
    example_output: "output" in example ? example.output : null,
    updated_at: t.updated_at,
  };
}

// ---- the service's endpoint and secret ----

/** Where Mynt calls a service: its hosted address and the fixed path. Null when it has no address. */
export function serviceEndpoint(hosting: Pick<HostingService, "appDomain"> | null, hosted: HostedCopy | null, appId: string, serviceTypeKey: string, opts: VendorCallOptions = {}): string | null {
  // A compose project: the web service's address (it forwards the path to the api), else its first served one. A copy
  // that went online beside another has an address of its own (its tag).
  const tag = hosted?.address_tag ?? null;
  const domain = hosted?.services.length ? (hosted.services.find((x) => x.expose === "web" && x.domain) ?? hosted.services.find((x) => x.domain))?.domain : hosting?.appDomain(appId, "web", tag);
  const origin = opts.appAddress?.(appId, { tag, domain: domain ?? null }) ?? (domain ? `https://${domain}` : null);
  return origin ? `${origin.replace(/\/+$/, "")}${appServicePath(serviceTypeKey)}` : null;
}

const newSecret = () => `mvs_${randomBytes(32).toString("base64url")}`;

/** Why this deployment can't host a service, when it can't (null: it can, or it hosts nothing at all yet). */
export function serviceHostingRefusal(hosting: Pick<HostingService, "enabled" | "provider"> | null): string | null {
  if (!hosting?.enabled || isDirect(hosting.provider)) return null;
  return "This Mynt hosts apps through its gateway (one VM per workspace, behind a tunnel), which can't host a service: a service is a Compose project, its signing secret is handed over as a deploy job's setting, Mynt tests each build the moment it answers, and a new build goes online beside the one serving. The gateway mode runs single-container apps only, from a script fixed when the VM first booted, never reports that a build is running, and has one container per app. Services need Mynt's direct hosting; ask whoever runs this Mynt to turn it on";
}

/** The offering a service was made with (1:1), if `appId` is a service. */
export async function offeringOfService(store: Store, appId: string): Promise<Offering | undefined> {
  if (!isUuid(appId)) return undefined;
  const { rows } = await store.db.query(`SELECT id::text AS id FROM ${T}.vendor_offerings WHERE app_id = $1`, [appId]);
  return rows[0] ? getOffering(store.db, rows[0].id as string) : undefined;
}

/**
 * The settings a deploy hands a service besides Mynt's own: its vendor signing secret. They travel as the deploy job's
 * environment (hosting.ts), never its text, and are scrubbed from anything shown.
 */
export async function serviceSettings(store: Store, appId: string): Promise<Record<string, string>> {
  const o = await offeringOfService(store, appId);
  if (!o || o.app_pause === "stopped" || !vaultAvailable(false)) return {};
  const sealed = (await store.db.query(`SELECT conformance_secret FROM ${T}.vendor_offerings WHERE id = $1`, [o.id])).rows[0]?.conformance_secret as string;
  return { [SERVICE_SECRET_ENV]: open(sealed, false) };
}

/**
 * The service is being put online (deploy_app): its offering now points at the hosted address, is handed the signing
 * secret with this deploy, and comes off (draft: needs conformance) until Mynt's test passes against this build. An
 * admin's suspension stays.
 */
export async function serviceDeployed(store: Store, hosting: HostingService | null, app: Pick<App, "id" | "name">, buildId: string, by: string, opts: VendorCallOptions = {}) {
  const o = await offeringOfService(store, app.id);
  if (!o || o.app_pause === "stopped") return null;
  const hosted = await hostedCopy(store.db, app.id);
  const endpoint = serviceEndpoint(hosting, hosted, app.id, o.service_type, opts);
  const adminSuspended = o.status === "suspended" && !o.app_pause;
  const status: Offering["status"] = adminSuspended ? "suspended" : "draft";
  await store.db.query(
    `UPDATE ${T}.vendor_offerings SET test_base_url = $2, live_base_url = $2, status = $3, status_note = CASE WHEN $4 THEN status_note ELSE NULL END, app_pause = NULL, app_build_id = $5, app_secret_at = now(),
            candidate_id = NULL, candidate_build_id = NULL, candidate_secret = NULL, candidate_at = NULL, updated_at = now()
      WHERE id = $1`,
    [o.id, endpoint, status, adminSuspended, isUuid(buildId) ? buildId : null],
  );
  await store.audit(by, "service_build_online", o.id, { service_id: app.id, build_id: buildId, was: o.status, status, needs_conformance: !adminSuspended });
  if (o.status !== status) await vendorDriftSweep(store, { offering_id: o.id });
  return {
    offering_id: o.id,
    service_type: o.service_type,
    region: o.region,
    status,
    endpoint_path: appServicePath(o.service_type),
    next: adminSuspended
      ? "A Mynt admin suspended this service; it stays suspended"
      : "Mynt runs its conformance test against this build as soon as it answers. A pass puts a Production service back on the Marketplace list; until then nothing calls it",
  };
}

/**
 * Once the build put online answers: Mynt's own conformance test of it, with nobody asking. A pass makes the offering
 * conformance_passed, or listed again when the service is in Production (runConformance); a failure leaves it off.
 */
export async function conformanceAfterDeploy(store: Store, app: Pick<App, "id">, buildId: string, opts: VendorCallOptions = {}) {
  const o = await offeringOfService(store, app.id);
  if (!o || o.status !== "draft" || o.app_pause || !o.test_base_url || o.app_build_id !== buildId) return null;
  const hosted = await hostedCopy(store.db, app.id);
  if (hosted?.status !== "running" || hosted.build_id !== buildId) return null;
  const t = await serviceType(store.db, o.region, o.service_type);
  if (!t) return null;
  const result = await runConformance(store, o, t, opts, null);
  await store.audit(null, "service_conformance_after_deploy", o.id, { service_id: app.id, build_id: buildId, passed: result.passed, status: result.status });
  if (result.status !== o.status) await vendorDriftSweep(store, { offering_id: o.id });
  return result;
}

/**
 * Why this person may not put a build of the service online or take it offline; null when they may. A build put
 * online is handed the signing secret and, once it passes, receives subscribers' requests, and taking the service
 * offline stops every subscriber's calls: so only an owner or admin of its workspace, at the firm that offers it
 * (the same people who archive it). Being a member of the workspace is not enough.
 */
export async function serviceOperatorRefusal(store: Store, user: User, app: App): Promise<string | null> {
  if (app.kind !== "service") return null;
  const me = (await store.getUser(user.id)) ?? user;
  const o = await offeringOfService(store, app.id);
  if (!o) return null;
  const role = await appRole(store, me, app);
  if (role !== "owner" && role !== "admin") return "Only the workspace's owners and admins put a service online or take it offline: its builds receive subscribers' requests";
  if (o.entity_id !== me.entity_id) return "That service is offered by another firm: only its own people put it online or take it offline";
  return null;
}

// ---- a new build beside the one serving ----
//
// While a build serves subscribers (its offering has passed Mynt's test and isn't suspended), the next build put online
// doesn't replace it. It goes online as a second copy, on a VM and at an address of its own (hosting.ts,
// deployCandidate), and Mynt tests it there. The offering keeps its endpoint, its secret, its status and its place in
// the Marketplace throughout. Only when the new build passes (and, for a service in Production, meets every other
// check a promotion to Production runs) does Mynt switch: the endpoint, the secret and the hosted copy change in one
// transaction, and the copy that served until then is removed once calls in flight to it have had time to finish. A
// build that fails, or doesn't start, is removed; the one serving never noticed, and the failure is kept to be shown.
//
// The signing secret: the new copy gets a new one of its own, not the serving copy's. That is the safer of the two.
// Code Mynt hasn't tested yet never holds the secret that authenticates calls to the build subscribers rely on, so a
// build that leaks its settings can't be used to forge requests to the serving one; and each build's secret dies with
// it. It costs nothing in availability because the endpoint and the secret are stored, switched and read together
// (vendors.ts, servedAt). It reaches the copy the same way as ever: a hosted setting in the deploy job's environment,
// never returned, scrubbed from output.

/** Whether a build is serving subscribers right now, so the next one must go online beside it rather than in its place. */
export async function servingOffering(store: Store, appId: string): Promise<Offering | null> {
  const o = await offeringOfService(store, appId);
  if (!o || o.app_pause || !o.test_base_url || (o.status !== "conformance_passed" && o.status !== "listed")) return null;
  const hosted = await hostedCopy(store.db, appId);
  return hosted?.status === "running" && hosted.build_id === o.app_build_id ? o : null;
}

/** A new secret for the copy about to go online beside the serving one: the hosted setting, and its sealed form to keep until the switch. */
export function candidateSettings(): { settings: Record<string, string>; sealed: string } {
  const secret = newSecret();
  return { settings: { [SERVICE_SECRET_ENV]: secret }, sealed: seal(secret, false) };
}

/** The new build is going online beside the one serving: recorded on the offering, which is otherwise unchanged. */
export async function serviceBuildBeside(store: Store, app: Pick<App, "id">, o: Offering, candidateId: string, buildId: string, sealedSecret: string, by: string) {
  // Which copy, which build and its secret in one statement: a test of an earlier copy can't clear half of it.
  await store.db.query(`UPDATE ${T}.vendor_offerings SET candidate_id = $2, candidate_build_id = $3, candidate_secret = $4, candidate_at = now(), updated_at = now() WHERE id = $1`, [o.id, candidateId, buildId, sealedSecret]);
  await store.audit(by, "service_build_beside", o.id, { service_id: app.id, build_id: buildId, serving_build_id: o.app_build_id, status: o.status });
  return {
    offering_id: o.id,
    service_type: o.service_type,
    region: o.region,
    status: o.status,
    serving_build_id: o.app_build_id,
    testing_build_id: buildId,
    endpoint_path: appServicePath(o.service_type),
    next: `Build ${(o.app_build_id ?? "").slice(0, 8)} keeps serving${o.status === "listed" ? " and stays listed" : ""} while Mynt tests this build beside it. Mynt switches to this build only if it passes; if it doesn't, it is removed and nothing changes for subscribers`,
  };
}

const clearCandidate = (store: Store, offeringId: string, candidateId: string) =>
  store.db.query(`UPDATE ${T}.vendor_offerings SET candidate_id = NULL, candidate_build_id = NULL, candidate_secret = NULL, candidate_at = NULL, updated_at = now() WHERE id = $1 AND candidate_id = $2`, [offeringId, candidateId]);

/**
 * Once the new build's copy answers (or didn't start): Mynt's conformance test of it, at its own address, signed with
 * its own secret, with nobody asking. A pass that also meets the production checks switches the offering to it. Anything
 * else removes the copy and leaves the offering exactly as it was.
 */
export async function testCandidate(store: Store, hosting: HostingService, app: Pick<App, "id">, candidateId: string, opts: VendorCallOptions = {}) {
  const o = await offeringOfService(store, app.id);
  // A newer build took its place, or the service went offline or was archived meanwhile: nothing to do.
  if (!o || o.candidate_id !== candidateId) return null;
  const copy = await hosting.candidate(candidateId);
  const buildId = copy?.build_id ?? o.candidate_build_id ?? "";
  const notSwitched = async (reason: string, run?: { passed: boolean; cases: unknown; transcript: unknown }) => {
    const runId = randomUUID();
    await store.db.query(`INSERT INTO ${T}.vendor_candidate_runs (id, offering_id, build_id, candidate_id, passed, reason, cases, transcript) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
      runId,
      o.id,
      buildId,
      candidateId,
      run?.passed ?? false,
      reason,
      JSON.stringify(run?.cases ?? []),
      run ? JSON.stringify(run.transcript) : null,
    ]);
    await hosting.dropCandidate(app.id, reason, "failed");
    await clearCandidate(store, o.id, candidateId);
    await store.audit(null, "service_build_not_switched", o.id, { service_id: app.id, build_id: buildId, serving_build_id: o.app_build_id, passed: run?.passed ?? false, reason, run_id: runId });
    return { switched: false as const, passed: run?.passed ?? false, reason, run_id: runId, status: o.status, serving_build_id: o.app_build_id };
  };
  if (!copy || copy.status !== "running") return notSwitched(copy?.status === "failed" ? "The build didn't start on Mynt's hosting, so there was nothing to test" : "The build's copy was removed before Mynt could test it");
  const t = await serviceType(store.db, o.region, o.service_type);
  const sealed = (await store.db.query(`SELECT candidate_secret FROM ${T}.vendor_offerings WHERE id = $1 AND candidate_id = $2`, [o.id, candidateId])).rows[0]?.candidate_secret as string | null | undefined;
  const endpoint = serviceEndpoint(hosting, { status: "running", build_id: copy.build_id, error: null, services: copy.services ?? [], address_tag: copy.address_tag }, app.id, o.service_type, opts);
  if (!t || !sealed || !endpoint) return notSwitched("Mynt couldn't address the build's copy to test it");
  const run = await conformanceExchange(store, o, t, opts, null, { base_url: endpoint, secret: open(sealed, false) });
  if (!run.passed) return notSwitched("Mynt's conformance test failed on it", run);
  // Passing conformance is not enough for a service in Production: the build must meet the other checks too.
  const production = await isProduction(store.db, app.id);
  const blockers = production ? await listingBlockers(store, app.id, copy.build_id) : [];
  if (blockers.length) return notSwitched(`It passed Mynt's conformance test, but a service in Production also needs: ${blockers.join("; ")}`, run);
  const runId = randomUUID();
  const status: Offering["status"] = production ? "listed" : "conformance_passed";
  const switched = await hosting.promoteCandidate(candidateId, async (tx) => {
    // The endpoint, the secret and the hosted copy change together, or not at all.
    const moved = await tx.query(
      `UPDATE ${T}.vendor_offerings SET test_base_url = $3, live_base_url = $3, conformance_secret = candidate_secret, app_build_id = $4, app_secret_at = now(), status = $5,
              candidate_id = NULL, candidate_build_id = NULL, candidate_secret = NULL, candidate_at = NULL, updated_at = now()
        WHERE id = $1 AND candidate_id = $2 AND candidate_secret IS NOT NULL AND app_pause IS NULL AND status IN ('conformance_passed', 'listed') RETURNING id`,
      [o.id, candidateId, endpoint, copy.build_id, status],
    );
    if (!moved.rows.length) throw new NothingToSwitch();
    await tx.query(`INSERT INTO ${T}.vendor_conformance_runs (id, offering_id, passed, cases, run_by, transcript, build_id) VALUES ($1, $2, true, $3, NULL, $4, $5)`, [runId, o.id, JSON.stringify(run.cases), JSON.stringify(run.transcript), copy.build_id]);
  }).catch((e) => {
    if (e instanceof NothingToSwitch) return null;
    throw e;
  });
  if (!switched) return notSwitched("It passed Mynt's conformance test, but the service was suspended, archived or taken offline meanwhile, so nothing was switched", run);
  await store.audit(null, "service_build_switched", o.id, { service_id: app.id, build_id: copy.build_id, was_build_id: o.app_build_id, passed: true, status, run_id: runId });
  if (status !== o.status) await vendorDriftSweep(store, { offering_id: o.id });
  return { switched: true as const, passed: true, run_id: runId, status, serving_build_id: copy.build_id };
}
class NothingToSwitch extends Error {}

/** The service went offline (undeploy_app): its offering is suspended, with a plain reason, until it is back. */
export async function serviceOffline(store: Store, app: Pick<App, "id" | "name">, by: string) {
  const o = await offeringOfService(store, app.id);
  if (o?.candidate_id) await clearCandidate(store, o.id, o.candidate_id);
  if (!o || o.app_pause || o.status === "suspended") return null;
  const note = `${app.name} isn't online. Put it online again; Mynt then tests it and it comes back.`;
  await store.db.query(`UPDATE ${T}.vendor_offerings SET status = 'suspended', status_note = $2, app_pause = 'offline', updated_at = now() WHERE id = $1`, [o.id, note]);
  await store.audit(by, "service_offline", o.id, { service_id: app.id, was: o.status });
  return { offering_id: o.id, service_type: o.service_type, region: o.region, was: o.status, drifted_products: await vendorDriftSweep(store, { offering_id: o.id }) };
}

// ---- reading a service ----

const STATUS_WORDS: Record<Offering["status"], string> = { draft: "Needs conformance", conformance_passed: "Conformance passed", listed: "Listed in the Marketplace", suspended: "Suspended by Mynt" };
const statusWords = (o: Pick<Offering, "status" | "app_pause">) => (o.app_pause === "offline" ? "Off: not online" : o.app_pause === "stopped" ? "Archived" : STATUS_WORDS[o.status]);

const roleStep = (has: boolean, firm: string | null): OnboardingStep => ({
  key: "vendor_role",
  title: "Vendor role",
  status: has && firm ? "done" : "blocked",
  detail: has && firm ? `You hold the vendor role at ${firm}.` : has ? "You hold the vendor role, but not at this service's firm. Ask a Mynt admin to add you to it." : "Ask a Mynt admin for the vendor role.",
  tool: "invite_user",
  by: "admin",
  informational: false,
  facts: { vendor_role: has, firm },
});

type Field = { field: string; type: string; required: boolean; description: string };
// A JSON Schema object's properties as rows: Field, Type, Required, Description. Required fields first, in the order
// the schema requires them (a stored schema keeps no order of its own).
export function schemaFields(schema: Record<string, unknown> | null): Field[] {
  const props = ((schema?.properties ?? {}) as Record<string, Record<string, unknown>>) ?? {};
  const order = (schema?.required as string[] | undefined) ?? [];
  const required = new Set(order);
  const rank = (f: string) => (required.has(f) ? order.indexOf(f) : order.length);
  const entries = Object.entries(props).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  return entries.map(([field, p]) => {
    const kind = Array.isArray(p.type) ? p.type.join(" or ") : typeof p.type === "string" ? p.type : "enum" in p ? "one of" : "const" in p ? "fixed" : "any";
    const detail = [typeof p.format === "string" ? p.format : null, Array.isArray(p.enum) ? p.enum.map(String).join(" | ") : null, "const" in p ? String(p.const) : null, typeof p.pattern === "string" ? `matches ${p.pattern}` : null].filter(Boolean);
    return { field, type: detail.length ? `${kind} (${detail.join("; ")})` : kind, required: required.has(field), description: typeof p.description === "string" ? p.description : "" };
  });
}

const measured = (v: number | null, why: string) => (v == null ? { value: null, not_measured: why } : { value: v });

// Calls, error rate and response time from Mynt's own records of calls to the service. What Mynt doesn't record is
// null with the reason, never 0.
async function reliabilityOf(store: Store, o: Offering, days: number) {
  const subs = (await store.db.query(`SELECT id::text AS id FROM ${T}.vendor_subscriptions WHERE offering_id = $1`, [o.id])).rows.map((r) => r.id as string);
  const usage = await usageOf(store.db, subs, days);
  const byDay = new Map<string, { day: string; environment: "test" | "live"; calls: number; errors: number }>();
  for (const u of usage) {
    const k = `${u.day} ${u.environment}`;
    const row = byDay.get(k) ?? { day: u.day, environment: u.environment, calls: 0, errors: 0 };
    row.calls += u.ok + u.errors;
    row.errors += u.errors;
    byDay.set(k, row);
  }
  const rows = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.environment.localeCompare(b.environment)));
  const calls = rows.reduce((n, r) => n + r.calls, 0);
  const errors = rows.reduce((n, r) => n + r.errors, 0);
  const noCalls = subs.length ? `No subscriber called it in the last ${days} days` : "Nobody subscribes yet, so nothing has called it";
  // Response times: Mynt times its own conformance requests; it keeps no timing of subscribers' calls.
  const run = (await store.db.query(`SELECT cases, created_at FROM ${T}.vendor_conformance_runs WHERE offering_id = $1 ORDER BY created_at DESC LIMIT 1`, [o.id])).rows[0];
  const timed = ((run?.cases as { case: string; latency_ms: number; http_status: number | null }[] | undefined) ?? []).filter((c) => c.case.startsWith("fixture_") && c.http_status != null).map((c) => c.latency_ms);
  const incidents = (
    await store.db.query(
      `SELECT a.action, a.details, a.created_at FROM ${T}.audit_log a
        WHERE a.target = $1 AND (a.action IN ('service_offline', 'suspend_vendor_offering', 'archive_service', 'service_build_not_switched') OR (a.action IN ('run_conformance', 'admin_run_conformance', 'service_conformance_after_deploy') AND a.details->>'passed' = 'false'))
          AND a.created_at > now() - make_interval(days => $2::int) ORDER BY a.created_at DESC LIMIT 50`,
      [o.id, days],
    )
  ).rows.map((r) => ({
    at: iso(r.created_at),
    kind: r.action as string,
    what:
      r.action === "service_build_not_switched"
        ? `A new build (${String((r.details as { build_id?: string })?.build_id ?? "").slice(0, 8)}) didn't take over: ${String((r.details as { reason?: string })?.reason ?? "it wasn't switched to")}. The serving build kept serving`
        : r.action === "service_offline"
        ? "The service went offline; its offering was suspended until it came back"
        : r.action === "suspend_vendor_offering"
          ? (r.details as { suspended?: boolean })?.suspended === false
            ? "A Mynt admin lifted its suspension"
            : "A Mynt admin suspended the offering"
          : r.action === "archive_service"
            ? (r.details as { archived?: boolean })?.archived === false
              ? "The service was restored"
              : "The service was archived"
            : "Mynt's conformance test failed",
  }));
  return {
    window_days: days,
    calls: measured(calls > 0 ? calls : null, noCalls),
    error_rate: measured(calls > 0 ? errors / calls : null, noCalls),
    response_time_ms: {
      ...measured(null, "Mynt doesn't record how long each subscriber's call took, only whether it succeeded"),
      in_last_conformance_run: timed.length ? { median: [...timed].sort((a, b) => a - b)[Math.floor(timed.length / 2)], max: Math.max(...timed), requests: timed.length, at: iso(run.created_at) } : null,
    },
    by_day: rows.map((r) => ({ ...r, error_rate: r.calls ? r.errors / r.calls : null })),
    incidents,
  };
}

const ACTIVITY: Record<string, string> = {
  create_service: "Service created",
  start_build: "Build started",
  deploy_app: "Put online",
  undeploy_app: "Taken offline",
  app_promoted: "Moved up a stage",
  app_demoted: "Moved back a stage",
  service_build_online: "A new build went online: conformance needed",
  service_conformance_after_deploy: "Mynt tested the new build",
  service_build_beside: "A new build went online beside the serving one",
  service_build_switched: "Mynt switched to the new build",
  service_build_not_switched: "The new build was removed: the serving build kept serving",
  service_offline: "Offering suspended: the service isn't online",
  run_conformance: "Conformance run",
  admin_run_conformance: "Conformance run by a Mynt admin",
  run_practice_conformance: "Practice run",
  admin_run_practice_conformance: "Practice run by a Mynt admin",
  set_vendor_terms: "Standard terms set",
  update_vendor_offering: "Offering changed",
  admin_update_vendor_offering: "Offering changed by a Mynt admin",
  suspend_vendor_offering: "Suspension changed by a Mynt admin",
  archive_service: "Archived or restored",
};
async function activityOf(store: Store, appId: string, offeringId: string) {
  const { rows } = await store.db.query(
    `SELECT a.action, a.target, a.details, a.created_at, u.name AS actor FROM ${T}.audit_log a LEFT JOIN ${T}.users u ON u.id = a.actor_id
      WHERE (a.target = $1 OR a.target = $2 OR (a.action = 'start_build' AND a.details->>'app_id' = $1)) AND a.action = ANY($3) ORDER BY a.created_at DESC LIMIT 100`,
    [appId, offeringId, Object.keys(ACTIVITY)],
  );
  return rows.map((r) => {
    const d = (r.details ?? {}) as Record<string, unknown>;
    const build = typeof d.build_id === "string" ? `Build ${d.build_id.slice(0, 8)}` : "The build";
    const detail =
      r.action === "service_build_beside"
        ? `${build} went online beside build ${String(d.serving_build_id ?? "").slice(0, 8)}, which kept serving`
        : r.action === "service_build_switched"
          ? `${build} passed and now serves`
          : r.action === "service_build_not_switched"
            ? `${build}: ${String(d.reason ?? "not switched to")}. Build ${String(d.serving_build_id ?? "").slice(0, 8)} kept serving`
            : "passed" in d
        ? d.passed
          ? "Passed"
          : "Failed"
        : typeof d.to_stage === "string"
          ? `${String(d.from_stage)} to ${d.to_stage}`
          : typeof d.version === "number"
            ? `Version ${d.version}`
            : r.action === "archive_service"
              ? d.archived === false
                ? "Restored"
                : "Archived"
              : typeof d.build_id === "string"
                ? `Build ${d.build_id.slice(0, 8)}`
                : r.action === "start_build"
                  ? `Build ${String(r.target).slice(0, 8)}`
                  : "";
    const mynts = ["service_conformance_after_deploy", "service_build_switched", "service_build_not_switched"];
    return { at: iso(r.created_at), action: r.action as string, what: ACTIVITY[r.action as string], detail, by: (r.actor as string | null) ?? (mynts.includes(r.action as string) ? "Mynt" : null) };
  });
}

/** One service, whole: for its workspace in the Studio (get_service). */
export async function serviceView(store: Store, hosting: HostingService | null, user: User, app: App, opts: { days?: number } = {}) {
  const me = (await store.getUser(user.id)) ?? user;
  const vendor = effectiveRoles(me.roles).includes("vendor");
  const o = await offeringOfService(store, app.id);
  if (!o) return null;
  const t = await serviceType(store.db, o.region, o.service_type);
  const firm = (await store.getEntity(o.entity_id)) ?? null;
  const stage = (await effectiveStages(store.db, [app])).get(app.id) ?? "idea";
  const hosted = await hostedCopy(store.db, app.id);
  const address = serviceEndpoint(hosting, hosted, app.id, o.service_type);
  const onboarding = await vendorOnboarding(store, o.entity_id, { offering_id: o.id, history: true });
  const steps = [roleStep(vendor, me.entity_id === o.entity_id ? (firm?.name ?? null) : null), ...(onboarding.offerings[0]?.steps ?? []).filter((s) => s.key !== "service_created" && s.key !== "first_subscriber")];
  const counted = steps.filter((s) => !s.informational);
  const history = (onboarding.history?.[0] ?? {}) as { conformance_runs?: Record<string, unknown>[]; practice_runs?: Record<string, unknown>[]; terms_versions?: Record<string, unknown>[] };
  // Each run's cases and its transcript: what Mynt sent and what came back, kept redacted (the checklist keeps only a
  // run's failures). A run from before transcripts were kept has none, and says so rather than showing an empty one.
  type Detail = { cases: unknown; passed_cases: number; total_cases: number; transcript: unknown; transcript_note?: string; build_id?: string | null };
  const detail = (r: Record<string, unknown>): Detail => {
    const cases = (r.cases as { passed: boolean }[] | null) ?? [];
    return {
      cases,
      passed_cases: cases.filter((c) => c.passed).length,
      total_cases: cases.length,
      transcript: r.transcript ?? null,
      ...(r.transcript ? {} : { transcript_note: "Not recorded: this run is from before Mynt kept transcripts" }),
    };
  };
  const runCases = new Map<string, Detail>();
  for (const r of (await store.db.query(`SELECT id::text AS id, cases, transcript, build_id::text AS build_id FROM ${T}.vendor_conformance_runs WHERE offering_id = $1 ORDER BY created_at DESC LIMIT 20`, [o.id])).rows)
    runCases.set(r.id as string, { ...detail(r), build_id: (r.build_id as string | null) ?? null });
  const practiceCases = new Map<string, Detail>();
  for (const r of (await store.db.query(`SELECT id::text AS id, cases, transcript FROM ${T}.vendor_practice_runs WHERE offering_id = $1 ORDER BY created_at DESC LIMIT 20`, [o.id])).rows) practiceCases.set(r.id as string, detail(r));
  // Mynt's tests of new builds that did not take over: shown beside the others, plainly as what they are.
  const notSwitched = (await store.db.query(`SELECT * FROM ${T}.vendor_candidate_runs WHERE offering_id = $1 ORDER BY created_at DESC LIMIT 20`, [o.id])).rows.map((r) => ({
    run_id: r.id as string,
    kind: "conformance" as const,
    passed: r.passed === true,
    at: iso(r.created_at),
    run_by: null,
    failures: ((r.cases as { case: string; passed: boolean; problems: string[] }[] | null) ?? []).filter((c) => !c.passed).map((c) => ({ case: c.case, problems: c.problems ?? [] })),
    ...detail(r),
    ...(r.transcript ? {} : { transcript_note: "Nothing was sent: the build never answered, so there was nothing to test" }),
    build_id: String(r.build_id),
    new_build: true as const,
    switched: false as const,
    outcome: `${r.reason as string}. It was removed; the build that was serving kept serving`,
  }));
  // The build online beside the serving one right now, if any.
  const beside = o.candidate_id && hosting ? await hosting.candidate(o.candidate_id) : undefined;
  // Who subscribes, and the firm's own onboarding steps, are the offering firm's (and Mynt's admins'): a member of the
  // workspace from another firm reads the service, not the firm's customers.
  const own = me.entity_id === o.entity_id || effectiveRoles(me.roles).includes("admin");
  const subscribers = (
    await store.db.query(
      `SELECT s.id::text AS subscription_id, e.name AS firm, s.live, s.status, s.created_at, a.id::text AS agreement_id, a.status AS agreement_status, a.terms_version, p.name AS app_name
         FROM ${T}.vendor_subscriptions s JOIN ${T}.entities e ON e.id = s.entity_id
         LEFT JOIN ${T}.app_agreements a ON a.vendor_subscription_id = s.id LEFT JOIN ${T}.apps p ON p.id = a.app_id
        WHERE s.offering_id = $1 ORDER BY s.created_at, a.created_at`,
      [o.id],
    )
  ).rows.map((r) => ({
    subscription_id: r.subscription_id as string,
    firm: r.firm as string,
    app: (r.app_name as string | null) ?? null,
    terms_version: (r.terms_version as number | null) ?? null,
    since: iso(r.created_at),
    environment: r.live ? "Live" : "Sandbox",
    subscription_status: r.status as string,
    agreement_id: (r.agreement_id as string | null) ?? null,
    agreement_status: (r.agreement_status as string | null) ?? null,
  }));
  const contract = t ? serviceTypeContract(t) : null;
  return {
    id: app.id,
    kind: "service" as const,
    name: app.name,
    description: app.description,
    workspace_id: app.workspace_id,
    workspace_role: await appRole(store, me, app),
    stage,
    archived: o.app_pause === "stopped",
    firm: firm ? { id: firm.id, name: firm.name } : null,
    vendor_role: vendor,
    service_type: { key: o.service_type, name: t?.name ?? o.service_type, region: o.region, category: t?.category ?? null, description: t?.description ?? "" },
    offering: {
      id: o.id,
      name: o.name,
      status: o.status,
      status_words: statusWords(o),
      status_note: o.status_note,
      price: o.price,
      sla_notes: o.sla_notes,
      licence_ids: o.licence_ids,
      terms: o.terms,
      build_id: o.app_build_id,
    },
    hosted: hosted ? { status: hosted.status, online: hosted.status === "running", build_id: hosted.build_id, address: address ? new URL(address).origin : null } : null,
    // A new build online beside the serving one, until Mynt has tested it: the serving build answers meanwhile.
    new_build:
      o.candidate_id && o.candidate_build_id
        ? {
            build_id: o.candidate_build_id,
            status: beside?.status === "running" ? ("testing" as const) : ("going_online" as const),
            status_words: beside?.status === "running" ? "Being tested by Mynt" : "Going online beside the serving build",
            serving_build_id: o.app_build_id,
            note: "The serving build keeps answering. Mynt switches to this build only if it passes; otherwise it is removed.",
          }
        : null,
    // Open to sandbox testing: in Staging with a passed build. Never in the Marketplace list; by this id only.
    testing: (await inTesting(store.db, o))
      ? { open: true as const, offering_id: o.id, words: IN_TESTING_WORDS, how: "Give this offering id to a builder who should test it: they subscribe with it (subscribe_vendor_service) and call the service in the sandbox only. Moving the service to Production lists it; their subscriptions carry over and can then be turned live." }
      : { open: false as const, offering_id: o.id, words: stage === "production" ? "Listed services are subscribed to from the Marketplace" : "Opens once the service is in Staging and a build has passed Mynt's conformance test" },
    contract: contract && {
      ...contract,
      // The endpoint in full once the service has an address; the path alone before.
      endpoint: { ...contract.endpoint, address: hosted ? address : null },
      input_fields: schemaFields(t!.input_schema),
      params_fields: schemaFields(t!.params_schema),
      output_fields: schemaFields(t!.output_schema),
    },
    conformance: {
      runs: [
        ...(history.conformance_runs ?? []).map((r) => ({ ...r, kind: "conformance" as const, ...(runCases.get(r.run_id as string) ?? {}) })),
        ...notSwitched,
        ...(history.practice_runs ?? []).map((r) => ({ ...r, kind: "practice" as const, ...(practiceCases.get(r.run_id as string) ?? {}) })),
      ].sort((a, b) => String((b as { at?: string }).at ?? "").localeCompare(String((a as { at?: string }).at ?? ""))),
      needed: o.status === "draft",
      // The build the passing test ran against (the one online), while it stands.
      tested_build_id: o.status === "conformance_passed" || o.status === "listed" ? o.app_build_id : null,
    },
    terms: { current: o.terms, versions: history.terms_versions ?? [] },
    ...(own
      ? { subscribers, checklist: steps, progress: { done: counted.filter((s) => s.status === "done").length, total: counted.length } }
      : { subscribers: null, checklist: [], progress: { done: 0, total: 0 }, firm_only: `Who subscribes and what is left to list it are shown to ${firm?.name ?? "the offering firm"}'s people only` }),
    reliability: await reliabilityOf(store, o, opts.days ?? 30),
    activity: await activityOf(store, app.id, o.id),
  };
}

// ---- tools ----

const Key = z.string().regex(/^[a-z][a-z0-9_]*$/, "Use a lowercase key like 'identity_verification'").max(60);
const Region = z.string().regex(/^[A-Z]{2}$/);

/** The contract, a service's own workspace, and asking Mynt for a service type: for builders and vendors. */
export function registerServiceTools(server: McpServer, store: Store, user: User, hosting: HostingService | null = null) {
  server.registerTool(
    "get_service_type_contract",
    {
      title: "A standard service's contract",
      description:
        "Builder or vendor: everything an endpoint for one standard service type implements, as one JSON document to keep beside the code: the input, params and output JSON Schemas, the Mynt-Signature rule (HMAC-SHA256 over '<t>.<raw body>', 300 seconds' tolerance, 401 otherwise), the request and response shapes, fixture requests valid against the input schema, an example output, and the path a service Mynt hosts answers at (/mynt/services/<key>). Nothing in it is secret. A build reads the same document at GET /v1/service_types/<key>/contract?region=<region> with its key, and in job/service-contracts/.",
      inputSchema: { key: Key, region: Region },
      annotations: { readOnlyHint: true },
    },
    async ({ key, region }) => {
      const t = await serviceType(store.db, region, key);
      if (!t) return fail(`No service type '${key}' in ${region}; see list_service_types, or ask Mynt for a new one with request_service_type`);
      return json(serviceTypeContract(t));
    },
  );

  server.registerTool(
    "get_service",
    {
      title: "A service you build on Mynt",
      description:
        "Builder (any member of the service's workspace): one service, whole. Its stage (idea, staging, or production, which is listed in the Marketplace), its service type's contract (the input and output as field tables, the endpoint Mynt derives, the signing rule, fixtures), its conformance and practice runs with their cases and each run's transcript (the requests Mynt sent and the answers, with the signature's digest, the signing secret and any credential left out), a new build online beside the serving one while Mynt tests it (new_build) and the builds that didn't take over, whether builders can test it in the sandbox by its offering id (testing), its standard terms versions, the firms and apps subscribed with their agreements and the checklist (for the offering firm's own people; null for a workspace member from another firm), reliability from Mynt's own records of calls (calls, error rate and incidents per day; a figure Mynt doesn't record is null with the reason, never 0), its activity, and the ordered checklist of what is left. It only reads.",
      inputSchema: { service_id: z.string(), days: z.number().int().min(1).max(90).default(30).describe("The reliability window") },
      annotations: { readOnlyHint: true },
    },
    async ({ service_id, days }) => {
      const app = await memberApp(store, user, service_id);
      const view = app?.kind === "service" ? await serviceView(store, hosting, user, app, { days }) : null;
      if (!view) return fail(`No service of yours with id '${service_id}'`);
      return json(view);
    },
  );

  server.registerTool(
    "list_my_services",
    {
      title: "Services you build on Mynt",
      description:
        "Builder: the services of every workspace you belong to (or of one, with workspace_id), each with its stage (idea, staging, production), its service type and region, its offering's status in words, whether it is online and whether it is archived. A service is the third kind of thing built on Mynt, beside apps and financial products: create_service starts one.",
      inputSchema: { workspace_id: z.string().optional().describe("Only this workspace's services") },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => {
      if (workspace_id && !(await workspaceRole(store.db, workspace_id, user.id))) return fail(`No workspace of yours with id '${workspace_id}'`);
      const apps = (await store.appsVisibleTo(user.id, workspace_id)).filter((a) => a.kind === "service");
      const stages = await effectiveStages(store.db, apps);
      const out = [];
      for (const app of apps) {
        const o = await offeringOfService(store, app.id);
        if (!o) continue;
        const t = await serviceType(store.db, o.region, o.service_type);
        const hosted = await hostedCopy(store.db, app.id);
        out.push({
          id: app.id,
          kind: "service" as const,
          name: app.name,
          description: app.description,
          workspace_id: app.workspace_id,
          stage: stages.get(app.id) ?? "idea",
          archived: o.app_pause === "stopped",
          service_type: { key: o.service_type, name: t?.name ?? o.service_type, region: o.region },
          offering_id: o.id,
          offering_status: o.status,
          status_words: statusWords(o),
          online: hosted?.status === "running",
          created_at: app.created_at,
          updated_at: app.updated_at,
        });
      }
      return json(out);
    },
  );

  server.registerTool(
    "request_service_type",
    {
      title: "Ask Mynt for a new standard service",
      description:
        "Builder or vendor: ask Mynt's admins to define a standard service type that doesn't exist yet (service types stay admin-defined: list_service_types). Say what it is called, what it does, and give one example input and one example output as JSON objects. An admin defines it from your request or declines with a reason; list_service_type_requests shows where it stands.",
      inputSchema: {
        name: z.string().trim().min(3).max(120),
        what_it_does: z.string().trim().min(10).max(2000),
        example_input: z.record(z.string(), z.unknown()),
        example_output: z.record(z.string(), z.unknown()),
        region: Region.default("US"),
      },
    },
    async ({ name, what_it_does, example_input, example_output, region }) => {
      if (JSON.stringify(example_input).length > 8000 || JSON.stringify(example_output).length > 8000) return fail("Keep each example under 8 KB: one small JSON object for the input and one for the output");
      const me = (await store.getUser(user.id)) ?? user;
      const waiting = (await store.db.query(`SELECT count(*)::int AS n FROM ${T}.service_type_requests WHERE requested_by = $1 AND status = 'requested'`, [me.id])).rows[0];
      if (Number(waiting?.n ?? 0) >= 10) return fail("You have 10 requests waiting for Mynt already; wait for an answer before asking for more");
      const id = randomUUID();
      await store.db.query(
        `INSERT INTO ${T}.service_type_requests (id, requested_by, entity_id, region, name, what_it_does, example_input, example_output) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, me.id, me.entity_id ?? null, region, name, what_it_does, JSON.stringify(example_input), JSON.stringify(example_output)],
      );
      await store.audit(me.id, "request_service_type", id, { name, region });
      return json({ ...(await requestsOf(store, { id }))[0], next: "A Mynt admin defines it or declines; see list_service_type_requests" });
    },
  );

  registerServiceTypeRequestList(server, store, user);
}

type RequestRow = {
  id: string;
  name: string;
  region: string;
  what_it_does: string;
  example_input: unknown;
  example_output: unknown;
  status: "requested" | "defined" | "declined";
  status_words: string;
  decision_note: string | null;
  service_type_key: string | null;
  requested_by: { id: string; name: string | null };
  firm: { id: string; name: string | null } | null;
  requested_at: string | null;
  decided_at: string | null;
};
const REQUEST_WORDS = { requested: "Waiting for Mynt", defined: "Defined", declined: "Declined" } as const;

export async function requestsOf(store: Store, f: { id?: string; requested_by?: string; entity_id?: string | null; status?: string } = {}): Promise<RequestRow[]> {
  const { rows } = await store.db.query(
    `SELECT r.*, u.name AS requester_name, e.name AS firm_name FROM ${T}.service_type_requests r
       LEFT JOIN ${T}.users u ON u.id = r.requested_by LEFT JOIN ${T}.entities e ON e.id = r.entity_id
      WHERE ($1::text IS NULL OR r.id::text = $1) AND ($2::text IS NULL OR r.requested_by::text = $2 OR ($3::text IS NOT NULL AND r.entity_id::text = $3)) AND ($4::text IS NULL OR r.status = $4)
      ORDER BY r.created_at DESC, r.id`,
    [f.id ?? null, f.requested_by ?? null, f.entity_id ?? null, f.status ?? null],
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    region: r.region as string,
    what_it_does: r.what_it_does as string,
    example_input: r.example_input,
    example_output: r.example_output,
    status: r.status as RequestRow["status"],
    status_words: REQUEST_WORDS[r.status as RequestRow["status"]],
    decision_note: (r.decision_note as string | null) ?? null,
    service_type_key: (r.service_type_key as string | null) ?? null,
    requested_by: { id: r.requested_by as string, name: (r.requester_name as string | null) ?? null },
    firm: r.entity_id ? { id: r.entity_id as string, name: (r.firm_name as string | null) ?? null } : null,
    requested_at: iso(r.created_at),
    decided_at: iso(r.decided_at),
  }));
}

function registerServiceTypeRequestList(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "list_service_type_requests",
    {
      title: "Requested standard services",
      description:
        "The standard service types people asked Mynt to define (request_service_type), newest first, each with its status: waiting for Mynt, defined (with the service type's key) or declined (with the reason). Builders and vendors see their own and their firm's; Mynt admins see everyone's.",
      inputSchema: { status: z.enum(["requested", "defined", "declined"]).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      const me = (await store.getUser(user.id)) ?? user;
      const admin = effectiveRoles(me.roles).includes("admin");
      return json(await requestsOf(store, admin ? { status } : { requested_by: me.id, entity_id: me.entity_id ?? null, status }));
    },
  );
}

/** Admins: declining a request. Defining one is define_service_type { from_request }. */
export function registerServiceTypeRequestAdminTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "decline_service_type_request",
    {
      title: "Decline a requested standard service",
      description:
        "Admin: decline a request for a new standard service type (list_service_type_requests), with the reason the requester will read. To accept one instead, define the service type from it: define_service_type { service_type, from_request }.",
      inputSchema: { request_id: z.string().uuid(), reason: z.string().trim().min(3).max(1000) },
    },
    async ({ request_id, reason }) => {
      const found = (await requestsOf(store, { id: request_id }))[0];
      if (!found) return fail(`No service type request '${request_id}'`);
      if (found.status !== "requested") return fail(`That request was already ${found.status}`);
      await store.db.query(`UPDATE ${T}.service_type_requests SET status = 'declined', decision_note = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [found.id, reason, user.id]);
      await store.audit(user.id, "decline_service_type_request", found.id, { name: found.name, region: found.region, reason });
      return json((await requestsOf(store, { id: found.id }))[0]);
    },
  );
}

/** create_service and archive_service: for the vendor role. */
export function registerServiceVendorTools(server: McpServer, store: Store, user: User, hosting: HostingService | null = null, opts: VendorCallOptions = {}) {
  server.registerTool(
    "create_service",
    {
      title: "Create a service",
      description:
        "Vendor who builds on Mynt: create a service, the third kind of thing built on Mynt beside apps and financial products. It is one admin-defined standard service type in one region (list_service_types; request_service_type if none fits), built, verified and hosted like an app (start_build, deploy_app with its id) and listed in the Marketplace for other builders to plug in. You need the vendor role at your firm (ask a Mynt admin) and, to name a workspace, to be its owner or admin. Its vendor offering is made with it, as a draft. Mynt derives the endpoint (the service's hosted address plus /mynt/services/<service_type>; never typed), and the service authenticates Mynt by Mynt-Signature alone, with a signing secret Mynt hands it as the hosted setting MYNT_VENDOR_SIGNING_SECRET on deploy and shows to nobody. Stages: idea (draft), staging (online, conformance), production (listed): get_promotion_checks, promote_app and demote_app take its id.",
      inputSchema: {
        workspace_id: z.string().optional().describe("The workspace it belongs to (list_workspaces). Omitted: the workspace you created, or a new one of your own if you created none"),
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(4000).describe("What the service does, in a sentence or two"),
        service_type: Key,
        region: Region,
        price: z
          .object({ amount: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) })
          .default({ amount: 0, currency: "USD" })
          .describe("Per call, for builders to see; change it later with update_vendor_offering. Billing is between you and them, never through Mynt"),
        sla_notes: z.string().max(2000).default(""),
        licence_ids: z.array(z.string().uuid()).max(10).default([]).describe("Your firm's licences it relies on (get_my_entity)"),
      },
    },
    async ({ workspace_id, name, description, service_type, region, price, sla_notes, licence_ids }) => {
      const me = (await store.getUser(user.id)) ?? user;
      // Said now rather than at Put online: a service nobody can host is not worth creating.
      const unhostable = serviceHostingRefusal(hosting);
      if (unhostable) return fail(unhostable);
      if (!me.entity_id) return fail("You don't belong to a firm yet. Ask a Mynt admin to add you to yours, with the vendor role");
      let workspace = workspace_id;
      if (workspace) {
        const role = await workspaceRole(store.db, workspace, me.id);
        if (!role) return fail(`No workspace of yours with id '${workspace}'`);
        if (role === "member") return fail("Only a workspace's owners and admins create a service in it");
      } else {
        const mine = await createdWorkspaces(store.db, me.id);
        if (mine.length > 1) return fail("You created several workspaces: say which one this service goes in with workspace_id (list_workspaces)");
        workspace = mine[0] ?? (await personalWorkspace(store.db, me.id));
      }
      const t = await serviceType(store.db, region, service_type);
      if (!t) return fail(`No service type '${service_type}' in ${region}; see list_service_types, or ask Mynt for a new one with request_service_type`);
      if (t.category === "ramp") return fail("The Mynt Ramp's services aren't built as a service on Mynt: its operator serves them at its own endpoints");
      const ramp = await rampRefusal(store, t, me.entity_id);
      if (ramp) return fail(ramp);
      const held = await store.licensesOf(me.entity_id);
      const bad = licence_ids.filter((id) => !held.some((l) => l.id === id && l.region === region));
      if (bad.length) return fail(`Your firm holds no licence ${bad.join(", ")} in ${region}; see get_my_entity`);
      if (!vaultAvailable(false)) return fail("This server's vault key (MYNT_VAULT_KEY) isn't configured, so it can't keep signing secrets");

      const offeringId = randomUUID();
      // The service and its offering together, or neither.
      const appId = await inTransaction(store.db, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `INSERT INTO ${T}.apps (id, owner_id, name, description, audience, product_ids, status, disclosures, actions, workspace_id, kind)
           VALUES ($1, $2, $3, $4, 'Builders who plug it into their products', '{}', 'draft', '{}', '{}', $5, 'service')`,
          [id, me.id, name, description, workspace],
        );
        // No endpoint yet: Mynt sets it, and hands the service its secret, when it is first put online.
        await tx.query(
          `INSERT INTO ${T}.vendor_offerings (id, entity_id, region, service_type, name, test_base_url, live_base_url, price, sla_notes, licence_ids, requires_credential, conformance_secret, created_by, app_id)
           VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7, $8, false, $9, $10, $11)`,
          [offeringId, me.entity_id, region, service_type, name, JSON.stringify({ ...price, per: "call" }), sla_notes, licence_ids, seal(newSecret(), false), me.id, id],
        );
        return id;
      });
      await store.audit(me.id, "create_service", appId, { workspace_id: workspace, offering_id: offeringId, region, service_type });
      const created = (await store.getApp(appId))!;
      const offering = (await getOffering(store.db, offeringId))!;
      const gap = await vendorLicenceGap(store, offering, t);
      // Where Mynt would call it, checked against the outbound rules now so a refusal is said plainly, early.
      const address = serviceEndpoint(hosting, null, created.id, t.key, opts);
      let addressRefused: string | null = null;
      if (address && hosting?.enabled) {
        try {
          await resolveVendorUrl(address, opts);
        } catch (e) {
          addressRefused = (e as Error).message;
        }
      }
      return json({
        ...(await serviceView(store, hosting, me, created))!,
        signing_secret: `Never shown. Mynt hands it to the service as the hosted setting ${SERVICE_SECRET_ENV} each time it is put online.`,
        next: `Build it (start_build with app_id ${created.id}: the coding agents add Mynt's endpoint for ${t.name}), put the verified build online (deploy_app), and Mynt tests it. Then set standard terms and move it to Production to list it`,
        ...(gap ? { licence_gap: gap } : {}),
        ...(addressRefused ? { address_problem: `Mynt can't call this deployment's hosted addresses under its outbound rules (${addressRefused}); conformance will be refused until they resolve publicly over HTTPS` } : {}),
      });
    },
  );

  server.registerTool(
    "archive_service",
    {
      title: "Archive or restore a service",
      description:
        "Vendor (an owner or admin of the service's workspace): archive a service you built on Mynt (archived: true). Its offering comes off the Marketplace and Mynt stops calling it at once; products that hand off through it drift (new sales pause) and their builders are told. Its history (builds, conformance runs, terms, agreements) stays. archived: false restores it as a draft: put it online again and Mynt tests it; a service still in Production is listed again on a pass.",
      inputSchema: { service_id: z.string(), archived: z.boolean().default(true), reason: z.string().max(500).optional() },
      annotations: { destructiveHint: true },
    },
    async ({ service_id, archived, reason }) => {
      const me = (await store.getUser(user.id)) ?? user;
      const app = await memberApp(store, me, service_id);
      const o = app?.kind === "service" ? await offeringOfService(store, app.id) : undefined;
      if (!app || !o) return fail(`No service of yours with id '${service_id}'`);
      const role = await appRole(store, me, app);
      if (role !== "owner" && role !== "admin") return fail("Only the workspace's owners and admins archive or restore a service");
      if (o.entity_id !== me.entity_id) return fail("That service is offered by another firm");
      if (archived) {
        if (o.app_pause === "stopped") return fail("That service is already archived");
        if (o.status === "suspended" && !o.app_pause) return fail("A Mynt admin suspended this service's offering; it is already off");
        const note = `Archived by its builder${reason ? `: ${reason}` : ""}.`;
        // A new build still being tested beside the serving one is removed: an archived service switches to nothing.
        await store.db.query(
          `UPDATE ${T}.vendor_offerings SET status = 'suspended', status_note = $2, app_pause = 'stopped', candidate_id = NULL, candidate_build_id = NULL, candidate_secret = NULL, candidate_at = NULL, updated_at = now() WHERE id = $1`,
          [o.id, note],
        );
        if (hosting) await hosting.dropCandidate(app.id, "The service was archived").catch(() => null);
      } else {
        if (o.app_pause !== "stopped") return fail("That service isn't archived");
        // Back as a draft with no endpoint: it is set, and the build tested, when the service is next put online.
        await store.db.query(
          `UPDATE ${T}.vendor_offerings SET status = 'draft', status_note = NULL, app_pause = NULL, test_base_url = NULL, live_base_url = NULL, app_build_id = NULL, app_secret_at = NULL, updated_at = now() WHERE id = $1`,
          [o.id],
        );
      }
      await store.audit(me.id, "archive_service", o.id, { service_id: app.id, archived, was: o.status, reason: reason ?? null });
      const drifted = await vendorDriftSweep(store, { offering_id: o.id });
      return json({ ...(await serviceView(store, hosting, me, app))!, drifted_products: drifted, ...(archived ? {} : { next: "Put it online again (deploy_app): Mynt then tests the build" }) });
    },
  );
}
