import { selfSignedEd25519 } from "./cert.mjs";
import { startKeyhouseServer } from "./http.mjs";
import { createKeyhouse, loadPolicy } from "./keyhouse.mjs";

// The confidential service's entry point. KEYHOUSE_PLATFORM is set by the image itself (Dockerfile), so it's part of
// what the hardware measures:
//
//   aws-nitro (the enclave image, run by mynt-enclave-io)
//     Settings come from the parent instance over vsock (nitro.mjs readSettings): the region, the KMS key that wraps
//     the root, and the one authority whose client certificates may call. None is a secret, and all three are bound
//     into every attestation (the authority as the SHA-256 of its certificate), so a parent that names another key,
//     or hands over an authority of its own to call as Mynt's server, is seen by every verifier. The wrapped root comes
//     from Mynt's server after each start (POST /v1/unlock). Listens on /run/keyhouse/https.sock, which the helper
//     joins to vsock port 8443.
//
//   gcp-confidential-space (the default; the container launcher's environment overrides, only the names the image's
//   launch policy allows: see the Dockerfile's labels)
//     KEYHOUSE_WIP_PROVIDER   projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
//     KEYHOUSE_WRAP_KEY       projects/…/locations/…/keyRings/…/cryptoKeys/<symmetric key>
//     KEYHOUSE_SIGNING_KEYS   JSON: { "health-attester": "projects/…/cryptoKeys/…/cryptoKeyVersions/1" }
//     KEYHOUSE_WRAPPED_ROOT   from POST /v1/init (mynt confidential init), once; until then the service only attests
//     KEYHOUSE_CLIENT_CA      PEM of the authority that issued Mynt's client certificate (exactly one certificate)
//     KEYHOUSE_PORT           default 8443
//     The wrap key, the signing keys and the authority's SHA-256 are bound into every attestation (cloud.mjs).

const env = process.env;
const need = (name) => env[name] || (console.error(`keyhouse: ${name} isn't set`), process.exit(2));
const tls = selfSignedEd25519("mynt-keyhouse");
const policy = loadPolicy();

if (env.KEYHOUSE_PLATFORM === "aws-nitro") {
  const { imdsCredentials, kmsOverSocket, nitroKms, nitroPlatform, nsmClient, readSettings, SOCKETS } = await import("./nitro.mjs");
  const settings = await readSettings();
  const nsm = nsmClient();
  const kms = nitroKms({ region: settings.region, keyArn: settings.kms_key, nsm, credentials: imdsCredentials(), post: kmsOverSocket({ region: settings.region }) });
  const keyhouse = await createKeyhouse({ platform: nitroPlatform({ kms, nsm, region: settings.region, keyArn: settings.kms_key, clientCaSha256: settings.client_ca_sha256 }), wrappedRoot: null, tlsSpki: tls.spki, policy });
  await startKeyhouseServer(keyhouse, { cert: tls.cert, key: tls.key, ca: settings.client_ca, path: SOCKETS.https });
  console.log("keyhouse: listening in the enclave, locked until Mynt's server hands back the wrapped root (or runs mynt confidential init)");
} else {
  const { kmsClient, launcherClient } = await import("./cloud.mjs");
  const { clientAuthority } = await import("./shared/binding.js");
  const launcher = launcherClient();
  // The certificate that's hashed into the attestation is the one, re-encoded, the TLS server trusts.
  const authority = clientAuthority(need("KEYHOUSE_CLIENT_CA"));
  const keyhouse = await createKeyhouse({
    kms: kmsClient({ provider: need("KEYHOUSE_WIP_PROVIDER"), subjectToken: launcher.stsSubjectToken }),
    launcher,
    wrapKey: need("KEYHOUSE_WRAP_KEY"),
    wrappedRoot: env.KEYHOUSE_WRAPPED_ROOT || null,
    signingKeys: JSON.parse(env.KEYHOUSE_SIGNING_KEYS || "{}"),
    clientCaSha256: authority.sha256,
    tlsSpki: tls.spki,
    policy,
  });
  await startKeyhouseServer(keyhouse, { cert: tls.cert, key: tls.key, ca: authority.pem, port: Number(env.KEYHOUSE_PORT || 8443) });
  console.log(`keyhouse: listening, ${keyhouse.initialised() ? "initialised" : "not initialised (POST /v1/init, then set KEYHOUSE_WRAPPED_ROOT and restart)"}`);
}
