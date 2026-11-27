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
| The health attester key | None | An Ed25519 key derived inside the enclave from the service's root, so it exists only where the root does. It signs every snapshot the service computes, and nothing else: no caller can have it sign a message |
| Who can use the service's keys | Not applicable | Only an enclave running the exact announced image (its PCR0), out of debug mode: no person, Mynt's operators and the parent instance included |

On Confidential Space the health attester is a Cloud KMS `EC_SIGN_ED25519` key only the attested image can use.

## Hosts

Mynt's server reaches the confidential service through one brand-neutral interface, `ConfidentialHost` (`core/src/confidential/host.ts`):

- `attest(nonce)` and `measurements()`;
- `seal` and `unseal(purpose, bytes, context)`;
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

- **`local`** keeps the same rules but protects nothing from whoever runs the server, and its attestation says so (`format: "none"`, `attested: false`). It is what an unset `CONFIDENTIAL_HOST` means, and the server says so in two places: one line when it starts, and `ops_status`, which reads `Confidential host: local (keys sealed in this server's own process)`.
- **`aws-nitro`**: a Nitro Enclave is an isolated VM carved out of an EC2 instance, with no network, disk or console. The Nitro hypervisor measures its image file into PCRs, and its security module signs attestation documents over them. Only `core/src/confidential/aws-nitro.ts` names the provider.
- **`gcp-confidential-space`**: an AMD SEV-SNP or Intel TDX confidential VM. Only `core/src/confidential/gcp-confidential-space.ts` and `attestation-verify.ts` name that provider.

Both remote adapters share `core/src/confidential/remote.ts` (the connection, the pin, every request) and differ only in how they check an attestation.

The local host is never a fallback:

- A server set to a remote host that is misconfigured, unreachable or fails its attestation gets an error, at start-up or on the request. Nothing is sealed, signed or opened in the server's own process in its place.
- A server with any `CONFIDENTIAL_HOST_*` setting but no `CONFIDENTIAL_HOST` refuses to start, rather than run on the local host with a confidential service half configured.

### What a sealed value is bound to

Every sealed value is bound to the host that sealed it and to its purpose, so it never opens on another host or as another purpose. A value sealed with a `context` is bound to that too. The platform key vault seals each key with its key type as the context, so a sealed key moved to another type's row in the database doesn't open there.

Keys the vault sealed before contexts existed still open. Each is sealed again, bound to its type, the first time the server opens it, and every new or replaced key is bound from the start.

## How the enclave's keys work

This section describes AWS KMS, which the `aws-nitro` host uses.

### The root and the wrap key

The service's root is a random 32-byte key that AWS KMS generates (`GenerateDataKey`). It exists outside the enclave only wrapped by one symmetric KMS key, the wrap key.

Every KMS call the enclave makes carries, as `Recipient`, a fresh attestation document whose public key is an RSA key made inside the enclave. KMS checks the document's signature and PCRs against the key policy and answers in `CiphertextForRecipient`, never in plaintext. That answer is CMS enveloped data encrypted to the RSA key, opened by `deploy/confidential/src/cms.mjs`.

### The key policy

The key policy (`deploy/confidential/aws/key-policy.json`; the CloudFormation template makes the same one) has six statements:

1. The account may manage the key but not use it, and not change this policy.
2. One named role, the break-glass role, may change the policy (`kms:PutKeyPolicy`). It can't use the key either.
3. **Everyone else** is denied `kms:PutKeyPolicy`, whatever their IAM permissions say.
4. The instance's role may call `kms:Decrypt` and `kms:GenerateDataKey` only when `kms:RecipientAttestation:ImageSha384` (PCR0) is the release's.
5. **Everyone** is denied those calls when it isn't. That includes any call with no attestation at all, whatever their IAM permissions say.
6. Nobody may re-encrypt, encrypt, or create grants on it.

What follows from it:

- The parent instance has the role's credentials (it relays them to the enclave from the instance metadata service). It still can't use the key itself, and couldn't read KMS's answer if it relayed one.
- A debug-mode enclave reports all-zero PCRs and is refused the same way.
- The policy is what names the PCR0 that may use the key, so whoever can rewrite it can admit an image of their own. Only the break-glass role can, and it is used for one thing: updating the allowed PCR0 at an upgrade. Nobody should hold it day to day.

### The alarm on the key

The CloudFormation template sets up an alarm on the wrap key. It sends an email whenever the key's policy is changed, or the key is disabled, scheduled for deletion or granted:

- an EventBridge rule matches those calls on this key in CloudTrail and sends the call itself (who made it, when, from where) to an SNS topic;
- a CloudWatch alarm on that rule goes into alarm on the first match;
- a CloudTrail trail recording management events is what the rule hears through. The template creates one unless told the account already has one.

AWS emails the alarm's address once to confirm it. Until the link in that email is clicked, the alarm is silent.

The only expected alarm is the planned change of the allowed PCR0 at an upgrade. Treat any other as the service's keys being exposed: stop sending it anything, and tell partners.

### What the key policy can't do

The AWS account's administrators can still rewrite the key policy. They can't do it as themselves, but whoever administers the account's IAM can change who may assume the break-glass role, assume it, and then change the policy. An account's root user can do the same.

So the policy change is made loud and narrow, not impossible:

- it takes a second, deliberate step (taking over one named role) that leaves its own CloudTrail record;
- it raises the alarm;
- it doesn't change what partners and Mynt's server check: the attested PCRs, the wrap key's ARN and the client authority. An enclave from another image is refused by both whatever the policy says.

What a rewritten policy does allow is an image of the attacker's own to unwrap the service's root, and so to open what is sealed under it. Nothing in the account prevents that. Only keeping the account's administrators few, the break-glass role unheld, and the alarm watched does.

The enclave calls KMS directly: Signature Version 4 with the role's temporary credentials, TLS end to end through AWS's `vsock-proxy` on the parent, with no SDK.

### The health attester and Ed25519

The root is protected because the two KMS calls it uses, `GenerateDataKey` and `Decrypt`, carry the enclave's attestation document as their `Recipient`, and the key policy admits only this image's. KMS signing can't be gated on attestation in that way, so a KMS signing key would be usable by the parent instance's role directly (`deploy/confidential/src/nitro.mjs`). AWS's KMS documentation lists the calls that accept an attestation document; check it before changing this design.

The enclave therefore derives its Ed25519 attester from its root (HKDF, as the local host does). The attester exists only inside an attested enclave and is the same after every restart.

Partners check its public key the same way as the rest: it is bound into every attestation.

The attester signs in one place only: at the end of the health check, over the fingerprint of the report that check just computed. It is not a signing key a caller can use:

- `POST /v1/sign` refuses it for every caller (`reserved_key`), before the policy is even read, and `policy.json` doesn't list it. Mynt's server can read its public key and nothing more.
- The local host and both adapters refuse it the same way.

So a signature by the attester always means that the measured image opened a statement, checked it and computed that report. The report says what was checked: see [Sealed statements and snapshots](#sealed-statements-and-snapshots).

## What partners check

`GET /confidential/attestation?nonce=<16 to 64 URL-safe characters>` (public; one a second per caller address, and five a second across all callers) returns the service's own answer, relayed unchanged, with the releases Mynt has announced.

### An attestation from an enclave

From an enclave the answer has `format: "nitro-cose"`, and `token` is the attestation document (COSE_Sign1, base64). In the document:

- `nonce` is the caller's nonce;
- `user_data` is `mynt-keys-<sha256>` over the keys returned beside it;
- `public_key` is the service's TLS key.

The keys returned beside it are the service's TLS key, the ingest key partners seal to, the health attester's public key, and `config`, the settings the enclave was handed by its parent instance:

| `config` | What it is |
| --- | --- |
| `kms_key` | The ARN of the KMS key that wraps the service's root |
| `region` | That key's region |
| `client_ca_sha256` | The SHA-256 of the one authority whose client certificates the service accepts: who may call it |

The parent instance isn't trusted, and these three reach the enclave from it. So the enclave binds them into every attestation with its keys, and a verifier must be given the value it expects for each. An attestation is refused when a value differs, when the enclave binds none, or when the verifier has nothing to compare it with.

That is what stops someone with root on the parent from handing the enclave a client authority of their own and calling it as Mynt's server: the enclave would attest that authority, and Mynt's server and partners would refuse it.

### Checking it with the verify script

`core/scripts/verify-mynt-enclave.mjs --url … --expected-pcr0 … --expected-pcr1 … --expected-pcr2 … --expected-kms-key <arn> --expected-client-ca-sha256 <64 hex>` checks the attestation with nothing but Node. It checks:

- the COSE ES384 signature with the document's certificate;
- that certificate's chain, through the document's own bundle, up to the AWS Nitro Enclaves root certificate pinned in `aws-nitro.ts`, each certificate valid now;
- that the document was made in the last five minutes;
- PCR0, PCR1 and PCR2 equal to the ones published for the release, and not a debug-mode enclave's zeros;
- its own fresh nonce;
- both bindings;
- the wrap key's ARN and the client authority's SHA-256, each equal to the one given.

`--expected-kms-key` and `--expected-client-ca-sha256` are required. Without them the script stops before checking anything: an honest image whose root is wrapped by a key someone else controls, or which someone other than Mynt's server may call, would otherwise pass.

Mynt gives a partner both values when it onboards, and they don't change from one release to the next. A partner keeps the ones it was first given and asks why if the script ever reports another.

The pinned root certificate is `AWS_NitroEnclaves_Root-G1`, from AWS's `AWS_NitroEnclaves_Root-G1.zip`, never fetched from Mynt. Its SHA-256 fingerprint is:

`64:1A:03:21:A3:E2:44:EF:E4:56:46:31:95:D6:06:31:7E:D7:CD:CC:3C:17:56:E0:98:93:F3:C6:8F:79:BB:5B`

### A Confidential Space deployment

For a Confidential Space deployment the script checks an OIDC token instead, with `--expected-digest sha256:…`. It checks:

- the token's RS256 signature against the attestation service's published keys;
- `swname` `CONFIDENTIAL_SPACE`, `STABLE`, secure boot, and `dbgstat` `disabled-since-boot`;
- the image digest;
- the nonce and the key binding in `eat_nonce`;
- the key custody the service binds with its keys (`config`), each value required: `--expected-wrap-key` (the Cloud KMS key that wraps its root), `--expected-signing-key health-attester=<key version>` (once for each signing key; the service may offer no other), and `--expected-client-ca-sha256`.

On Confidential Space those names reach the workload from the VM's metadata, outside the measured image, so whoever runs the VM could point an honest image at keys of their own. The token alone doesn't show that. The bound settings do, and Mynt's server requires the same three (`CONFIDENTIAL_HOST_WRAP_KEY`, `CONFIDENTIAL_HOST_SIGNING_KEYS`, `CONFIDENTIAL_HOST_CLIENT_CA`).

### Sealed statements and snapshots

[Connecting a licence provider to Mynt](../partners.md) has the partner's steps, including sealing a live statement (`mynt.sealed_statement.v1`: X25519, HKDF-SHA256, AES-256-GCM, with the firm, environment and request bound as associated data).

A snapshot computed by the service shows `enclave: { public_key, signature_ok }` in `list_product_health`. Mynt's server recomputes the fingerprint and checks the signature before it stores anything. See [Product health](licence-providers.md#product-health).

The report the service computes carries `sealed_statement`, which says what the service checked. It is part of the report, so the fingerprint the attester signs covers it:

| Field | What it is |
| --- | --- |
| `result` | `ok`, or the code of the check that failed (the figures are then unavailable) |
| `signer_public_key` | The key whose signature over the statement verified, or null when none did |
| `as_of` | The statement's own clock |
| `checked` | What the statement was held to: the firm (`entity_id`), `environment`, `request_id`, the firm's registered `public_key`, `max_age_ms`, and the clock its freshness was judged against (`now`) |

Mynt's server refuses a report that doesn't say it checked the statement Mynt asked about, or that gives figures without a statement the firm's registered key signed.

## How Mynt's server trusts the service

The connection is TLS 1.3 with a certificate on each side:

- Mynt presents a client certificate (`CONFIDENTIAL_HOST_CLIENT_CERT`, `CONFIDENTIAL_HOST_CLIENT_KEY`: paths to files, made by `deploy/confidential/make-client-cert.sh`) from the one authority the service trusts. The same script writes that authority's certificate, `ca.crt`, which `CONFIDENTIAL_HOST_CLIENT_CA` points at. Its private key is deleted as soon as the client certificate is issued, so no other certificate can come from it.
- The service presents a key it made inside the enclave at boot, which no authority vouches for.

Before anything is sent, Mynt:

1. fetches an attestation over a connection to the service;
2. checks it as a partner would, with the PCRs required to be a release in effect in Mynt's record, the wrap key required to be `CONFIDENTIAL_HOST_KMS_KEY`, and the client authority the service accepts required to be the one in `CONFIDENTIAL_HOST_CLIENT_CA`;
3. pins the TLS key the attestation binds.

A connection presenting any other key is closed before a byte is written. The pin lasts ten minutes.

On the parent instance the TLS connection is relayed byte for byte (TCP 8443 to the enclave's vsock port 8443), so the parent sees ciphertext only.

The service allows each caller (by certificate common name) only what `deploy/confidential/policy.json` lists, and that file is part of the measured image. What is sealed for `vault-legacy-root`, `vault-keys`, `signing-key` or `partner-ledger` has no endpoint that returns it.

A common name only means something because one authority issues the certificates. The service accepts exactly one authority certificate (a bundle of several is refused at start-up) and attests its SHA-256, as [An attestation from an enclave](#an-attestation-from-an-enclave) describes.

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

The settings (region, wrap key ARN, the client authority) come from the parent and aren't secret. All three are bound into every attestation, the authority as the SHA-256 of its certificate. A parent that names another key, or hands over an authority of its own, is seen by every verifier and refused by Mynt.

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

The first release ever is in effect at once: there is nothing before it. "First" means Mynt has no sign there was ever one before, not that the release table is empty. See [What enforces a release](#what-enforces-a-release).

| Tool | Who | What it does |
| --- | --- | --- |
| `announce_enclave_release` | Mynt admin | Announces a release |
| `withdraw_enclave_release` | Mynt admin | Takes one back |
| `list_enclave_releases` | Licence providers, liquidity providers, Mynt admins | Shows them all |

### What enforces a release

- Each row carries a MAC, so someone who can only write the database can't plant a build, bring a withdrawn one back by clearing its withdrawal, or move the moment one takes effect. A row that doesn't authenticate is never in effect.
- Mynt's server refuses to talk to a service whose attested measurements aren't in effect.
- The key policy is what finally decides which image can use the keys. Only the break-glass role changes it, and each change raises [the alarm on the key](#the-alarm-on-the-key).

Changing the key policy without announcing is possible for whoever holds the break-glass role. That is why partners verify the PCRs themselves and Mynt's server refuses unannounced ones.

### The key the release record is authenticated with

The release record decides whether the confidential service is trusted, so its MAC key has to be there before the service is. On a server set to a confidential service, the key is derived from the server's client key for that service (`CONFIDENTIAL_HOST_CLIENT_KEY`): a file the server already keeps, which someone who can only write the database doesn't have. On the local host it is derived from the vault, as before.

That is what lets a server start with `MYNT_VAULT_KEY` removed. At boot it authenticates the release rows with the client key, attests the service against them, and only then has the vault's keys released. If the client key can't be read, or the rows don't authenticate with it, no release is in effect and the server doesn't start: it never falls back to trusting the rows.

Rows written before this (authenticated with the vault-derived key) are authenticated again under the client key the first time the server opens the record with the vault key at hand, which every start during the migration does.

Replacing the client certificate changes that key. Start the server once with `CONFIDENTIAL_HOST_PREVIOUS_CLIENT_KEY` set to the old key's path: rows that authenticate under the old key are moved to the new one. Then remove the setting and destroy the old key. Without the old key the rows can't be carried over: announce the build again and wait the 48 hours.

### Withdrawals and an emptied table

A withdrawal is part of what a row's MAC covers. It is also recorded outside the row, in the audit log and in the running server's memory, and either record makes the release withdrawn whatever its row says.

An announcement is "the first", and in effect at once, only when all of these hold:

- the release table has no rows, authentic or not;
- the audit log has no record of a release being announced or withdrawn;
- the confidential host keeps nothing for Mynt (no wrapped root, no vault keys), which it can't before a release was in effect;
- this server hasn't had the vault released to it by a host.

So emptying the release table, or breaking every row's MAC, doesn't buy an immediate release.

What this can't prevent: someone who can delete from the release table, the audit log and the host's keys table together, on a server that doesn't hold a released vault, can still make it look like a first install. And someone who can rewrite both a release's row and the audit log's record of its withdrawal, and who kept a copy of the row from before it was withdrawn, can put it back once the server has restarted. Both need more than write access to one table, both leave the firms' notices of the original announcement and withdrawal standing, and neither gets an image past the attestation check or the key policy.

## Confidential computing settings

Settings are given by name only.

On Mynt's server:

| Setting | What it is |
| --- | --- |
| `CONFIDENTIAL_HOST` | `local`, `aws-nitro` or `gcp-confidential-space`. Unset means `local` |
| `CONFIDENTIAL_HOST_URL` | `https://…:8443` of the parent instance's address |
| `CONFIDENTIAL_HOST_CLIENT_CERT`, `CONFIDENTIAL_HOST_CLIENT_KEY` | File paths, readable only by Mynt's user |
| `CONFIDENTIAL_HOST_CLIENT_CA` | A file path: the certificate of the authority that issued the client certificate (`ca.crt`). Public. Required for both remote hosts |
| `CONFIDENTIAL_HOST_KMS_KEY` | For `aws-nitro`: the wrap key's ARN. A name, not a secret. Required |
| `CONFIDENTIAL_HOST_WRAP_KEY` | For `gcp-confidential-space`: the name of the Cloud KMS key that wraps the service's root, as the VM's `KEYHOUSE_WRAP_KEY`. Required |
| `CONFIDENTIAL_HOST_SIGNING_KEYS` | For `gcp-confidential-space`: JSON naming each signing key's version, as the VM's `KEYHOUSE_SIGNING_KEYS`. Required |
| `CONFIDENTIAL_HOST_PREVIOUS_CLIENT_KEY` | A file path, set for one start after the client certificate is replaced: see [The key the release record is authenticated with](#the-key-the-release-record-is-authenticated-with) |

On the parent instance: `/etc/mynt-keyhouse/settings.json` (`region`, `kms_key`, `client_ca`), written by `deploy/confidential/aws/parent-setup.sh`. `client_ca` is exactly one certificate.

For Confidential Space, the VM's launcher overrides instead. They are the only names the image allows, and none is a secret: `KEYHOUSE_WIP_PROVIDER`, `KEYHOUSE_WRAP_KEY`, `KEYHOUSE_SIGNING_KEYS`, `KEYHOUSE_WRAPPED_ROOT`, `KEYHOUSE_CLIENT_CA`, `KEYHOUSE_PORT`.

## Operator steps for AWS Nitro Enclaves

One upload creates everything. No command here creates anything until the operator runs it, and none involves typing a secret into a chat.

1. **An AWS account.** Create an AWS account (or use one kept for Mynt alone), and pick one region for everything below, for example `us-east-1`.
2. **Mynt's client certificate.** On Mynt's server, run `deploy/confidential/make-client-cert.sh /etc/mynt/confidential` as Mynt's user. It writes Mynt's client certificate and key there (readable only by that user) and the authority's certificate (`ca.crt`, public). It prints two things to keep: one long line, the authority's certificate in base64, for step 5; and the authority's SHA-256, which partners need.
3. **The release.** Find the release's commit and PCRs: the `confidential-image` job's summary in CI shows the commit, `pcr0`, `pcr1` and `pcr2`. A Mynt admin announces them with `announce_enclave_release` (the first one is in effect at once).
4. **The break-glass role.** In the AWS console, open IAM and create a role that nobody holds day to day, to be assumed only for upgrades. It is the one principal allowed to change the wrap key's policy. Copy its ARN.
5. **The stack.** In the AWS console, open CloudFormation, choose **Create stack** → **With new resources**, and upload `deploy/confidential/aws/keyhouse.cloudformation.json`. Fill in:
   - `ReleaseCommit`: the commit;
   - `AllowedPcr0s`: the release's `pcr0`;
   - `MyntServerAddress`: Mynt's server's public address followed by `/32`;
   - `ClientAuthorityBase64`: the long line from step 2;
   - `KeyPolicyAdminRoleArn`: the ARN from step 4;
   - `AlarmEmail`: where the alarm on the key is sent;
   - `CreateAuditTrail`: leave `true` unless the account already has a CloudTrail trail recording management events in this region.

   Leave the rest as they are. Tick the box that lets it create a role, and create the stack. AWS emails `AlarmEmail` a confirmation link: click it, or the alarm stays silent.
6. **Mynt's settings.** When the stack shows `CREATE_COMPLETE`, its **Outputs** tab shows `ConfidentialHostUrl` and `WrapKeyArn`. On Mynt's server, set `CONFIDENTIAL_HOST=aws-nitro`, `CONFIDENTIAL_HOST_URL` (the first), `CONFIDENTIAL_HOST_KMS_KEY` (the second), `CONFIDENTIAL_HOST_CLIENT_CERT=/etc/mynt/confidential/client.crt`, `CONFIDENTIAL_HOST_CLIENT_KEY=/etc/mynt/confidential/client.key` and `CONFIDENTIAL_HOST_CLIENT_CA=/etc/mynt/confidential/ca.crt`, and restart Mynt. All of them are required: the server refuses to start with `CONFIDENTIAL_HOST=aws-nitro` and any one missing.
7. **What partners need.** Give each licence provider the wrap key's ARN (`WrapKeyArn`) and the authority's SHA-256 from step 2. They pass both to `verify-mynt-enclave`, which requires them.
8. **The root.** Run `mynt confidential status` (it shows the attested PCRs), then `mynt confidential init` once. The enclave makes its root, Mynt stores it wrapped, and it prints the wrapped form for you to keep a copy of.
9. **The vault.** Move the vault's keys to the service:
   1. Run `mynt confidential adopt`. The service adopts `MYNT_VAULT_KEY`.
   2. Restart Mynt. The vault's keys now come from the service at boot.
   3. Run `mynt confidential rewrap`. It is a dry run: counts per table and column, nothing changed.
   4. Run `mynt confidential rewrap --apply`.
   5. Run the dry run again to see zero left.
   6. Remove `MYNT_VAULT_KEY` from the server's environment file and restart. The server starts without it: the release record is authenticated with the client key, the service is attested, and the service releases the vault's keys.
   7. Destroy any copy of the old environment file kept elsewhere. Old database backups still hold values sealed with it.
10. **A new release.** Announce its PCRs and wait the 48 hours. Then assume the break-glass role (only it can change the key's policy) and, as that role, in CloudFormation choose the stack → **Update** → **Use current template**, set `ReleaseCommit` to the new commit and `AllowedPcr0s` to the old and new `pcr0` separated by a comma, and update. CloudFormation replaces the instance (same address), and Mynt hands the new enclave its root. Once it is running, update again with only the new `pcr0`. Each of the two updates raises the alarm on the key: these are the expected ones.

### What the stack makes

- one `c6a.xlarge` instance with enclaves enabled;
- the wrap key with the policy in [The key policy](#the-key-policy);
- the instance's role, with only `kms:Decrypt` and `kms:GenerateDataKey` on that key;
- a security group that admits only Mynt's server on port 8443;
- a fixed address;
- [the alarm on the key](#the-alarm-on-the-key): an SNS topic with the email subscription, an EventBridge rule and a CloudWatch alarm;
- unless `CreateAuditTrail` is `false`, a CloudTrail trail for management events in the region and a private bucket for its logs, kept 400 days.

It doesn't make the break-glass role: that one exists before the stack does, so the stack can't be used to hand it to anyone.

The instance builds the enclave from the commit on first boot (about ten minutes) and refuses to start it unless its PCR0 is the one you entered.

### Doing it by hand

To do it by hand instead, you need:

- an Amazon Linux 2023 instance of a type that supports enclaves, with 4 vCPUs: `c6a.xlarge`, `m6i.xlarge` and the like. Graviton types such as `c7g.large` support enclaves too, but this image is built for x86-64;
- **Nitro Enclave** enabled at launch, and IMDSv2 required;
- a role allowed only those two KMS calls on the wrap key;
- a symmetric KMS key with `key-policy.json` (fill in the account, the role's ARN, the break-glass role's ARN and the PCR0), set with the lockout safety check bypassed, since the account itself can't change the policy afterwards;
- an alarm of your own on `PutKeyPolicy` for that key, as the template's;
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
| The alarm, its rule and its emails | About $0.10 a month |
| The trail and its bucket | The first trail's management events are free; its logs cost cents a month to store |
| Nitro Enclaves | Nothing extra |

About $120 a month in all.

## Operator steps for Google Confidential Space

This is the alternative, with `CONFIDENTIAL_HOST=gcp-confidential-space`.

1. **A project.** In Google Cloud, create a project for the service and enable the Confidential Computing, Cloud KMS, IAM Credentials and Compute Engine APIs.
2. **Keys.** In Cloud KMS, create a key ring with a symmetric encrypt/decrypt key (the wrap key) and an asymmetric signing key with algorithm `EC_SIGN_ED25519` (the health attester).
3. **A workload identity pool.** Create a workload identity pool and an OIDC provider for it, with the values in [The OIDC provider](#the-oidc-provider).
4. **Key access for the attested image only.** Grant `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the wrap key and `roles/cloudkms.signerVerifier` on the signing key to the principal set in [Key access on Google Cloud](#key-access-on-google-cloud), and to nobody else.
5. **A service account.** Create a service account for the VM with only `roles/confidentialcomputing.workloadUser` and `roles/logging.logWriter`.
6. **Mynt's client certificate.** Make it with `deploy/confidential/make-client-cert.sh` (step 2 of the AWS steps) and put the authority's certificate (`ca.crt`, exactly one certificate) in the VM's `KEYHOUSE_CLIENT_CA`.
7. **The image.** Build the image from the release's commit (`docker buildx build --target confidential-space`, as CI's `confidential-image` job does), push it to Artifact Registry, and check the pushed digest equals the one CI printed. Then announce it (`announce_enclave_release { image_digest, … }`).
8. **The VM.** Create the VM from the `confidential-space` image family (never `confidential-space-debug`) with confidential computing on (N2D with SEV-SNP or C3 with TDX), shielded VM secure boot, and the service account above. Set the metadata `tee-image-reference` (the image by digest), `tee-restart-policy=Always`, `tee-container-log-redirect=true`, and the `tee-env-KEYHOUSE_*` settings, without `KEYHOUSE_WRAPPED_ROOT` yet. Only Mynt's server should reach its port (a firewall rule for that address only).
9. **Mynt's settings and the root.** On Mynt's server, set `CONFIDENTIAL_HOST=gcp-confidential-space`, `CONFIDENTIAL_HOST_URL`, the two certificate paths, `CONFIDENTIAL_HOST_CLIENT_CA` (the path to `ca.crt`), `CONFIDENTIAL_HOST_WRAP_KEY` (the same name as the VM's `KEYHOUSE_WRAP_KEY`) and `CONFIDENTIAL_HOST_SIGNING_KEYS` (the same JSON as the VM's `KEYHOUSE_SIGNING_KEYS`). All are required. Then run `mynt confidential init`. It prints the wrapped root. Set it as the VM's `tee-env-KEYHOUSE_WRAPPED_ROOT` and restart the VM. `mynt confidential status` then shows the attested digest.
10. **What partners need.** Give each licence provider the wrap key's name, each signing key's version and the authority's SHA-256. `verify-mynt-enclave` requires all three for a container.
11. **The vault.** Follow step 9 of the AWS steps (adopt, restart, rewrap).

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
- **The cloud account's administrators.** The AWS account's administrators can't read the enclave's memory or use the wrap key. They can't change the key policy as themselves, but they can take over the break-glass role that can, and then admit an image of their own to the wrap key. That raises the alarm and is recorded in CloudTrail; it isn't prevented. [What the key policy can't do](#what-the-key-policy-cant-do) has the detail. It is why partners check the PCRs, the wrap key and the client authority themselves and don't rely on the policy.
- **Confidential Space.** The same holds for Google, where the project's owners can grant themselves the key roles. AMD SEV-SNP and Intel TDX have had published attacks and firmware fixes, so the attestation's hardware and OS version matter.
- **The release record.** It is authenticated, but a record kept in one database can't prove its own history. [Withdrawals and an emptied table](#withdrawals-and-an-emptied-table) says what someone who can rewrite several tables at once could still do.
- **The server's client key.** Whoever can read `CONFIDENTIAL_HOST_CLIENT_KEY` on Mynt's server can call the service as Mynt's server does, and can authenticate release rows. It is a file readable only by Mynt's user, and it is all that stays on the server's disk.
- **The parent can deny service, never read.** The enclave's clock comes from its parent, and its logs go to the parent's journal (route, caller and outcome only). A parent can stop or restart the enclave, or refuse to relay.
- **Mynt's server still sees what it serves.** Entitled readers get figures through `get_product_health`, so a product's figures pass through Mynt's server on their way out. What it never sees is a partner's whole statement (every product's books) when sealed, or the vault's root.
- **Keys in the running process.** The vault's data key and derivation key are released to Mynt's running process. Someone with root on that server while it runs can read its memory. What changes is that they are no longer in a file, the environment or a backup.
- **The registered partner key.** The service trusts the partner key Mynt's server says is registered. A snapshot signed with another key fails, and the partner sees which key was used, so it can check.
- **Solana keys.** Solana keys Mynt holds (deploy authorities, the health publisher, the treasury attester) stay in the vault and sign in Mynt's process. Moving them to `signing-key` (signed inside the service) is not built.
- **In the clear.** The partner's daily-file upload and conformance stay in the clear.
- **Until the service is deployed.** Until the operator deploys the service, everything above runs on the local host, which protects nothing from whoever runs the server.
