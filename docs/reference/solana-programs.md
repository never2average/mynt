# Solana programs

This file covers how an app's Solana program is reserved, built by the coding agents, rebuilt by Mynt, deployed, called and watched; the review every mainnet deploy passes (the mainnet program gate); and how Turnkey can hold the mainnet deploy authority. It is for builders with on-chain programs, and for Mynt admins and operators who run the gate and custody.

See also: [Apps and builds](apps-and-builds.md), [Liquidity pools and on-chain treasuries](liquidity-and-treasury.md), [Firms, licences and licence providers](licence-providers.md), [Vendors and the marketplace](vendors-and-marketplace.md), [Running Mynt](operations.md).

Some apps need a program on Solana (a smart contract) beside them. Builders build them with the coding agents and deploy them through Mynt (`core/src/solana/`). Programs are builder- and firm-side only: customers never see crypto, only dollars.

## Lifecycle

A program goes through six steps, in this order:

1. [Reserve the address](#reserve-the-address)
2. [Build it](#build-it)
3. [Mynt builds it again](#mynt-builds-it-again)
4. [Deploy and upgrade](#deploy-and-upgrade)
5. [Call it](#call-it)
6. [Events](#events)

### Reserve the address

`reserve_program_id` gives the program its address before any code exists. It takes `name`, `cluster` (`devnet` or `mainnet`) and the `app_id` or `product_id` the program belongs to.

- Mynt generates the address's keypair and seals it in its vault (`MYNT_VAULT_KEY`). It is used once, at the first deploy, then deleted.
- The program declares the address in `declare_id!` and `Anchor.toml`. Mynt deploys only a program that does.

### Build it

`start_build` gives the coding agents the Solana toolchain (`solana: true`, on by default when the app has reserved programs) and the app's reserved addresses in the build spec.

- The agents scaffold an Anchor workspace in `solana/` from `core/workspaces/coding-build/templates/solana-program/`: a minimal ledger that emits an event per entry, with its tests and a committed `Cargo.lock`.
- They test it with `anchor test` on a local validator.
- They never deploy anything.

### Mynt builds it again

Mynt never deploys the agent's artifact, and none of the builder's code runs on the verify machine before Mynt has the program.

#### Fetch

Mynt fetches the source into its clean verify sandbox, checks its hash, and reads the answer itself: does the archive have an Anchor workspace?

#### Build in a container only

If it does, a run of its own (`verify.sh --solana-build`, with `solana-verify.sh build` from `core/src/solana/toolchain.ts`) compiles each program crate with `cargo build-sbf` inside Anchor's verifiable-build image, pinned by digest. This is the same command `anchor build --verifiable` runs there, so the program is reproducible.

1. **A throwaway container with a network fetches the crates.** It gets only a skeleton of the source: the `Cargo.toml` files, `Cargo.lock` and empty stub files. It gets no `.cargo/` config, no `rust-toolchain.toml`, no build script and no code. The compiler and every rustc wrapper are pinned by environment. So nothing of the builder's runs while there is a network.
2. **A fresh container compiles offline.** It is created with no network at all and no mount of the host. It gets the full source as a copy, plus the crate caches and lock from the fetch container (streamed container to container; the fetch container is removed before the build starts). It compiles as its own main process.
3. **The container stops when the build ends.** Nothing the builder's build scripts, macros or wrappers left running can touch the program afterwards.

Details:

- Mynt pins the image's own Rust for cargo itself and resolves dependencies to versions the platform tools can build. A workspace's own cargo config applies only inside the offline build.
- The program comes out with `docker cp -L`, which resolves a link inside the container instead of copying it out as a link to a host path. It is kept only if it is a regular ELF file.
- Program crate names must be plain identifiers (`^[a-z0-9_]+$`).
- The skeleton the fetch container gets stubs every place cargo looks for a target: `[lib]`, `src/main.rs`, and named `[[bin]]`, `[[example]]`, `[[test]]` and `[[bench]]` targets at their paths or cargo's default ones.
- `anchor build --verifiable` itself isn't used, because after its container it builds the IDL on the host, compiling and running the builder's build scripts and macros there.

#### Capture

When that run ends, Mynt kills every process and container of the sandbox's user, reads each program back into its own server and hashes it there.

- It reads only a regular file, never through a link, and stores it only if it is an ELF program.
- The hash is sha256 of the program with its trailing zero padding removed: the same "executable hash" `solana-verify` reports and the on-chain bytes give.
- Mynt stores those bytes with the build, and records the `solana_build` check itself. A row of that name in the later report is ignored.

#### Test

Mynt writes its scripts into the sandbox again, then runs the checks. Among them, the workspace's IDL is built (`anchor idl build`) and its `anchor test` runs on a local validator against the bytes Mynt hashed.

Test setups that would run other code at the programs' addresses are refused: `[[test.genesis]]`, validator clones, preloaded accounts, or `[programs.localnet]` pointing elsewhere.

#### Re-check

Afterwards Mynt hashes every copy of the program again. If any changed, the build is `blocked`.

#### The lock the build used

Mynt records the sha256 of the `Cargo.lock` the build compiled with (read back from the build container) next to each program's hash, on the program and on each version (`get_program`), so anyone can rebuild exactly those bytes.

- A source without a committed `Cargo.lock` still builds, with a warning in `solana_build` to commit it. The fetch container resolves one first, and that is the lock the build uses and records. See [Lock pins](#lock-pins).
- A committed `Cargo.lock` is used exactly as committed.

#### Readiness checks

Two checks join the build's readiness, `solana_build` and `solana_tests`. Either failing fails the build. Deploys use only the bytes Mynt stored.

CI's `solana-program` job follows the same path, and checks that a build script rewriting the program on the host neither changes what is captured nor goes unnoticed.

### Deploy and upgrade

`deploy_program` (`program_id`, `build_id`) deploys the program Mynt built from a **succeeded** build whose program declares the reserved address.

- Mynt deploys it itself, with the upgradeable BPF loader: a buffer account, the program written in chunks, then deploy, with twice the program's size reserved for upgrades.
- A failed deploy closes its buffer to recover the rent.

`upgrade_program` replaces the code from a newer verified build at the same address. The same bytes, or a program larger than the reserved space, are refused.

Both run in the background. `get_program` shows progress, every version with its build, hash and transaction, and recent events. `list_programs` lists a builder's programs.

#### When a deploy goes wrong

- **It landed, but Mynt didn't see it confirmed** (a timeout, a restart). Before sending anything, Mynt reads what the chain holds at the address. If that is exactly the build's program under Mynt's signer, it is recorded as deployed (or upgraded) instead of being sent again or refused. If it is an earlier build of the same program that shipped (the owner's, or someone's in the owner's firm) under Mynt's signer, that build is recorded first and the new one goes through as an upgrade, with the operation held throughout.
- **Its job died.** A running deploy refreshes its timestamp after every batch of writes. One that has gone 30 minutes without that is reconciled the same way, on the HTTP server's indexer polls only (a stdio server or a CLI command sharing the database never touches it). Otherwise it is marked interrupted and can be started again.
- **Someone sent lamports to the reserved address** (it is public once reserved). As the Solana CLI does, Mynt tops the account up, sizes it and assigns it to the loader, signed by the program's own keypair, instead of failing to create it.
- **The wrong network.** Each RPC must answer the cluster's genesis hash before Mynt sends it anything, so a devnet URL pointing at mainnet (or the reverse) is refused.
- **The RPC is rate-limiting** (see [RPC limits](#rpc-limits)). Each call waits and tries again. A batch of writes whose blockhash expired meanwhile, or that wasn't confirmed in time, is signed again on a fresh blockhash, and only its unlanded writes are sent again. A write puts the same bytes at the same offset, so sending it twice is harmless.

A deploy that still gives up keeps the program retryable. Nothing at the program's address is created before its buffer is written, and the buffer it couldn't close is closed by the next deploy or upgrade of that program before it writes a new one.

#### The registry

The registry records, per program: its address, the app or product it belongs to, cluster, version, verifiable-build hash, deployer, upgrade authority, signer backend, deploy transaction and status.

The status is `reserved`, `deploying`, `deployed`, `failed` or `closed`.

### Call it

- `simulate_program_call` runs an instruction without sending it. It returns logs, compute used and any error.
- `call_program` simulates first and sends only if the simulation succeeds.

An instruction is an Anchor `method` (snake_case; Mynt adds the discriminator) with `args_base64` (Borsh-encoded arguments), or raw `data_base64`, plus its accounts.

Each builder has two keys per cluster in Mynt's vault:

| Key | What it does |
| --- | --- |
| Fee payer | Pays every call's fees. It is never passed to a program, so no program can spend it |
| Caller key (`"$caller"` in the accounts) | Signs only when the call lists it as a signer. It is the only signer a call may have |

A call may never include Mynt's deploy authority or the fee payer, so one firm's program can never act with a key that controls another's.

#### Funding call keys

On devnet, Mynt funds a builder's keys before it simulates. A fee payer that doesn't exist on chain yet fails a simulation with `AccountNotFound`.

- The fee payer is funded to 0.005 SOL.
- The caller, when the call lists `$caller` as a signer or writable, is funded to 0.02 SOL. That is enough for the rent of a typical small account an Anchor `initialize` creates with `payer = caller`.
- A bigger account's shortfall is read from the simulation's own log and sent before simulating once more.

Mynt asks the devnet faucet first. When the faucet refuses (it rate-limits servers), Mynt's devnet deploy authority sends just the shortfall in a separate system transfer to the builder's own key:

| Limit | Setting | Default |
| --- | --- | --- |
| At most this much at once | `SOLANA_DEVNET_TOPUP_MAX_SOL` | 0.05 |
| At most this much per builder in any 24 hours | `SOLANA_DEVNET_TOPUP_DAILY_SOL` | 0.25 |
| Never what would leave the authority with less than this | `SOLANA_DEVNET_AUTHORITY_KEEP_SOL` | 0.1 |

Every top-up is in the audit log (`solana_devnet_topup`, with its source, amount and signature). That transfer is not a call: the deploy authority still never signs, pays for or appears in a builder's transaction.

On mainnet nothing is funded automatically. A simulation or call with an unfunded fee payer is refused with the fee payer's address to fund.

### Events

Mynt's indexer polls every deployed program's new transactions: every `SOLANA_INDEX_POLL_MS` (default 30 s), up to 1,000 per program per poll, oldest first, the rest on the next poll, none skipped.

| Event on the owning firm's webhooks | When |
| --- | --- |
| `program.event` | Each Anchor event the program itself logged (`emit!`), with the event's name from the build's IDL and its data in base64. Once each |
| `program.deployed` | A deploy |
| `program.upgraded` | An upgrade |

Devnet events are sandbox deliveries. Mainnet's are live. See [Firm webhooks](vendors-and-marketplace.md#firm-webhooks).

## Signers

Every deploy, upgrade and call goes through one signer interface (`core/src/solana/signer.ts`):

| Backend | Cluster | How it signs |
| --- | --- | --- |
| `devnet-vault` | devnet | A Mynt-generated key sealed in the vault. Mynt asks the devnet faucet for rent. When the faucet's limit is reached, the error names the address to fund. The same key tops up builders' devnet call keys when the faucet refuses them, within the limits in [Funding call keys](#funding-call-keys) |
| `mainnet-vault` | mainnet | A key in Mynt's vault, generated by `configure_solana_signer` (only its address is ever shown) or imported by the operator on the server with `mynt solana import-key --cluster mainnet --file <keypair.json>`. Needs `SOLANA_MAINNET_VAULT_SIGNER=enabled` on the server |
| `custody-service` | mainnet | [Turnkey](#turnkey-custody) holds the deploy authority, an Ed25519 Solana account in a Turnkey wallet, and signs each transaction without Mynt seeing the key. Needs the three `TURNKEY_*` settings on the server |
| `multisig` | mainnet | A multisig (Squads style) holds the upgrade authority and its members approve each change as a proposal. The interface is in place. Until a multisig client is connected it refuses |

## Closing a program

`close_program`, for Mynt admins, closes a deployed devnet program for good.

- It uses the upgradeable loader's Close instruction on the program's data. The accounts are the program data, the recipient, the upgrade authority as signer, and the program.
- It is signed by Mynt's devnet deploy authority, so the program data's rent comes back to that authority.
- Closing is refused unless the chain shows Mynt's devnet authority as the program's upgrade authority.
- A leftover deploy buffer is closed too.
- The program can't run or be deployed again. Its record is marked `closed`, and the close is audited with the signature and the lamports returned.
- Mainnet programs are refused. Mynt never closes one.

`remove_app` closes each deployed devnet program of the app this way before deleting anything. See [Removing a test app](platform-admin.md#removing-a-test-app).

## Mainnet

Mainnet is off until a Mynt admin turns it on. Every mainnet deploy, upgrade, simulation and call is refused with "Mainnet signer not configured: …", naming everything still missing, until all of these hold:

1. `SOLANA_RPC_URL_MAINNET` is set.
2. A Mynt admin has chosen a backend with `configure_solana_signer`, and that backend is ready:
   - for `mainnet-vault`: the server flag and a key in the vault;
   - for `custody-service`: Turnkey's settings set, its API key pair matching, and a custody address configured.
3. The admin has set `enabled: true`.

Also:

- Program calls on mainnet sign with per-builder vault keys, so they need the `mainnet-vault` backend.
- Every mainnet deploy and upgrade needs an approved review from the [mainnet program gate](#mainnet-program-gate).
- `configure_solana_signer` with no arguments shows the current state.
- `list_all_programs` shows every program on both clusters.

## Toolchain

The toolchain is pinned in `core/schemas/solana-toolchain.json`. Each download is checked against its sha256 before use. It holds:

- Agave: the Solana CLI, `solana-test-validator` and `cargo-build-sbf`;
- the Anchor CLI, built from its tagged commit where the release binary's glibc is too new;
- Rust, through rustup;
- Anchor's verifiable-build image, by digest;
- the `@coral-xyz/anchor` client the template's tests use.

It installs under `~/.mynt-solana` in the background when a Solana build's sandbox starts: about 2 GB, a few minutes. Agave publishes Linux binaries for x86_64 only.

CI's `solana-program` job installs the same toolchain with the same script, and builds and tests the template program the same way Mynt's verify sandbox does.

Every program Mynt builds, every deployed version and `get_program` record the exact toolchain (`toolchain`: versions, image digest and the pins' sha256), so an old version can be rebuilt with the same tools.

### Lock pins

When a program's source commits no `Cargo.lock`, Mynt resolves one in the fetch container. It then moves any crate on the pin list, `core/schemas/solana-lock-pins.json`, back to the release named there. A committed `Cargo.lock` is never changed.

How Mynt resolves a lock:

1. It resolves with Cargo's MSRV-aware resolver (`CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback`), from each program's `rust-version` (1.84 in the template).
2. For each pin, it moves any locked version of the crate from `from` up to, but not including, `below` to `precise`.

Each pin in the file has `crate`, `from`, `below`, `precise` and `why`. `core/src/solana/toolchain.ts` reads the file.

Why pins exist: the SBF platform tools compile with their own, older Cargo (1.84 with Anchor 0.32.1). It can't even read a crate that needs edition 2024, and the resolver can't avoid one that a compatible crate requires outright.

The one pin today:

| Crate | From | Below | Pinned to | Why |
| --- | --- | --- | --- | --- |
| `ahash` | 0.8.13 | 0.9.0 | 0.8.12 | `ahash` 0.8.13 (Rust 1.60) requires `getrandom` 0.4 (edition 2024) for wasm32, and a `Cargo.lock` lists every target's crates |

A pin is removed when the toolchain moves to a Cargo that reads the newer release.

A committed `Cargo.lock` is used exactly as committed. If a crate in it needs a newer Cargo, the build fails and says to pin it with `cargo update -p <crate>@<version> --precise <older>`.

The starter program and Mynt's own program (`core/programs/product-health`) commit a `Cargo.lock` resolved the same way, so their builds don't change when crates.io does.

- `node core/scripts/solana-lock.mjs <workspace>...` (after `npm run build` in `core/`) regenerates them in the pinned image. A toolchain bump that moves Anchor or the image needs this.
- CI's `solana-program` job fails while a committed lock is stale.
- The same job builds the template with its committed lock (used unchanged, no warning) and once without one (resolved, built, with the warning).

### Keeping the toolchain current

`.github/workflows/solana-toolchain-watch.yml` runs `core/scripts/solana-toolchain-watch.mjs` every Monday, and on demand.

It finds new stable releases that have been public for at least `TOOLCHAIN_MIN_RELEASE_AGE_DAYS` (default 3):

- Anchor's patch releases by default, or its newest release with `anchor_line: latest`, with its verifiable-build image (the Solana Foundation's registry preferred);
- Agave on the line that Anchor release builds its image with;
- Rust stable;
- rustup;
- the client.

It computes their sha256s and the image digest itself, and checks RustSec (through OSV) and GitHub's advisory database for the pinned and proposed versions.

It opens a pull request that rewrites:

- the pins;
- the template program;
- the treasury template's toolchain strings: its `rust-toolchain.toml` channel and the `toolchain` its manifest `core/schemas/solana-treasury-template.json` names. It never rewrites the treasury's build hashes, which CI's `solana-treasury` job checks and a person re-records after re-reviewing the treasury when Agave, Anchor or the image moves;
- the version-matched docs the coding agents read (`core/workspaces/coding-build/docs/solana`, Anchor's and Agave's docs at the pinned tags);
- the vendored `solana-dev` skill, at its latest tagged release, or a commit at least as old as the minimum age, with a link to the upstream diff.

What the pull request's title says:

- When an advisory affects a pinned tool and the proposed versions are clear of it: **URGENT (security advisory): fixes GHSA-…**
- When they aren't: **advisory GHSA-… still unfixed upstream; this bump doesn't address it**. That one isn't urgent, and the body says so too.
- **BREAKING** for a new Anchor or Agave major or minor.

How it runs:

- The watcher runs with read-only access and hands a patch to a second job that only commits it and opens the pull request.
- A failure to open the pull request fails the run and opens an issue.
- Its CI is the `solana-program` job.

**A person reviews every toolchain-watch pull request before it is merged. They are excluded from any standing instruction to merge green pull requests.**

The repository must allow GitHub Actions to create pull requests (Settings, Actions, General, "Allow GitHub Actions to create and approve pull requests"), or hold a GitHub App installation token scoped to this repository as the `TOOLCHAIN_WATCH_TOKEN` secret.

### Pre-built environment

Where the sandbox host can snapshot a machine (Freestyle can; boat.dev can't), Mynt installs the toolchain and pulls the image once, in a machine that runs only Mynt's scripts.

1. Mynt hashes what the machine holds: every file, mode and link of the toolchain, the SBF platform tools, `~/.docker`, `~/.cargo` and `/etc/docker/daemon.json`, and the image's id, digests and layers.
2. It keeps that hash in its database and snapshots the machine.
3. Solana build and verify sandboxes then boot from the snapshot and re-hash it with Mynt's own script before anything else runs. The toolchain's env file, which agents wait for, is held back until it passes.

The snapshot is used only when the hash matches. On a mismatch, or any check that doesn't finish cleanly, the toolchain and image are wiped (by Mynt itself when the check didn't) and installed from the pinned, checksum-verified downloads, or the verify sandbox is replaced by a plain one.

This is drift detection, not tamper-proofing. It runs with the snapshot's own tools, and the supply chain is protected by the pinned checksums and digest, as without a snapshot.

Other details:

- A booted VM's randomness is reseeded with a per-VM nonce from Mynt.
- The snapshot is keyed by the pins, the scripts, the host's machine setup and the sandbox type.
- It is rebuilt when older than `SOLANA_BUILD_SNAPSHOT_MAX_AGE_DAYS` (default 7).
- Another key's snapshot is deleted only after nothing has booted from it for six hours.
- Mynt admins see it, build it ahead of time or replace it with `solana_build_environment`.
- `SOLANA_BUILD_SNAPSHOT=off` turns it off.

## Solana settings

| Setting | What it is |
| --- | --- |
| `MYNT_VAULT_KEY` | Required. Programs' and signers' keys are sealed with it |
| `SOLANA_RPC_URL_DEVNET` | Default: the public devnet endpoint |
| `SOLANA_RPC_URL_MAINNET` | No default. It may carry a provider key, so it is treated as a secret and never shown |
| `SOLANA_MAINNET_VAULT_SIGNER=enabled` | Only for the `mainnet-vault` backend |
| `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY` | Only for the `custody-service` backend. The private key is a secret |
| `TURNKEY_APPROVAL_TIMEOUT_SECONDS` | Optional |
| `SOLANA_INDEX_POLL_MS`, `SOLANA_CONFIRM_TIMEOUT_MS` | Optional |
| `SOLANA_RPC_MAX_RPS`, `SOLANA_RPC_MAX_RETRY_SECONDS` | Optional. See [RPC limits](#rpc-limits) |
| `SOLANA_DEVNET_TOPUP_MAX_SOL`, `SOLANA_DEVNET_TOPUP_DAILY_SOL`, `SOLANA_DEVNET_AUTHORITY_KEEP_SOL` | Optional. Devnet call-key top-ups; see [Funding call keys](#funding-call-keys) |
| `SOLANA_BUILD_SNAPSHOT`, `SOLANA_BUILD_SNAPSHOT_MAX_AGE_DAYS` | Optional. See [Pre-built environment](#pre-built-environment) |

RPC calls follow Mynt's outbound rules: HTTPS, no private or loopback addresses, no redirects, time and size limits.

The gate's own settings are in [Budget](#budget) and [Retention](#retention).

### RPC limits

The public devnet endpoint Mynt uses by default is rate-limited per address. Solana documents 100 requests per 10 seconds in all and 40 per 10 seconds for any one method. A deploy sends one write transaction per kilobyte or so of program: about 450 for a 450 KB program.

Mynt copes in two ways.

**Pacing.** A deploy's buffer writes go out at `SOLANA_RPC_MAX_RPS` requests a second, shared by every deploy on that cluster.

- By default that is 4 a second on the public devnet endpoint (about two minutes for 450 writes).
- It is 25 a second when `SOLANA_RPC_URL_DEVNET` names another RPC, and on mainnet.
- Setting `SOLANA_RPC_MAX_RPS` sets both clusters' pace.

**Retrying.**

- A call answered with HTTP 429 or 503, or with a JSON-RPC error that means rate limiting (code -32005, or wording such as "Too many requests"), is retried with exponential backoff and jitter. It waits what a `Retry-After` header asks for (seconds or a date, at most 60 s a time).
- HTTP 502 and 504, which can come back after the node took the request, are retried only for calls that are safe to repeat: reads, and `sendTransaction`, because a signed transaction lands once by its signature however often it is sent.
- An airdrop isn't sent twice. A rate-limited airdrop fails at once instead of waiting: the faucet's limit lasts hours, so Mynt funds another way.
- One call waits at most `SOLANA_RPC_MAX_RETRY_SECONDS` in all (default 120) and then fails with a message that says the RPC was still rate-limiting. The message never includes the RPC's URL or host, which may carry a provider's key.

For faster devnet deploys, the operator sets `SOLANA_RPC_URL_DEVNET` on the server to a devnet URL from an RPC provider. Like the mainnet URL, it may carry the provider's key, so it is set by the operator in the server's environment and never shown.

### What the operator provides for mainnet

- A mainnet RPC provider's URL as `SOLANA_RPC_URL_MAINNET`.
- A signer choice.
- SOL for whoever pays deploys: about 0.021 SOL per KB of program. The program data reserves twice its size, and the upload buffer holds a copy until the deploy.
  - With `mainnet-vault`, that is the deploy authority's address.
  - With `custody-service`, that is the **deploy payer** (`deploy_payer` in `configure_solana_signer`). The custody address needs none.
- SOL at each builder's fee-payer address for calls, and at their caller address when their programs make the caller pay rent.

## Mainnet program gate

Every mainnet deploy and every mainnet upgrade passes a review first (`core/src/solana/mainnet-gate.ts`).

- `deploy_program` and `upgrade_program` on mainnet are refused unless an **approved** review covers exactly the build's program (its verifiable-build hash).
- Devnet is unchanged and has no gate.
- Without the gate (no sandboxes, no agent backend, or no `PUBLIC_URL`), mainnet deploys are refused. It fails closed.

The review has four parts: [hard rules](#hard-rules), a [white-box audit](#white-box-audit), a [black-box red team](#black-box-red-team), and [sign-off and timelock](#sign-off-and-timelock).

### Gate tools

| Tool | Who | What it does |
| --- | --- | --- |
| `request_mainnet_review` | Builder | Asks for a review. Takes the `program_id` of a mainnet program and the `build_id` of a succeeded build |
| `get_mainnet_review` | Builder | Status, step, every check's result, the findings, cost, decision, an upgrade's timelock, and the review's own audit log |
| `cancel_mainnet_review` | Builder | Cancels a review |
| `list_mainnet_reviews` | Mynt admin | Lists reviews |
| `approve_mainnet_program` | Mynt admin | Approves. Its answer shows the whole report again. `allow_exceptions` must name every exception the review lists |
| `reject_mainnet_program` | Mynt admin | Rejects |

A program has one open review at a time. A partial unique index enforces it, whatever races.

Reviews are stored in `solana_mainnet_reviews` with an append-only `solana_mainnet_review_log`. Every request, approval, rejection and cancellation is also in Mynt's audit log.

### What the gate reviews

Mynt's verify build keeps three things next to the bytes, read back and hashed by Mynt. A build made before this capture existed has none of them and can't pass: build it again.

#### The workspace exactly as it went into the build container

The build archives the workspace once, feeds that very archive to the build container, and keeps it (`solana_program_sources`): text files as text, others as base64, links as links.

- The archive holds every file type, dot-folders such as `.cargo/` included, and nested `target/` or `node_modules/` folders included.
- Only the top-level `target/`, `node_modules/` and `.anchor/` are left out, as the container copy always did.
- A workspace over 16 MB fails the build. Nothing is ever silently left out.

A workspace that ships build output fails the build too, with the paths named:

- a cargo target folder at any depth below the top level: a folder named `target` that holds cargo's `.rustc_info.json` or `CACHEDIR.TAG`. A source module folder that happens to be called `target` is fine;
- a folder named `docker-target` or `.anchor`;
- cargo's `.fingerprint/` folders;
- `*.rlib`, `*.rmeta`, `*.d` or `*.so` files;
- a file name with control characters.

Cargo's target dir in the build and IDL containers is `/mynt-target`, outside the source and empty when the build starts. So nothing shipped can pass for a "fresh" artifact cargo would reuse instead of compiling. The programs, dep-info and IDL are read only from there.

This holds for every build, devnet included: Mynt compiles every program itself.

#### Every dependency the build used

`solana_program_deps` holds:

- each crate of the `Cargo.lock` the build compiled with, its source and its checksum;
- the sha256 of the `.crate` cargo downloaded in the fetch container (before any of the builder's code ran), compared with that checksum;
- the full source of every crate not on the crate allowlist (up to 16 MB);
- the `Cargo.lock` itself.

#### The IDL built in Mynt's own offline container

The IDL is built in a third container with no network. It gets a fresh copy of the same source and crates after the programs are out, so `anchor idl build` (which runs the workspace's code) can't touch them.

The test run's IDL, built on the host by the workspace's own code, is kept only to name events and never replaces it.

### Hard rules

The hard rules (`core/src/solana/program-rules.ts`) are driven by the [vulnerability database](#vulnerability-database). They are deterministic, run by Mynt in-process when the review is requested, with no model.

- Entries whose gate is `block` refuse the program.
- `flag` entries are recorded as leads the audit agent must confirm or dismiss.
- A finding names the entry's id, what was found, where, and by which signal.

The rug-pull entries are these.

#### No value-moving programs for now

Refused:

- references to `anchor_spl::token`, `token_2022`, `token_interface`, `associated_token`, `spl_token`, `spl_token_2022` or `spl_associated_token_account`;
- token CPIs: `transfer`, `transfer_checked`, `mint_to`, `burn`, `approve`, `set_authority`, `close_account`;
- system-program transfers and assigns (`system_program::transfer`, `system_instruction::transfer`/`assign`, `SystemInstruction::Transfer`), with a note when the file signs CPIs with the program's own PDAs;
- lamports moved by hand: `sub_lamports`, `add_lamports`, `lamports.borrow_mut()`.

#### No hidden admin

Refused:

- an `#[account(address = …)]`, `constraint` or `owner` constraint, a `require!`/`require_keys_eq!`, or an `==`/`!=` comparison against a hard-coded key (`pubkey!`, `Pubkey::from_str`, `Pubkey::new_from_array`, or a `const` holding one; well-known program and sysvar ids aside);
- an authority, admin or owner field set to anything but the key of an account that signs that instruction (an argument, a non-signer account). `Pubkey::default()` to renounce is fine;
- an Anchor `close = target` whose target doesn't sign.

A hard-coded key equal to Mynt's own mainnet signer is noted, not refused. No program should need it.

#### The upgrade authority stays with Mynt's mainnet signer

The upgrade authority is the `mainnet-vault` key or Turnkey custody (`custody-service`). For an upgrade, the program's recorded authority must be that signer.

While mainnet's signer isn't configured this is `pending`. It is asserted again at approval and when the deploy or upgrade starts. The deployer also refuses any other backend on mainnet.

#### Three ways of looking

Each rule looks three ways, because each alone can be fooled.

| Signal | What it reads |
| --- | --- |
| Source | The captured Rust with comments stripped. A comment can neither hide code nor create a finding |
| IDL | Instructions taking a token program (by its fixed address or name) or a token account, and accounts pinned to a fixed address that must sign |
| Bytes | The SPL Token, Token-2022 and Associated Token program ids embedded in the sBPF program, raw or as base58 text, plus the 32 bytes of any hard-coded key the source checks against, as corroboration |

Limits, returned with every result:

- The source scan is pattern-based, not a compiler. Macro-generated code, hand-built CPI bytes or an authority passed through more than one variable can be missed.
- The IDL is built by the workspace's own code and shows only what Anchor records.
- The bytes show only ids the program embeds. The System Program's id is all zeros, so system transfers are invisible there.

Without captured source a program is refused.

### What the rules read

The rules read what the compiler read. The authority is rustc's own dep-info.

After the build, Mynt streams the stopped build container's `/workdir` and unpacked crates out as tar (hashed, never unpacked). It keeps every dep-info file cargo wrote (`/mynt-target/**/*.d`, outside build scripts' `out/` folders) with the sha256 of the container's copy of every workspace and registry file, and of every file in each downloaded `.crate` (`solana_program_depinfo`).

The review refuses a build when:

- a file the compiler read is missing from the captured workspace, or differs from it (something rewrote it during the build);
- a file the compiler read isn't in its crate's `.crate`, or differs;
- a file belongs to a crate not in the `Cargo.lock`;
- a file lies outside the workspace and the crates.io registry cache;
- a file is in the target dir, other than in a build script's `out/` folder of a crate in the `Cargo.lock` or of a workspace crate whose build script is an exception;
- a dep-info line isn't a rule, or a path has control characters;
- the build has no dep-info record.

The rules then read exactly the workspace files listed, wherever they are (a real module under `tests/` or a nested `target/` included).

- Files generated by a workspace crate's build script are listed as exceptions.
- When any build-time code ran (a workspace build script or proc macro, or a dependency's build script, which is nearly always), the rules also read every captured `.rs` file, not only dep-info's list.
- A hit that would block in a file dep-info doesn't list (an integration test under `tests/`, say) doesn't refuse the review. It becomes an exception, `uncompiled-hit:<file>`, that the approving admin must name. The deploy-time re-check refuses any such hit the approval didn't name.
- Manifest patterns (such as `overflow-checks`) read every captured `Cargo.toml`.

Residual risk: dep-info is written in the same container where build scripts and proc macros run, so such code could rewrite a `.d` file. Any compiled file whose contents changed is still refused, and reading every captured `.rs` file covers what a rewritten `.d` could hide from the workspace. A dependency's build script is trusted by being on the allowlist or named by an admin.

#### Module resolution as a cross-check

Mynt's own module resolution is only a cross-check. It takes crate roots from the manifests, read with a real TOML parser (`smol-toml` 1.9.1, so dotted keys and inline tables mean what they mean to cargo), then follows `mod`, `#[path]` and `include!`.

- Wherever it disagrees with dep-info, in either direction, that is an exception (`module-tree-mismatch:<file>`) the admin must name, and the review's caveats say so.
- A module path chosen by `cfg_attr(..., path = ...)` is always an exception, and the resolver follows every candidate.
- A manifest that isn't valid TOML is an exception too.

### Exceptions

What can change the build beyond the reviewed source is listed as **exceptions**, each with an id. A Mynt admin must name every one in `allow_exceptions` to approve. The review still runs every gate, so the admin decides with the full report.

Exceptions:

- a `.cargo/config` or `.cargo/config.toml` anywhere in the workspace with any setting beyond the template's `[resolver] incompatible-rust-versions = "fallback"` (which Mynt's build sets by environment anyway);
- a build script in any package;
- a procedural-macro crate in the workspace;
- `[patch]` or `[replace]`;
- `include!`, `include_str!` or `include_bytes!` of a file that isn't Rust text, or of a path that isn't a plain string (`concat!(env!("OUT_DIR"), ...)`);
- `#[path]` to a non-`.rs` file;
- a `mod` whose file isn't in the workspace (generated at build time);
- links.

A `rust-toolchain.toml` isn't an exception. The build pins `RUSTUP_TOOLCHAIN` by environment, which outranks it, and `cargo build-sbf` compiles with the platform tools' own Rust.

### Dependencies

Every crate must come from crates.io. A git or other-registry source, or a path dependency outside the captured workspace, is refused. The crate the build used must match `Cargo.lock`'s checksum.

A crate on `core/schemas/solana-crate-allowlist.json` passes.

- The list holds exact names only (crates.io has no namespaces).
- It is generated from the template's `Cargo.lock`. CI fails if the template resolves a crate that isn't on it.
- It is changed only by a reviewed pull request.
- Allowing a crate by name trusts whoever owns it on crates.io. A new release they publish is accepted once a `Cargo.lock` resolves it: checksum-verified and cargo-audited, but not reviewed line by line. So the list stays short, and an Anchor or Solana upgrade means reviewing it again.
- It also lists crates that are never allowed, because they move value: `anchor-spl`, `spl-token`, `spl-token-2022`, `spl-associated-token-account`.

Any other crate is an exception (`crate:<name>@<version>`) an admin must name. The hard rules run over its source too: a blocking finding there refuses the program. The auditor gets those crates' source beside the program's.

### The IDL

The IDL is used only if every instruction it lists is in the program's bytes: its 8-byte discriminator, as stored data, a 64-bit load, or two 32-bit immediates. An IDL naming an instruction the program doesn't have refuses the review.

The agents and Mynt's PoC re-run get it with the builder's free text neutralised: no doc strings, error messages or constant values, and names cut to 64 characters.

An instruction the IDL leaves out can't be found this way, which every review says.

### Vulnerability database

The database is `core/schemas/solana-vulnerabilities.json`, version 2, read by `core/src/solana/vuln-db.ts`. It has one entry per vulnerability class:

- id, title, severity, category and gate (`block` or `flag`);
- a description;
- detections;
- public references: incident write-ups, the Sealevel attacks, Trail of Bits' not-so-smart-contracts, Neodyme, Helius, the crates' docs;
- a bad and a good fixture under `core/test/fixtures/`.

Detections:

| Detection | What it is |
| --- | --- |
| `source_pattern` | A regular expression over the comment-stripped Rust, with an optional `unless` that clears a file, an `absent` pattern, or a named built-in analysis |
| `idl_shape` | A shape in the IDL |
| `bytecode_program_ref` | Program ids in the bytes |
| `dependency_advisory` | cargo-audit's RustSec findings |
| `red_team_scenario` | How to attack it, for the agents |

`core/test/mainnet-gate.test.js` checks every entry against both fixtures. Its detections must catch the bad one and pass the good one, and the template program must trigger none.

The audit and red-team agents get the whole database in their sandboxes (`job/vulnerabilities.json`) as their checklist.

#### Entries

| Entry | Category | Severity | Gate | Class |
| --- | --- | --- | --- | --- |
| `RUG-TOKEN-CPI` | rug_pull | critical | block | Value moved through the token programs |
| `RUG-SYSTEM-TRANSFER` | rug_pull | critical | block | SOL moved by system-program transfers or assigns |
| `RUG-LAMPORT-DRAIN` | rug_pull | critical | block | Lamports moved by hand between accounts |
| `RUG-HARDCODED-ADMIN` | rug_pull | critical | block | Hard-coded admin key |
| `RUG-AUTHORITY-ARBITRARY` | rug_pull | critical | block | Authority handed to an account that doesn't sign |
| `RUG-CLOSE-NON-SIGNER` | rug_pull | critical | block | Account close pays a non-signer |
| `RUG-MINT-FREEZE-AUTHORITY` | rug_pull | critical | block | Retained mint or freeze authority |
| `RUG-TOKEN2022-EXTENSIONS` | rug_pull | critical | block | Token-2022 permanent delegate or transfer hook |
| `AC-MISSING-SIGNER` | access_control | critical | flag | Authority account that isn't required to sign |
| `AC-MISSING-OWNER` | access_control | high | flag | Account data read without an owner check |
| `AC-HAS-ONE` | access_control | critical | flag | Stored authority not matched to the signer |
| `AC-REMAINING-ACCOUNTS` | access_control | high | flag | remaining_accounts used without checks |
| `AV-TYPE-COSPLAY` | account_validation | high | flag | Account type not checked (type cosplay) |
| `AV-BUMP-CANONICAL` | account_validation | high | flag | PDA without the canonical bump |
| `AV-SEED-COLLISION` | account_validation | medium | flag | PDA seeds without a fixed prefix (seed collision, PDA sharing) |
| `AV-DUPLICATE-MUT` | account_validation | high | flag | Duplicate mutable accounts |
| `AV-SYSVAR-UNCHECKED` | account_validation | high | flag | Sysvar account address not checked |
| `AV-INIT-FRONTRUN` | account_validation | medium | flag | Re-initialization or front-run initialization (init_if_needed) |
| `AV-CLOSE-REVIVE` | account_validation | high | flag | Closed account that can be revived |
| `CPI-ARBITRARY` | cpi | critical | flag | Arbitrary CPI: the called program isn't checked |
| `CPI-SIGNER-PRIVILEGE` | cpi | critical | flag | Signer privileges passed to an unchecked program |
| `CPI-STALE-RELOAD` | cpi | medium | flag | Account data used after a CPI without reload |
| `SIG-UNCHECKED-SYSVAR-LOAD` | signatures | critical | block | Instructions sysvar read without checking it (Wormhole) |
| `SIG-INTROSPECTION-PROGRAM-ID` | signatures | high | flag | Instruction introspection that checks only the index |
| `SIG-REPLAY-NONCE` | signatures | high | flag | Signed message without a nonce or expiry (signature replay) |
| `SIG-DOMAIN-SEPARATION` | signatures | high | flag | Signed message not bound to this program or cluster (cross-program / cross-cluster replay) |
| `AR-OVERFLOW` | arithmetic | high | flag | Integer overflow or underflow |
| `AR-PRECISION` | arithmetic | medium | flag | Precision loss and rounding direction |
| `AR-DIV-ZERO` | arithmetic | medium | flag | Division by a value that can be zero |
| `AR-CAST-TRUNCATION` | arithmetic | medium | flag | Casting truncation |
| `EC-SLIPPAGE` | economic | high | flag | Swap or trade without slippage bounds (front-running, sandwich) |
| `EC-ORACLE` | economic | high | flag | Oracle price used unchecked (stale, low confidence, manipulable) |
| `EC-TIMESTAMP` | economic | low | flag | Timestamp or slot dependence |
| `EC-RANDOMNESS` | economic | high | flag | Insecure randomness |
| `DOS-UNBOUNDED` | resource | medium | flag | Unbounded vectors or loops |
| `DOS-REALLOC` | resource | medium | flag | Account growth or realloc abuse |
| `DOS-COMPUTE` | resource | low | flag | Compute exhaustion |
| `DOS-RENT` | resource | medium | flag | Account created without rent exemption |
| `DEP-RUSTSEC` | dependencies | high | block | Dependency with a RustSec advisory |
| `DEP-GHSA-6PX8-6MW3-4HX4` | dependencies | high | block | anchor-lang's `lazy-account` feature, or `LazyAccount::unload()` after a CPI ([GHSA-6px8-6mw3-4hx4](https://github.com/advisories/GHSA-6px8-6mw3-4hx4): no owner or discriminator check after the CPI; anchor-lang 0.31.0 and later, no patched release) |

#### The lazy-account entry

`DEP-GHSA-6PX8-6MW3-4HX4` reads two signals:

- any `Cargo.toml` in the workspace that turns on anchor-lang's `lazy-account` feature: a dependency's `features`, renamed with `package =` or not, under `[dependencies]`, `[workspace.dependencies]` or a target table, or a `[features]` entry naming `anchor-lang/lazy-account`;
- a function that calls `.unload()` after a CPI in a file that uses `LazyAccount`.

It blocks on mainnet. On devnet, `deploy_program` and `upgrade_program` still deploy and return the same findings as `warnings`, saying mainnet would refuse the program.

#### Classes merged into other entries

| Class | Entry |
| --- | --- |
| A one-step authority transfer (the new holder never signs) | `RUG-AUTHORITY-ARBITRARY` |
| Uninitialized accounts | `AV-INIT-FRONTRUN` |
| Cross-program and cross-cluster replay, and missing replay protection on off-chain messages | `SIG-DOMAIN-SEPARATION` and `SIG-REPLAY-NONCE` |
| Rounding direction | `AR-PRECISION` |
| Front-running and sandwiching | `EC-SLIPPAGE` |

Most non-rug-pull detections are heuristics (a file-level `unless`, names like `*_program` or `swap`). That is why they flag and don't block: the auditor confirms them against the source, and its verified critical or high findings block.

#### Changing the database

- Mynt admins see the database with `list_vulnerability_rules` and suggest entries with `propose_vulnerability_rule`, which checks the entry's shape and stores it as a proposal (`solana_vuln_rule_proposals`).
- Only a pull request that adds the entry with its fixtures changes the database.
- `core/scripts/vuln-db-suggest.mjs [--since YYYY-MM-DD]` turns new RustSec advisories (through OSV) against Solana, Anchor, SPL, crypto and serialization crates into suggested entries for that review. It never edits the file.

#### A new version re-checks what is deployed

When the server starts on a higher database version, the gate's worker runs the new hard rules on every deployed mainnet program: its stored bytes, IDL and captured source.

A program that fails is flagged (`solana_program_flags`):

- its firm gets `program.review_flagged`;
- Mynt admins see it in `list_program_flags` and `ops_status`;
- its upgrades (requests, approved and scheduled ones) wait until an admin records a review with `resolve_program_flag`.

The program keeps running. Mynt never takes one down.

### White-box audit

The audit runs in a fresh sandbox of Mynt's that gets only the captured source.

#### Static analysis

Each tool is pinned by sha256:

- [cargo-audit](https://github.com/rustsec/rustsec) 0.22.2 (the release binary) against the RustSec advisory database, fetched fresh each run, for the `Cargo.lock` the build compiled with;
- [Radar](https://github.com/Auditware/radar) (Auditware; GPL-3.0, run, not vendored) at commit `3439053`, its source tarball by sha256 and its four images by digest.

Radar honours `radar-disable` comments in what it scans, so Mynt removes them from its copy first.

What blocks:

- a tool that couldn't run;
- a cargo-audit vulnerability;
- a Radar critical or high finding of medium or high certainty.

Radar's low-certainty findings go to the audit agent as leads.

`PROGRAM_GATE_CARGO_AUDIT_IGNORE` (comma-separated `RUSTSEC-YYYY-NNNN` ids) lets the operator accept an advisory that can't reach an on-chain program. It is shown in every report.

#### The program-audit agent

The program-audit agent (`core/workspaces/program-audit/`) runs in the same sandbox after Mynt has read the tools' results.

- It reads the source, Mynt's hard-rule results and the static findings, and writes JSON findings with a severity and a quote.
- Mynt checks each quote against the named file. A finding whose quote isn't there is kept, marked unverified, and never blocks.
- A verified critical or high finding blocks, and so does an audit that didn't finish.
- It never sees the builder agent's conversation.

An audit that stops without a valid `job/findings.json` for no reason of time or budget (the agent ended its turn early, or its run broke off) runs once more in the same sandbox, within the same time limit and what is left of its budget, and is told how the first attempt ended. A second such end blocks. The block says how the run ended, what is wrong with the file and the agent's last message, and the review keeps each attempt (`checks.audit.agent.detail`, `checks.audit.earlier_attempts`).

### Black-box red team

The red team (`core/workspaces/program-red-team/`) runs in a sandbox of its own that gets only the exact bytes Mynt stored and the IDL, never the source.

It runs the pinned toolchain's `solana-test-validator` with the program at its address and writes attacks: wrong signer, account substitution, PDA spoofing, authority takeover, draining, re-initialization, arithmetic edges.

A finding counts only with a proof of concept (PoC): a folder with `run.sh`, run in two phases.

1. `setup` creates a victim with keys of its own and writes `claim.json`: the victim's signer keys and accounts.
2. `attack` writes `attack.json`: its transactions' signatures.

Mynt reads the PoCs back as text and re-runs each in a third, fresh sandbox, on a fresh validator of its own, never the agent's. It snapshots the victim's accounts itself between the phases and after.

An exploit is **confirmed** only when:

- every attack transaction succeeded on Mynt's validator, invoked the program, and was signed by none of the victim's keys; and
- a victim account the program owns, which held a victim key or had lamports, changed or lost lamports.

Outcomes:

- A confirmed exploit blocks.
- Findings without a PoC, or whose PoC doesn't confirm (a failed transaction, a denial of service), are reported and don't block.
- A red team that didn't finish blocks.
- If Mynt can't complete its re-run, the review fails and can be requested again.

#### The red team's report

The red team's result is `job/report.json`, and it has one contract: `core/schemas/program-red-team-report.schema.json`. The gate validates the report against that file. The red team gets the same file in its sandbox as `job/report.schema.json`, and its own check (`scripts/check_report.py` in its workspace) validates against it before the agent ends its turn, so what the check refuses is what Mynt refuses.

| Field | Meaning |
|---|---|
| `findings` | One entry per weakness: `id`, `title`, `severity` (`critical`, `high`, `medium`, `low`, `info`), `description`, and optionally `category`, `vulnerability` (the database entry's id) and `poc` (the PoC's folder under `job/poc`). Empty when nothing exploitable was found |
| `attacks_tried` | Each attack the red team ran and what the program did. A complete report needs at least one |
| `summary` | What was found, in a sentence or two. A complete report needs one |
| `complete` | `false` while the work is unfinished, or when the program couldn't be attacked at all. Absent or `true` on a finished report |
| `incomplete_reason` | Required with `complete: false`: what stopped the work |

A report counts as the red team's result only when it validates, doesn't say it is incomplete, and comes from a run that ended cleanly and in time. "Nothing exploitable found" is a complete result: an empty `findings` list with what was tried. A missing report, one the schema refuses, and one that says it is incomplete all block.

The red team's run is one turn of the agent: it ends when the agent ends its turn. Its workspace therefore has it write a placeholder report first (`complete: false`), wait for the toolchain in the foreground (`scripts/wait_toolchain.sh`) and start its validator detached (`scripts/start_validator.sh`), so it never stops to wait for something in the background.

A red team that stops without a complete, valid report for no reason of time or budget runs once more in the same sandbox, within the same time limit and what is left of its budget, and is told how the first attempt ended. A second such end blocks. The block then says:

- how the run ended (it ended its turn, broke off, ran out of time or budget);
- what is wrong with the report (missing, not JSON, each field the schema refuses, or the red team's own `incomplete_reason`);
- what Mynt saw of the toolchain's install in that sandbox (still installing, or failed with its exit code and the last line of its log);
- the agent's last message.

The review keeps the same under `checks.red_team` (`agent.detail`, `report_problems`, `incomplete_reason`, `toolchain`, `earlier_attempts`), and the events `audit_retried` and `red_team_retried` are on its log.

Trident (Ackee's Anchor fuzzer) isn't run. It fuzzes a program from its source through a hand-written harness, which would put source in front of the black-box red team and make the harness agent-written. The red team's PoCs cover the same ground against the real bytes.

### Sign-off and timelock

When every automated gate passes, the review waits for a Mynt admin (`awaiting_approval`).

`get_mainnet_review` and the approval itself say plainly what the gate can't promise (`caveats`):

- a clean audit or red-team result isn't proof;
- the local validator can't show behaviour depending on time or slot, on live mainnet state (oracles, other programs), on the cluster (feature gates, compute, fees), on transaction ordering under load, or on later upgrades;
- IDL-omitted instructions aren't checked;
- every exception, with what was allowed.

**A first deploy** then goes ahead with `deploy_program` for exactly that build, within `MAINNET_APPROVAL_TTL_DAYS` (default 14) of the approval.

**An upgrade:**

- is announced at once to the firm's webhooks (`program.upgrade_scheduled`, with the hash and when it can run);
- runs only after `MAINNET_UPGRADE_TIMELOCK_HOURS` (default 48) and an admin's approval. Mynt starts it itself when both hold, as the builder who asked;
- must start within `MAINNET_APPROVAL_TTL_DAYS` after its timelock ends.

Upgrades need an admin too because an upgrade can turn a reviewed program into anything, and the timelock only helps users who are watching.

The builder or an admin can cancel until the upgrade starts. A cancelled or rejected upgrade goes out as `program.upgrade_cancelled`.

A review becomes `executed` once the program holds exactly the reviewed bytes.

### An approval is used once

`deploy_program` and `upgrade_program` (and Mynt's own start of a timelocked upgrade) check the approval first, then claim it atomically, last, just before the deploy starts (`started`). Two deploys at once can't both use it, and a cancel can't race it.

- The claim re-runs the current vulnerability database's hard rules over exactly those bytes and refuses if a newer version blocks them.
- The claim is given back only if the deploy couldn't start, or if the attempt ended with the program unchanged.
- If the program ended up holding another build, the review fails.

So going A, then B, then A again needs a fresh review (and, for an upgrade, a fresh announcement and timelock).

If a first deploy finds an earlier build of the program already on mainnet (a lost confirmation), Mynt records that build and stops. The new one needs a review as an upgrade.

### Review statuses

| Status | Meaning |
| --- | --- |
| `running` | The automated gates are running. Its step is `analysis_provisioning`, `analysis`, `audit`, `red_provisioning`, `red_team`, `confirm_provisioning` or `confirming` |
| `awaiting_approval` | Waiting for a Mynt admin |
| `approved` | A Mynt admin approved it; no deploy or upgrade has claimed the approval yet |
| `started` | The approval was claimed and the deploy or upgrade started |
| `executed` | The program holds exactly the reviewed bytes |
| `blocked` | An automated gate blocked it |
| `rejected` | A Mynt admin rejected it |
| `cancelled` | The builder or a Mynt admin cancelled it |
| `failed` | The review couldn't be completed (for example Mynt's re-run of the proofs of concept), or the program ended up holding another build |

### Budget

Both agents reach the model only through Mynt's agent proxy, which meters every call against their own caps.

| Setting | Default | What it is |
| --- | --- | --- |
| `PROGRAM_AUDIT_CAP_USD` | 5 | The audit agent's cap |
| `PROGRAM_RED_TEAM_CAP_USD` | 8 | The red team's cap |
| `PROGRAM_GATE_MODEL` | The builds' model | The model both use |
| `PROGRAM_ANALYSIS_MINUTES` | 45 | Time limit for static analysis |
| `PROGRAM_AUDIT_MINUTES` | 45 | Time limit for the audit |
| `PROGRAM_RED_TEAM_MINUTES` | 60 | Time limit for the red team |
| `PROGRAM_GATE_MONTHLY_CAP_USD` | 100 | Caps all reviews in a month |

Each review reserves its two caps from a per-month counter, updated atomically only while it stays under the monthly cap, and gives back what it didn't spend once its agents are done.

A review's cost is its sandboxes' machine time plus both agents' metered spend. Mynt pays it, like the build audit.

### Retention

What a build captures for this gate (its source, its dependencies, and what the compiler read) is kept for any build a mainnet review names or a program version was deployed from.

The rest, such as devnet builds nobody took further, is deleted once older than `PROGRAM_SOURCE_RETENTION_DAYS` (default 30). Such a build must be built again before a mainnet review.

### Gate skills

The agents' skills are vendored verbatim from GitHub with their licences (`UPSTREAM.json`):

- The program-audit agent follows [exvulsec/exvul-solana-skill](https://github.com/exvulsec/exvul-solana-skill) (MIT), with the account-validation, CPI, PDA, account-lifecycle, instruction-introspection and centralization-risk skills from [PlamenTSV/plamen](https://github.com/PlamenTSV/plamen) (MIT).
- The red team uses Plamen's verification-protocol, account-validation and PDA skills.

### An outside audit

`smart_contract_audit` is a US service type, so audit firms can offer it as vendors (`create_vendor_offering`). The builder engages and pays the auditor directly. Mynt only lists it, and it doesn't replace the gate.

### The gate in CI

CI's `solana-program` job runs the hard rules and the static analysis on the template program as Mynt captured it (they pass) and the hard rules on a token-vault fixture (refused).

## Turnkey custody

With the `custody-service` backend the mainnet deploy authority lives in Turnkey, not on Mynt's server. The deploy authority is the key that deploys and upgrades every program, and the upgrade authority on chain.

- For the authority, Mynt holds only a Turnkey API key, which can ask Turnkey to sign and nothing else. Turnkey's policy decides what it will sign (`core/src/solana/custody/turnkey.ts`).
- Mynt also holds a deploy payer (SOL for fees and rent, no control over any program) and, during each deploy, a temporary buffer key. Both are sealed in its vault.

### How a custody deploy runs

A deploy or upgrade takes **one Turnkey activity**, so a person can approve every deploy.

1. **Fund a buffer key.** Mynt's deploy payer, a Mynt-held key sealed in the vault that holds SOL only and controls no program, funds a fresh buffer key made for this deploy. The buffer key is also sealed in the vault, with the address of the buffer it writes. It is funded with the buffer's rent, its fees and its own rent-exempt minimum.
2. **Write the buffer.** The buffer key creates the upload buffer and writes the program into it, signed by Mynt, each batch of writes on a fresh blockhash. Turnkey isn't involved.
3. **One transaction for Turnkey to sign.** Mynt asks Turnkey to sign one transaction, in this order:
   - AdvanceNonceAccount on the program's durable nonce (system program, tag 4, authorised by the deploy payer);
   - the buffer key handing the buffer to the custody address (the loader's SetAuthority, tag 4, signed by the buffer's current authority). The loader deploys or upgrades only from a buffer whose authority is the upgrade authority;
   - Deploy (tag 2) or Upgrade (tag 3), signed by the custody address.
4. **Clean up.** Whatever the buffer key has left goes back to the deploy payer, and the buffer key is deleted. An upgrade's leftover buffer rent goes to the deploy payer too, as the Upgrade's spill account.

In that one transaction, the deploy payer is the fee payer and pays the program's rent. The custody address pays nothing and needs no SOL. Because the handover is in the same transaction, a failed or refused signature leaves the buffer with the buffer key, which closes it.

If Mynt stops mid-deploy (a crash, a restart), the next deploy of the program closes any buffer the old buffer key still controls (the address stored with it, and any the loader lists under it with `getProgramAccounts`), returns the rent to the deploy payer, then deletes the key. If that cleanup can't be finished (the RPC doesn't answer), the new deploy refuses to start and says so, and doesn't reuse the old key. Each deploy gets a fresh buffer key and buffer.

### The durable nonce

That one transaction uses the program's nonce instead of a recent blockhash, so it stays valid however long the approval takes, up to `TURNKEY_APPROVAL_TIMEOUT_SECONDS` (default 60, at most 1800). A blockhash would expire in about a minute.

Each program gets its own nonce account (80 bytes, about 0.0015 SOL of rent from the deploy payer), made by its first custody deploy and kept for its upgrades. So two deploys at once never compete for one nonce.

### The request to Turnkey

- The request is the whole unsigned transaction (`POST /public/v1/submit/sign_transaction`, activity `ACTIVITY_TYPE_SIGN_TRANSACTION_V2`, type `TRANSACTION_TYPE_SOLANA`, `signWith` the custody address), so Turnkey's policy can read its instructions.
- Each request carries Turnkey's API-key stamp (`X-Stamp`): an ECDSA P-256 signature over the exact body, made with `node:crypto`. No Turnkey SDK is used.
- Mynt polls `/public/v1/query/get_activity` while it waits for approval.
- Mynt checks every signature Turnkey returns, before it is used, against the custody address and the exact message it sent. One that doesn't verify, or a transaction Turnkey changed, is refused and nothing is sent to the cluster.
- Requests go only to Turnkey's API host, under Mynt's outbound rules.

### When something goes wrong after Turnkey has been asked

This covers an approval that timed out, a refusal, a signature that didn't verify, and a send that failed or wasn't confirmed.

Mynt then sends one transaction from the deploy payer that advances the nonce and closes the buffer (signed by the buffer key, still its authority). Advancing the nonce makes every message signed on the old nonce permanently invalid. That includes:

- a signature Turnkey produces later because someone approved the activity after Mynt stopped waiting;
- a fully signed transaction Mynt sent that might still be in flight.

If the deploy did land after all, its buffer is gone, so only the nonce is advanced, and the retry records the deploy from the chain. If even that transaction can't be sent, the program's next custody deploy advances the nonce anyway.

A late signature was never usable on its own in any case. The transaction also needs the deploy payer's and the buffer key's signatures (and, for a first deploy, the program's own keypair), which only Mynt holds.

Start the deploy again and approve the new activity.

### What stays the same under custody

- Mainnet is still refused until the RPC is set, the backend is ready and a Mynt admin sets `enabled: true`.
- The custody key never pays for or signs a builder's call. Calls pay with each builder's own fee payer and sign with their caller key, and no call may name the deploy authority.
- Mainnet calls need those per-builder keys in Mynt's vault (the `mainnet-vault` backend).
- Recovering an interrupted deploy only compares the program's on-chain authority with the custody address. It signs nothing.

### What the operator sets up in Turnkey

Values are referred to by name. Nothing secret goes in a chat, a ticket or the repository.

1. **Organization.** Sign in to Turnkey's dashboard and create an organization for Mynt's mainnet deploys (or use an existing one). Copy its organization ID: this is `TURNKEY_ORGANIZATION_ID`.
2. **Solana wallet account.** Under Wallets, create a wallet for Mynt and give it one Solana account (curve Ed25519, address format Solana, path `m/44'/501'/0'/0'`). Copy the account's address: this is the custody address. Back up the wallet the way Turnkey's dashboard offers. Mynt can't recover it.
3. **A user for Mynt.** Under Users, add a user for Mynt (for example "Mynt deployer") with API-key access only. Keep it out of the root quorum: root users skip policies, and this user must be bound by one.
4. **Its API key, made on the server.** On Mynt's server, generate a P-256 API key pair with Turnkey's CLI (`turnkey generate api-key --organization <organization ID> --key-name mynt-deployer`). The private key stays in a file on the server, readable only by Mynt's user. In the dashboard, add the public key to the Mynt user as a new API key. The public key (66 hex characters, compressed) is `TURNKEY_API_PUBLIC_KEY`. The private key (64 hex characters) is `TURNKEY_API_PRIVATE_KEY`.
5. **A policy that limits the key.** Under Policies, add the allow policy in [The Turnkey policy](#the-turnkey-policy), with the custody address, the Mynt user's ID and the approvers' IDs filled in. Then [try it once against real Turnkey](#try-it-once-against-real-turnkey-before-mainnet).
6. **The server.** The operator sets `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY` and `TURNKEY_API_PRIVATE_KEY` in Mynt's environment file on the server, optionally `TURNKEY_APPROVAL_TIMEOUT_SECONDS` (how long Mynt waits for an approval: default 60, at most 1800), and restarts Mynt. Mynt checks that the private key belongs to the public key. If any is missing or wrong, `configure_solana_signer` says which, without showing it.
7. **Mynt.** A Mynt admin calls `configure_solana_signer` with `backend: "custody-service"`, `custody_provider: "turnkey"` and `custody_address` set to the custody address, then calls it with no arguments. `missing` lists anything still to do, and `deploy_payer` is the address Mynt pays deploys from.
8. **Fund the deploy payer.** The operator funds the deploy payer with SOL: the program's rent, the buffer's while it is written, and fees (see [What the operator provides for mainnet](#what-the-operator-provides-for-mainnet)). The custody address needs no SOL.
9. **Turn it on.** The admin sets `enabled: true`.

### The Turnkey policy

Turnkey's policy language reads a Solana transaction:

- its account keys (the fee payer first), programs and system transfers;
- each instruction's program, accounts in order (`accounts[1].account_key`), and data as hex, which can be sliced (`instruction_data_hex[0..8]`, the 4-byte tag);
- the list functions `all`, `any`, `filter` and `count`.

`&&` and `||` don't short-circuit, and an allow policy whose condition can't be evaluated (an index out of range) doesn't allow.

Sources: Turnkey's [policy language](https://docs.turnkey.com/concepts/policies/language) (the Solana fields, string slicing, list functions, keywords such as `wallet_account.address`) and its [Solana policy examples](https://docs.turnkey.com/concepts/policies/examples/solana) (`instructions[0].accounts[0].account_key`, `instruction_data_hex`).

The policy checks positions, not signer flags. The custody address signs the whole transaction, so Turnkey may show it as a signer wherever it appears, including as the buffer's new authority. The docs don't say, so the policy doesn't depend on it.

The policy is also in [`turnkey-solana-policy.json`](../turnkey-solana-policy.json). Mynt's tests evaluate that file against every transaction Mynt asks Turnkey to sign and against transactions it must refuse (`core/test/turnkey-policy.js`), so the policy and the transactions can't drift apart.

```json
{
  "policyName": "Mynt deploys: the custody address signs one Deploy or Upgrade, nothing else",
  "effect": "EFFECT_ALLOW",
  "consensus": "approvers.any(user, user.id == '<Mynt user ID>') && approvers.any(user, user.id in ['<approver 1 ID>', '<approver 2 ID>'])",
  "condition": "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && activity.params.type == 'TRANSACTION_TYPE_SOLANA' && wallet_account.address == '<custody address>' && solana.tx.address_table_lookups.count() == 0 && solana.tx.account_keys[0] != '<custody address>' && solana.tx.transfers.all(t, t.from != '<custody address>') && solana.tx.program_keys.all(p, p in ['11111111111111111111111111111111', 'BPFLoaderUpgradeab1e11111111111111111111111']) && solana.tx.instructions.all(i, (i.program_key == '11111111111111111111111111111111' && i.accounts.all(a, a.account_key != '<custody address>')) || (i.program_key == 'BPFLoaderUpgradeab1e11111111111111111111111' && i.instruction_data_hex[0..8] in ['02000000', '03000000', '04000000'])) && solana.tx.instructions.filter(i, i.program_key == 'BPFLoaderUpgradeab1e11111111111111111111111' && i.instruction_data_hex[0..8] in ['02000000', '03000000']).count() == 1 && solana.tx.instructions.filter(i, i.program_key == 'BPFLoaderUpgradeab1e11111111111111111111111' && i.instruction_data_hex[0..8] == '04000000').all(i, i.accounts.count() == 3 && i.accounts[1].account_key != '<custody address>' && i.accounts[2].account_key == '<custody address>')"
}
```

#### What the policy allows

- The custody address signs, but it doesn't pay: it isn't the fee payer (`account_keys[0]`) and no transfer comes from it.
- No address lookup tables.
- Only two programs:
  - the system program, with the custody address in none of its instructions (so the nonce advance and the program account's creation pass);
  - the upgradeable loader, whose instructions are exactly one Deploy (tag 2) or Upgrade (tag 3), plus SetAuthority (tag 4) handing a buffer to the custody address. That means the custody address in position 2 (the new authority) and not in position 1 (the current authority, who signs).

#### What the policy refuses

Everything else is refused:

- transfers of the custody address's SOL;
- SetAuthority signed by it (giving a program away) and SetAuthorityChecked (tag 7);
- Close (tag 5) and buffer writes;
- other programs;
- raw payloads and key exports.

Nothing else is allowed for the Mynt user.

#### How the condition is written

The filters are written so the position checks only run on SetAuthority instructions. Since `&&` and `||` don't short-circuit, indexing the accounts of every instruction would fail on system instructions with fewer than three accounts, and the policy would refuse Mynt's own deploys.

Turnkey gives `&&` and `||` the same precedence, grouped left to right, so every clause that mixes them is in parentheses. The tests check the policy means the same under either grouping.

#### Try it once against real Turnkey before mainnet

Mynt's tests evaluate this policy with an interpreter written from Turnkey's documentation, not with Turnkey's own engine. Before enabling mainnet:

1. Run one custody deploy of a small test program with this policy in place, an approver approving.
2. Check in Turnkey's activity log that it was allowed by this policy.
3. Check that a transfer from the custody address, asked for with the same API key, is denied.

If Turnkey reads a field differently from these docs, this is where it shows.

One assumption in particular: the policy reads each instruction's 4-byte tag as `instruction_data_hex[0..8]`, assuming the slice's end is exclusive (`'abc'[0..2]` is `'ab'`), which Turnkey's reference doesn't state. If Turnkey's end were inclusive, no tag would match and Turnkey would refuse the test deploy. The policy fails closed, never open. In that case change each `[0..8]` to `[0..7]`.

#### What a looser policy would allow

`solana.tx.program_keys.all(p, p in [system, loader])` on its own (an earlier version of these steps) still lets the API key:

- move all of the custody address's SOL with a system transfer;
- give away any program with SetAuthority or SetAuthorityChecked (tags 4 and 7);
- close a buffer or program (tag 5);
- Upgrade (tag 3) any program the custody address controls.

Use the policy above instead.

#### What the tight policy still allows

Whoever holds the API key can still hand a buffer of their own to the custody address and Upgrade any of its programs to that code. The policy can't tell Mynt's buffer from anyone else's.

So **require a person's approval for every activity** (the second clause of the consensus above), which means one approval per deploy or upgrade. Approvers should check the program in Mynt (`get_program`, `list_all_programs`) before approving.

To narrow it further, add this clause to restrict upgrades to programs you list, at the cost of updating the list for each new program:

`&& solana.tx.instructions.all(i, i.program_key != 'BPFLoaderUpgradeab1e11111111111111111111111' || i.instruction_data_hex[0..8] != '03000000' || i.accounts.any(a, a.account_key in ['<program IDs>']))`

### Rotating the key and moving the authority

- **To rotate the API key:** add the new public key to the Mynt user, replace the two `TURNKEY_API_*` settings, restart Mynt and delete the old key in Turnkey.
- **To move the deploy authority itself:** transfer each program's upgrade authority on chain first. The custody address is the upgrade authority of everything deployed through it.
