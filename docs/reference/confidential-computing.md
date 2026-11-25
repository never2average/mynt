# Confidential computing

This file covers what Mynt's confidential service protects, the three confidential hosts, how the service's keys and attestation work, how releases are announced, the settings by name, and the operator's steps on each cloud. It is for licence providers' engineers, operators and Mynt admins.

See also: [Firms, licences and licence providers](licence-providers.md), [Connecting a licence provider to Mynt](../partners.md), [Running Mynt](operations.md), [Mynt architecture](../architecture.md).

Some of what Mynt keeps shouldn't be readable even by whoever runs Mynt's server: a licence provider's books, the vault's root key, and the keys that sign what Mynt attests. They go to a **confidential host**: a small service (`deploy/confidential`, code name "keyhouse") that runs in hardware-isolated memory whose exact image the hardware measures and signs for.

In this file, "partner" means the licence provider, as in the partner kit and the partner ledger.

## What is protected

The table compares a server on the `local` host with one whose confidential service is deployed and whose migration has run.

| | Until the service is deployed (`local`) | Once it is, and the migration has run |
| --- | --- | --- |
| A partner's live books | Read in the clear by Mynt's server, then encrypted per product | Sealed by the partner to the service's attested key; opened, checked and computed only inside it. One product's figures and a signature over their fingerprint come out |
| The vault's root (`MYNT_VAULT_KEY`) | In the server's environment file | Adopted by the service, never released, and removed from the server |
| Values in the vault | Sealed with `MYNT_VAULT_KEY` | Re-wrapped to a data key the service releases into the server's memory at boot, never written to its disk |
| Keys derived from the vault (MACs, on-chain subject hashes, sandbox keys) | From `MYNT_VAULT_KEY` | Exactly the same keys, from HKDF-Extract of the root, which the service releases; the root itself stays inside |
| The health attester key | None | An Ed25519 key derived inside the enclave from the service's root, so it exists only where the root does. It signs every snapshot the service computes |
| Who can use the service's keys | Not applicable | Only an enclave running the exact announced image (its PCR0), out of debug mode: no person, Mynt's operators and the parent instance included |

On Confidential Space the health attester is a Cloud KMS `EC_SIGN_ED25519` key only the attested image can use.

## Hosts

Mynt's server reaches the confidential service through one brand-neutral interface, `ConfidentialHost` (`core/src/confidential/host.ts`):

- `attest(nonce)` and `measurements()`;
- `seal` and `unseal(purpose, bytes)`;
- `sign(key, bytes)` and `publicKey(name)`;
- `computeHealth`;
- the vault's `adoptVaultRoot` and `releaseVaultKeys`.

`CONFIDENTIAL_HOST` chooses one of three adapters:

| `CONFIDENTIAL_HOST` | What it is |
| --- | --- |
| `local` (the default) | In Mynt's own process, keyed by `MYNT_VAULT_KEY`. For development, tests, and every server until the operator deploys the service |
| `aws-nitro` (the documented deployment) | The service in an AWS Nitro Enclave |
| `gcp-confidential-space` | The same service as a Google Cloud Confidential Space container, kept as an alternative |

Notes on each:

- **`local`** keeps the same rules but protects nothing from whoever runs the server, and its attestation says so (`format: "none"`, `attested: false`).
- **`aws-nitro`**: a Nitro Enclave is an isolated VM carved out of an EC2 instance, with no network, disk or console. The Nitro hypervisor measures its image file into PCRs, and its security module signs attestation documents over them. Only `core/src/confidential/aws-nitro.ts` names the provider.
- **`gcp-confidential-space`**: an AMD SEV-SNP or Intel TDX confidential VM. Only `core/src/confidential/gcp-confidential-space.ts` and `attestation-verify.ts` name that provider.

Both remote adapters share `core/src/confidential/remote.ts` (the connection, the pin, every request) and differ only in how they check an attestation.

## How the enclave's keys work

This section describes AWS KMS, which the `aws-nitro` host uses.

### The root and the wrap key

The service's root is a random 32-byte key that AWS KMS generates (`GenerateDataKey`). It exists outside the enclave only wrapped by one symmetric KMS key, the wrap key.

Every KMS call the enclave makes carries, as `Recipient`, a fresh attestation document whose public key is an RSA key made inside the enclave. KMS checks the document's signature and PCRs against the key policy and answers in `CiphertextForRecipient`, never in plaintext. That answer is CMS enveloped data encrypted to the RSA key, opened by `deploy/confidential/src/cms.mjs`.

### The key policy

The key policy (`deploy/confidential/aws/key-policy.json`; the CloudFormation template makes the same one) has four statements:

1. The account may manage the key but not use it.
2. The instance's role may call `kms:Decrypt` and `kms:GenerateDataKey` only when `kms:RecipientAttestation:ImageSha384` (PCR0) is the release's.
3. **Everyone** is denied those calls when it isn't. That includes any call with no attestation at all, whatever their IAM permissions say.
4. Nobody may re-encrypt, encrypt, or create grants on it.

What follows from it:

- The parent instance has the role's credentials (it relays them to the enclave from the instance metadata service). It still can't use the key itself, and couldn't read KMS's answer if it relayed one.
- A debug-mode enclave reports all-zero PCRs and is refused the same way.

The enclave calls KMS directly: Signature Version 4 with the role's temporary credentials, TLS end to end through AWS's `vsock-proxy` on the parent, with no SDK.

### The health attester and Ed25519

The root is protected because the two KMS calls it uses, `GenerateDataKey` and `Decrypt`, carry the enclave's attestation document as their `Recipient`, and the key policy admits only this image's. KMS signing can't be gated on attestation in that way, so a KMS signing key would be usable by the parent instance's role directly (`deploy/confidential/src/nitro.mjs`). AWS's KMS documentation lists the calls that accept an attestation document; check it before changing this design.

The enclave therefore derives its Ed25519 attester from its root (HKDF, as the local host does). The attester exists only inside an attested enclave and is the same after every restart.

Partners check its public key the same way as the rest: it is bound into every attestation.

## What partners check

`GET /confidential/attestation?nonce=<16 to 64 URL-safe characters>` (public, one a second) returns the service's own answer, relayed unchanged, with the releases Mynt has announced.

### An attestation from an enclave

From an enclave the answer has `format: "nitro-cose"`, and `token` is the attestation document (COSE_Sign1, base64). In the document:

- `nonce` is the caller's nonce;
- `user_data` is `mynt-keys-<sha256>` over the keys returned beside it;
- `public_key` is the service's TLS key.

The keys returned beside it are the service's TLS key, the ingest key partners seal to, the health attester's public key, and `config`: the wrap key's ARN and region.

### Checking it with the verify script

`core/scripts/verify-mynt-enclave.mjs --url … --expected-pcr0 … --expected-pcr1 … --expected-pcr2 …` checks the attestation with nothing but Node. It checks:

- the COSE ES384 signature with the document's certificate;
- that certificate's chain, through the document's own bundle, up to the AWS Nitro Enclaves root certificate pinned in `aws-nitro.ts`, each certificate valid now;
- that the document was made in the last five minutes;
- PCR0, PCR1 and PCR2 equal to the ones published for the release, and not a debug-mode enclave's zeros;
- its own fresh nonce;
- both bindings.

`--expected-kms-key <arn>` also checks which KMS key wraps the root.

The pinned root certificate is `AWS_NitroEnclaves_Root-G1`, from AWS's `AWS_NitroEnclaves_Root-G1.zip`, never fetched from Mynt. Its SHA-256 fingerprint is:

`64:1A:03:21:A3:E2:44:EF:E4:56:46:31:95:D6:06:31:7E:D7:CD:CC:3C:17:56:E0:98:93:F3:C6:8F:79:BB:5B`

### A Confidential Space deployment

For a Confidential Space deployment the script checks an OIDC token instead, with `--expected-digest sha256:…`. It checks:

- the token's RS256 signature against the attestation service's published keys;
- `swname` `CONFIDENTIAL_SPACE`, `STABLE`, secure boot, and `dbgstat` `disabled-since-boot`;
- the image digest;
- the nonce and the key binding in `eat_nonce`.

### Sealed statements and snapshots

[Connecting a licence provider to Mynt](../partners.md) has the partner's steps, including sealing a live statement (`mynt.sealed_statement.v1`: X25519, HKDF-SHA256, AES-256-GCM, with the firm, environment and request bound as associated data).

A snapshot computed by the service shows `enclave: { public_key, signature_ok }` in `list_product_health`. Mynt's server recomputes the fingerprint and checks the signature before it stores anything. See [Product health](licence-providers.md#product-health).

## How Mynt's server trusts the service

The connection is TLS 1.3 with a certificate on each side:

- Mynt presents a client certificate (`CONFIDENTIAL_HOST_CLIENT_CERT`, `CONFIDENTIAL_HOST_CLIENT_KEY`: paths to files, made by `deploy/confidential/make-client-cert.sh`) from an authority the service trusts.
- The service presents a key it made inside the enclave at boot, which no authority vouches for.

Before anything is sent, Mynt:

1. fetches an attestation over a connection to the service;
2. checks it as a partner would, with the PCRs required to be a release in effect in Mynt's record and the wrap key required to be `CONFIDENTIAL_HOST_KMS_KEY`;
3. pins the TLS key the attestation binds.

A connection presenting any other key is closed before a byte is written. The pin lasts ten minutes.

On the parent instance the TLS connection is relayed byte for byte (TCP 8443 to the enclave's vsock port 8443), so the parent sees ciphertext only.

The service allows each caller (by certificate common name) only what `deploy/confidential/policy.json` lists, and that file is part of the measured image. What is sealed for `vault-legacy-root`, `vault-keys`, `signing-key` or `partner-ledger` has no endpoint that returns it.

## Inside the enclave

### An enclave keeps nothing across restarts

`mynt confidential init` asks a new service to make its root. It stores the wrapped form (ciphertext only an attested enclave can unwrap) in Mynt's database (`confidential_keys`, `host-root`).

Whenever the enclave restarts, Mynt's server hands the wrapped root back (`POST /v1/unlock`) after attesting the new enclave, so the operator has nothing to copy.

Keep a copy of the printed wrapped root somewhere safe as well. Without it and the database, what is sealed under the root can't be opened.

### The service and its helper

The service is Node with no npm dependencies. The enclave has only vsock, which Node can't use, so a small Go helper (`deploy/confidential/enclave-io`, standard library only, written for this repository) is the image's entry point.

The helper relays Unix sockets in `/run/keyhouse` to the parent's vsock ports, and the inbound port 8443 to the service:

| Parent vsock port | Carries |
| --- | --- |
| 8000 | KMS, through `vsock-proxy` |
| 8001 | The instance metadata service, for the role's credentials |
| 8002 | The settings file |
| 8003 | The log lines |

The helper alone opens `/dev/nsm`, the security module, and answers the service's attestation requests (the module's one `NSM_IOCTL_RAW` call, CBOR in and out). It runs the service as an unprivileged user.

AWS's own NSM library and `kmstool-enclave-cli` were the alternatives. Both would add a Rust or C toolchain and libraries to the measured image, where this helper is about 300 lines anyone can read.

### Settings from the parent

The settings (region, wrap key ARN, the client authority) come from the parent and aren't secret. The first two are bound into every attestation, so a parent that names another key is seen by every verifier and refused by Mynt.

## Releases and the 48-hour wait

Each build of the service is what the hardware measures:

- for an enclave: PCR0 (the whole image file), PCR1 (kernel and boot ramdisk) and PCR2 (the application);
- for a container: its image digest.

### What CI builds

CI's `confidential-image` job builds the enclave image file (EIF) twice from scratch with `deploy/confidential/aws/build-eif.sh`: pinned base images, a pinned BuildKit, timestamps set to the commit's, and `nitro-cli` 1.5.3 in a pinned Amazon Linux container.

- It fails unless the PCRs match, and prints them with the commit.
- It also builds the Confidential Space image twice and compares digests.
- Nothing is pushed or deployed.

### Announcing a release

A Mynt admin announces a release with `announce_enclave_release { pcr0, pcr1, pcr2, release, reason }`, or `{ image_digest, … }` for a container. The announcement is:

- audited;
- told to every licence provider's firm: a notice to each member and `confidential.release_announced` on its webhooks;
- in effect only 48 hours later, the wait a mainnet program upgrade gets, so a partner can stop sending sealed statements first.

The first release ever is in effect at once: there is nothing before it.

| Tool | Who | What it does |
| --- | --- | --- |
| `announce_enclave_release` | Mynt admin | Announces a release |
| `withdraw_enclave_release` | Mynt admin | Takes one back |
| `list_enclave_releases` | Licence providers, liquidity providers, Mynt admins | Shows them all |

### What enforces a release

- Rows are MACed under a vault-derived key, so measurements planted in the database count for nothing.
- Mynt's server refuses to talk to a service whose attested measurements aren't in effect.
- The key policy is what finally decides which image can use the keys, and only the operator changes it. Each change is a `PutKeyPolicy` event in the account's CloudTrail.

Changing the key policy without announcing is possible for the operator. That is why partners verify the PCRs themselves and Mynt's server refuses unannounced ones.

## Confidential computing settings

Settings are given by name only.

On Mynt's server:

| Setting | What it is |
| --- | --- |
| `CONFIDENTIAL_HOST` | `local`, `aws-nitro` or `gcp-confidential-space` |
| `CONFIDENTIAL_HOST_URL` | `https://…:8443` of the parent instance's address |
| `CONFIDENTIAL_HOST_CLIENT_CERT`, `CONFIDENTIAL_HOST_CLIENT_KEY` | File paths, readable only by Mynt's user |
| `CONFIDENTIAL_HOST_KMS_KEY` | For `aws-nitro`: the wrap key's ARN. A name, not a secret |

On the parent instance: `/etc/mynt-keyhouse/settings.json` (`region`, `kms_key`, `client_ca`), written by `deploy/confidential/aws/parent-setup.sh`.

For Confidential Space, the VM's launcher overrides instead. They are the only names the image allows, and none is a secret: `KEYHOUSE_WIP_PROVIDER`, `KEYHOUSE_WRAP_KEY`, `KEYHOUSE_SIGNING_KEYS`, `KEYHOUSE_WRAPPED_ROOT`, `KEYHOUSE_CLIENT_CA`, `KEYHOUSE_PORT`.

## Operator steps for AWS Nitro Enclaves

One upload creates everything. No command here creates anything until the operator runs it, and none involves typing a secret into a chat.

1. **An AWS account.** Create an AWS account (or use one kept for Mynt alone), and pick one region for everything below, for example `us-east-1`.
2. **Mynt's client certificate.** On Mynt's server, run `deploy/confidential/make-client-cert.sh /etc/mynt/confidential` as Mynt's user. It writes Mynt's client certificate and key there (readable only by that user) and prints one long line: the authority's certificate in base64, which is public. Keep that line for step 4.
3. **The release.** Find the release's commit and PCRs: the `confidential-image` job's summary in CI shows the commit, `pcr0`, `pcr1` and `pcr2`. A Mynt admin announces them with `announce_enclave_release` (the first one is in effect at once).
4. **The stack.** In the AWS console, open CloudFormation, choose **Create stack** → **With new resources**, and upload `deploy/confidential/aws/keyhouse.cloudformation.json`. Fill in `ReleaseCommit` (the commit), `AllowedPcr0s` (the release's `pcr0`), `MyntServerAddress` (Mynt's server's public address followed by `/32`) and `ClientAuthorityBase64` (the line from step 2). Leave the rest as they are. Tick the box that lets it create a role, and create the stack.
5. **Mynt's settings.** When the stack shows `CREATE_COMPLETE`, its **Outputs** tab shows `ConfidentialHostUrl` and `WrapKeyArn`. On Mynt's server, set `CONFIDENTIAL_HOST=aws-nitro`, `CONFIDENTIAL_HOST_URL` (the first), `CONFIDENTIAL_HOST_KMS_KEY` (the second), `CONFIDENTIAL_HOST_CLIENT_CERT=/etc/mynt/confidential/client.crt` and `CONFIDENTIAL_HOST_CLIENT_KEY=/etc/mynt/confidential/client.key`, and restart Mynt.
6. **The root.** Run `mynt confidential status` (it shows the attested PCRs), then `mynt confidential init` once. The enclave makes its root, Mynt stores it wrapped, and it prints the wrapped form for you to keep a copy of.
7. **The vault.** Move the vault's keys to the service:
   1. Run `mynt confidential adopt`. The service adopts `MYNT_VAULT_KEY`.
   2. Restart Mynt. The vault's keys now come from the service at boot.
   3. Run `mynt confidential rewrap`. It is a dry run: counts per table and column, nothing changed.
   4. Run `mynt confidential rewrap --apply`.
   5. Run the dry run again to see zero left.
   6. Remove `MYNT_VAULT_KEY` from the server's environment file and restart.
   7. Destroy any copy of the old environment file kept elsewhere. Old database backups still hold values sealed with it.
8. **A new release.** Announce its PCRs and wait the 48 hours. Then in CloudFormation choose the stack → **Update** → **Use current template**, set `ReleaseCommit` to the new commit and `AllowedPcr0s` to the old and new `pcr0` separated by a comma, and update. CloudFormation replaces the instance (same address), and Mynt hands the new enclave its root. Once it is running, update again with only the new `pcr0`.

### What the stack makes

- one `c6a.xlarge` instance with enclaves enabled;
- the wrap key with the policy in [The key policy](#the-key-policy);
- the instance's role, with only `kms:Decrypt` and `kms:GenerateDataKey` on that key;
- a security group that admits only Mynt's server on port 8443;
- a fixed address.

The instance builds the enclave from the commit on first boot (about ten minutes) and refuses to start it unless its PCR0 is the one you entered.

### Doing it by hand

To do it by hand instead, you need:

- an Amazon Linux 2023 instance of a type that supports enclaves, with 4 vCPUs: `c6a.xlarge`, `m6i.xlarge` and the like. Graviton types such as `c7g.large` support enclaves too, but this image is built for x86-64;
- **Nitro Enclave** enabled at launch, and IMDSv2 required;
- a role allowed only those two KMS calls on the wrap key;
- a symmetric KMS key with `key-policy.json` (fill in the account, the role's ARN and the PCR0);
- port 8443 open to Mynt's server alone.

Then run `deploy/confidential/aws/parent-setup.sh` from a checkout of the release's commit. It installs `nitro-cli` 1.5.3 and the allocator settings (2 vCPUs and 3 GiB for the enclave), builds the EIF, and starts the enclave and its relays as systemd units.

### What it costs

These are approximate figures from AWS's public prices, not something Mynt measures:

| Item | Cost |
| --- | --- |
| The instance (`c6a.xlarge` in `us-east-1`) | About $0.153 an hour, about $112 a month on demand. A one-year savings plan takes roughly a third off |
| Its 30 GB disk | About $2.40 a month |
| Its public address | About $3.60 a month |
| The KMS key | $1 a month, plus $0.03 per 10,000 calls (a few a day) |
| Nitro Enclaves | Nothing extra |

About $120 a month in all.

## Operator steps for Google Confidential Space

This is the alternative, with `CONFIDENTIAL_HOST=gcp-confidential-space`.

1. **A project.** In Google Cloud, create a project for the service and enable the Confidential Computing, Cloud KMS, IAM Credentials and Compute Engine APIs.
2. **Keys.** In Cloud KMS, create a key ring with a symmetric encrypt/decrypt key (the wrap key) and an asymmetric signing key with algorithm `EC_SIGN_ED25519` (the health attester).
3. **A workload identity pool.** Create a workload identity pool and an OIDC provider for it, with the values in [The OIDC provider](#the-oidc-provider).
4. **Key access for the attested image only.** Grant `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the wrap key and `roles/cloudkms.signerVerifier` on the signing key to the principal set in [Key access on Google Cloud](#key-access-on-google-cloud), and to nobody else.
5. **A service account.** Create a service account for the VM with only `roles/confidentialcomputing.workloadUser` and `roles/logging.logWriter`.
6. **Mynt's client certificate.** Make it with `deploy/confidential/make-client-cert.sh` (step 2 of the AWS steps) and put the authority's certificate (`ca.crt`) in the VM's `KEYHOUSE_CLIENT_CA`.
7. **The image.** Build the image from the release's commit (`docker buildx build --target confidential-space`, as CI's `confidential-image` job does), push it to Artifact Registry, and check the pushed digest equals the one CI printed. Then announce it (`announce_enclave_release { image_digest, … }`).
8. **The VM.** Create the VM from the `confidential-space` image family (never `confidential-space-debug`) with confidential computing on (N2D with SEV-SNP or C3 with TDX), shielded VM secure boot, and the service account above. Set the metadata `tee-image-reference` (the image by digest), `tee-restart-policy=Always`, `tee-container-log-redirect=true`, and the `tee-env-KEYHOUSE_*` settings, without `KEYHOUSE_WRAPPED_ROOT` yet. Only Mynt's server should reach its port (a firewall rule for that address only).
9. **Mynt's settings and the root.** On Mynt's server, set `CONFIDENTIAL_HOST=gcp-confidential-space`, `CONFIDENTIAL_HOST_URL` and the two certificate paths, then run `mynt confidential init`. It prints the wrapped root. Set it as the VM's `tee-env-KEYHOUSE_WRAPPED_ROOT` and restart the VM. `mynt confidential status` then shows the attested digest.
10. **The vault.** Follow step 7 of the AWS steps (adopt, restart, rewrap).

### The OIDC provider

- **Issuer:** `https://confidentialcomputing.googleapis.com`
- **Allowed audience:** `https://sts.googleapis.com`
- **Attribute mapping**, two entries:
  - `google.subject = "gcpcs::" + assertion.submods.container.image_digest + "::" + assertion.submods.gce.project_number + "::" + assertion.submods.gce.instance_id`
  - `attribute.image_digest = assertion.submods.container.image_digest`
- **Attribute condition:** `assertion.swname == 'CONFIDENTIAL_SPACE' && 'STABLE' in assertion.submods.confidential_space.support_attributes && assertion.dbgstat == 'disabled-since-boot'`

Add `&& assertion.hwmodel == '<model>'` to the condition to pin the hardware.

### Key access on Google Cloud

The principal set that gets the two key roles is:

`principalSet://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/attribute.image_digest/<the release's digest>`

- No person, group or service account gets either role on those keys, and the project's owners are told not to add one.
- An owner could add one, so the project's IAM audit log is what shows it.
- Give a person `roles/cloudkms.viewer` and `roles/cloudkms.publicKeyViewer` if they need to see the keys exist.

## Not built yet

Phases 2 and 3 are not built. The same types carry over.

- **Build agents** will get an isolated VM per build behind `SandboxHost`, so a build's code and credentials are out of the operator's reach and Mynt can attest which image ran it.
- **Hosted apps** will get a confidential hosting tier: each app's enclave or VM attested the same way, its measurements announced through the same release record, and its attestation available to its users.

## Limits

- **It rests on the hardware and the cloud.** With Nitro Enclaves, AWS operates the hypervisor that isolates the enclave and the security module that signs its attestations, and runs KMS, which enforces the key policy. Trusting the service means trusting AWS for those.
- **The cloud account's administrators.** The AWS account's administrators can't read the enclave's memory or use the wrap key, but they can change the key policy (logged in CloudTrail). That is why partners check the PCRs themselves and don't rely on the policy.
- **Confidential Space.** The same holds for Google. AMD SEV-SNP and Intel TDX have had published attacks and firmware fixes, so the attestation's hardware and OS version matter.
- **The parent can deny service, never read.** The enclave's clock comes from its parent, and its logs go to the parent's journal (route, caller and outcome only). A parent can stop or restart the enclave, or refuse to relay.
- **Mynt's server still sees what it serves.** Entitled readers get figures through `get_product_health`, so a product's figures pass through Mynt's server on their way out. What it never sees is a partner's whole statement (every product's books) when sealed, or the vault's root.
- **Keys in the running process.** The vault's data key and derivation key are released to Mynt's running process. Someone with root on that server while it runs can read its memory. What changes is that they are no longer in a file, the environment or a backup.
- **The registered partner key.** The service trusts the partner key Mynt's server says is registered. A snapshot signed with another key fails, and the partner sees which key was used, so it can check.
- **Solana keys.** Solana keys Mynt holds (deploy authorities, the health publisher, the treasury attester) stay in the vault and sign in Mynt's process. Moving them to `signing-key` (signed inside the service) is not built.
- **In the clear.** The partner's daily-file upload and conformance stay in the clear.
- **Until the service is deployed.** Until the operator deploys the service, everything above runs on the local host, which protects nothing from whoever runs the server.
