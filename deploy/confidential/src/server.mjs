import { selfSignedEd25519 } from "./cert.mjs";
import { kmsClient, launcherClient } from "./cloud.mjs";
import { startKeyhouseServer } from "./http.mjs";
import { createKeyhouse, loadPolicy } from "./keyhouse.mjs";

// The confidential service's entry point, run by the confidential VM's container launcher. Settings arrive as the
// launcher's environment overrides (only the names the image's launch policy allows: see the Dockerfile's labels), and
// none of them is a secret: KMS resource names, the wrapped root (ciphertext only this image can unwrap) and the
// certificate authority whose client certificates may call (Mynt's server's).
//
//   KEYHOUSE_WIP_PROVIDER   projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
//   KEYHOUSE_WRAP_KEY       projects/…/locations/…/keyRings/…/cryptoKeys/<symmetric key>
//   KEYHOUSE_SIGNING_KEYS   JSON: { "health-attester": "projects/…/cryptoKeys/…/cryptoKeyVersions/1" }
//   KEYHOUSE_WRAPPED_ROOT   from POST /v1/init (mynt confidential init), once; until then the service only attests
//   KEYHOUSE_CLIENT_CA      PEM of the authority that issued Mynt's client certificate
//   KEYHOUSE_PORT           default 8443

const env = process.env;
const need = (name) => env[name] || (console.error(`keyhouse: ${name} isn't set`), process.exit(2));

const tls = selfSignedEd25519("mynt-keyhouse");
const launcher = launcherClient();
const keyhouse = await createKeyhouse({
  kms: kmsClient({ provider: need("KEYHOUSE_WIP_PROVIDER"), subjectToken: launcher.stsSubjectToken }),
  launcher,
  wrapKey: need("KEYHOUSE_WRAP_KEY"),
  wrappedRoot: env.KEYHOUSE_WRAPPED_ROOT || null,
  signingKeys: JSON.parse(env.KEYHOUSE_SIGNING_KEYS || "{}"),
  tlsSpki: tls.spki,
  policy: loadPolicy(),
});
await startKeyhouseServer(keyhouse, { cert: tls.cert, key: tls.key, ca: need("KEYHOUSE_CLIENT_CA"), port: Number(env.KEYHOUSE_PORT || 8443) });
console.log(`keyhouse: listening, ${keyhouse.initialised() ? "initialised" : "not initialised (POST /v1/init, then set KEYHOUSE_WRAPPED_ROOT and restart)"}`);
