# Running Mynt

This file is for operators: the people who run a Mynt server and hold its settings. It covers installing and building the server, making users and tokens, running it over stdio or HTTP, setting up sign-in with Clerk, deploying, backups, and every setting by name.

What the server does once it runs is in the other reference files, listed in the [index](../reference.md).

## Install and build

You need Node.js 22.13 or newer and a Postgres database. [Supabase](https://supabase.com) (self-hosted or cloud) is the intended backend; any Postgres 15 or newer works.

The server is the repository's `core/` folder, installed on its own from its own lockfile (`core/package-lock.json`). The apps built on it (Mynt Studio, the sample chat and the sign-in code they share) are under `platform/` and are the repository's npm workspaces: `npm ci` at the repository root installs them and never the server.

```sh
git clone https://github.com/never2average/mynt.git
cd mynt/core
npm ci
npm run build
```

The commands in the rest of this file run in `core/`. The build makes `dist/index.js`, which is the `mynt` command (`core/package.json` names it as the package's `bin`). `node dist/index.js --help` prints every command and the main settings.

## Users and tokens

Users, roles, products, enrolments and apps live in Postgres, in a dedicated `financial_products` schema. Supabase's generated REST API exposes only `public`, so none of this data is reachable through it.

Set `DATABASE_URL` to the connection string. The schema is created on first start. If the schema already exists and is owned by the server's database role (as the deploy scripts set it up), the role needs no database-level privileges.

### The seven roles

Every user and every invitation carries one or more of these roles. `--role` on the command line accepts exactly these names.

| Role | Who it is |
|---|---|
| `consumer` | A person who enrols in products |
| `developer` | A builder (the same role as `innovator`; each implies the other) |
| `innovator` | A builder |
| `vendor` | A member of a firm that offers standard services |
| `license_provider` | A member of a firm whose licences sponsor builders' products |
| `liquidity_provider` | A member of a firm or fund that puts capital into pools |
| `admin` | A Mynt admin |

How the roles nest, and what each one can do, is in [Roles and tools](roles-and-tools.md).

### The first admin

A new server has no users. The operator makes the first Mynt admin from the command line:

```sh
export DATABASE_URL=postgres://user:password@host:5432/postgres
node dist/index.js users invite --email admin@example.com --role admin
```

`users invite` puts the email on Mynt's invitation list with those roles and, when `CLERK_SECRET_KEY` is set, on Clerk's allowlist. The person then signs in (see [Sign-in with Clerk](#sign-in-with-clerk)).

After that, Mynt admins invite everyone else from inside Mynt with `invite_user`, or from Mynt Studio's platform admin. See [Invitations](platform-admin.md#invitations).

### Local tokens

For stdio, or for an HTTP server that runs without Clerk, make a local user. Each command prints a token once; only its hash is stored.

```sh
node dist/index.js users add --name "Asha" --role consumer
node dist/index.js users add --name "Ines" --role innovator
node dist/index.js users add --name "Max" --role consumer --role innovator
node dist/index.js users add --name "Root" --role admin
node dist/index.js users list
```

`--role` can be given several times. `users list` prints the invitation list and the local users.

### User commands

| Command | What it does |
|---|---|
| `users invite --email <email> --role <role>` | Invites an email with the roles given; also updates Clerk's allowlist |
| `users revoke --email <email>` | Removes the invitation; also removes the email from Clerk's allowlist |
| `users add --name <name> --role <role>` | Makes a local user and prints its token once |
| `users list` | Prints the invitation list and the local users |

## Run it

### Locally over stdio

One user per client. Pass the user's token in `FINANCIAL_PRODUCTS_TOKEN`. Without it, the server runs as a read-only guest.

Claude Code:

```sh
claude mcp add mynt -e DATABASE_URL=postgres://... -e FINANCIAL_PRODUCTS_TOKEN=fpm_... -- node /absolute/path/to/mynt/core/dist/index.js
```

Claude Desktop and other clients:

```json
{
  "mcpServers": {
    "mynt": {
      "command": "node",
      "args": ["/absolute/path/to/mynt/core/dist/index.js"],
      "env": { "DATABASE_URL": "postgres://...", "FINANCIAL_PRODUCTS_TOKEN": "fpm_..." }
    }
  }
}
```

### Shared server over HTTP

Many users on one server:

```sh
node dist/index.js serve-http --port 3000 --host 0.0.0.0
```

`--port` defaults to `PORT` or 3000, and `--host` to `HOST` or `127.0.0.1`.

Clients connect to `http://host:3000/mcp` (Streamable HTTP) with `Authorization: Bearer fpm_...`. Without Clerk, a request with no token is served as a guest, and an invalid token gets `401`. Put the server behind TLS (for example Caddy or nginx) before exposing it publicly.

```sh
claude mcp add --transport http mynt https://your-host/mcp --header "Authorization: Bearer fpm_..."
```

`serve-http` is also the process that runs Mynt's background work (builds, webhook deliveries, health snapshots and the rest; see [Background work](../architecture.md#background-work)). The stdio server runs none of it.

### The pseudonym secret

Set `MYNT_PSEUDONYM_SECRET` to a long random string (for example the output of `openssl rand -hex 32`) so builders can see product requests. Each requester appears to each builder under a pseudonym keyed with it. Without it, `list_product_requests` refuses to list anything. See [Product requests](products.md#product-requests).

## Sign-in with Clerk

Set `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` and `PUBLIC_URL` (the server's public origin, for example `https://mcp.example.com`), and the HTTP server accepts only invited people signed in with [Clerk](https://clerk.com). The rule itself, and what public sign-up changes, is in [Invite-only sign-in](workspaces-and-sign-in.md#invite-only-sign-in).

### How it works

- The server is an OAuth-protected resource with Clerk as its authorization server. MCP clients (Claude, Claude Code and others) discover this from `/.well-known/oauth-protected-resource/mcp`, register themselves with Clerk and open Clerk's sign-in page.
- Each request's Clerk access token is verified, and must be issued for this server's `/mcp` resource.
- The caller's verified email must be on Mynt's invitation list. The invitation also decides the caller's roles, and removing it cuts them off on their next request.
- Local `fpm_` tokens and guests are refused over HTTP. They still work over stdio.

### Set it up

1. Set the three settings above on the server.
2. Run the one-time set-up. It turns on Clerk's allowlist, dynamic client registration, required PKCE (Proof Key for Code Exchange) and audience claims, and copies every invited email to the allowlist:

   ```sh
   node dist/index.js clerk setup
   ```

3. Invite the first admin (see [The first admin](#the-first-admin)).
4. Connect a client with only the address. It opens Clerk's sign-in page:

   ```sh
   claude mcp add --transport http mynt https://mcp.example.com/mcp
   ```

`clerk setup` follows the public sign-up setting: with public sign-up on, it leaves Clerk's allowlist off.

### Inviting people

There are three ways to invite someone. All three end with the same invitation in Mynt.

**From Mynt.** A Mynt admin runs `invite_user` (or uses the platform admin in Studio). This is the normal way once an admin exists.

**From the command line.**

```sh
node dist/index.js users invite --email ines@example.com --role innovator
node dist/index.js users invite --email asha@example.com --role consumer --role developer
node dist/index.js users revoke --email asha@example.com
node dist/index.js users list
```

`users invite` and `users revoke` also update Clerk's allowlist, so people who aren't invited can't sign up at all.

**From Clerk's dashboard.** This also works for the first admin.

1. In the Clerk dashboard, go to **Users**, then **Invite**. Enter the email and set **public metadata** to a `mynt_roles` list:

   ```json
   { "mynt_roles": ["admin"] }
   ```

   Any of the seven roles can be listed.
2. The person accepts Clerk's emailed invitation and signs up.
3. On their first Mynt request, Mynt invites them with those roles and writes `invite_via_clerk` to the audit log.

Only Clerk dashboard owners can set public metadata; users can't edit their own. After that first sign-in, manage the person in Mynt: role changes and revocations are written back to their Clerk metadata, so an old grant can't restore access. With Clerk's allowlist on, also add the email under **Configure**, **Restrictions**, **Allowlist**, in case the invitation alone isn't enough to sign up.

### Public sign-up

A Mynt admin can open sign-up with `set_public_signup` (`enabled: true`). It is a database setting, not an environment variable. What it does is described in [Public sign-up](workspaces-and-sign-in.md#public-sign-up). For the operator:

- Turning it on turns Clerk's allowlist off, and turning it off turns the allowlist back on. Both are best effort; Mynt's invitations decide access either way.
- `clerk setup` follows the setting.

### Mynt's own apps sign in without a consent screen

People signing in to Mynt Studio or the sample chat (Mynt's own apps) aren't asked to "allow Mynt to access Mynt". This is the one full explanation; each app's README lists only its own settings and steps.

How it works:

- Each first-party app is a pre-registered Clerk OAuth application. It is a confidential client (its secret stays on that app's server), with PKCE required and its consent screen off.
- Only an operator creates one, naming the app's exact redirect address.
- Every client that registers itself (MCP clients such as Claude, and any third party) still gets Clerk's consent screen. Clerk doesn't let a dynamically registered application turn it off, and Mynt never changes that.

The redirect address must be:

- `https` (`http` only for localhost);
- free of wildcards (`*`) anywhere, host or path;
- free of a user name or password;
- free of a query or fragment (not even a bare `?` or `#`);
- written in its normal form (lower-case host, no default port).

Anything else is refused before Clerk is asked.

Operator steps, once per app (the domain is a placeholder for that app's own):

1. On the server, run:

   ```sh
   node dist/index.js clerk first-party mynt-studio https://<studio-domain>/api/auth/callback
   ```

2. It prints the client id. The client id and its secret go to `~/.mynt/oauth-mynt-studio.json`, a file only you can read (or the path you give with `--file`); `~/.mynt` itself is kept at mode 700. The secret is never printed. If the file can't be written, the Clerk application is deleted again (its secret would otherwise be lost), and the error says whether that worked or which application to delete by hand.
3. Give the client id and secret to that app's server as its OAuth client, in place of registering itself: `MYNT_OAUTH_CLIENT_ID` and `MYNT_OAUTH_CLIENT_SECRET` for Mynt Studio and the sample chat (see [Studio's README](../../platform/studio/README.md#sign-in-without-a-consent-screen) and [the chat's README](../../platform/chat/README.md#sign-in-without-a-consent-screen)). Then delete the file.
4. Registering the same name again is refused, because the secret can't be read back. To replace the secret, rotate it in Clerk's dashboard.

Each app allows the scopes Mynt's apps ask for: `openid profile email`, the same list Mynt's protected-resource metadata publishes. An app registered before `openid` was included makes every sign-in fail with `invalid_scope`. Repair it in place, keeping its secret:

```sh
node dist/index.js clerk first-party --update-scopes mynt-studio
```

It takes the app's name or client id, says whether anything changed, and prints only the name and client id.

### When a sign-in is refused

When the authorization server refuses a sign-in, Mynt's apps tell the person why only as far as they can act on it.

| The refusal | What the person sees |
|---|---|
| `access_denied` (they declined) | "Sign-in was cancelled" |
| Anything else (`invalid_scope`, `invalid_client`, `invalid_request`, `server_error` and others) | "Sign-in isn't set up correctly on Mynt's side. Please tell your admin." |

For the second kind, the app's server logs the error code and a short, cleaned description, never the state or the code.

### Workspaces and organizations

With Clerk as the sign-in provider, each workspace is a Clerk organization. Turning that on (the webhook, `CLERK_WEBHOOK_SECRET`, `STUDIO_URL` and `clerk sync-workspaces`) is in [Turning organizations on](workspaces-and-sign-in.md#turning-organizations-on).

## Deploying

There are two deployment paths in `deploy/`. Both set up Supabase's Docker stack and a least-privilege database role, and both are safe to run again for an update.

| | `deploy/setup-vm.sh` | `deploy/host/install-host.sh` |
|---|---|---|
| For | A fresh Ubuntu VM | A server that already runs Caddy |
| Mynt runs as | A Docker container, with Caddy in Docker beside it | A systemd service, `mynt.service` |
| What it serves | The MCP server only | The MCP server, and optionally Mynt Studio on the same domain |
| Releases and rollback | The image is rebuilt in place | One folder per commit under `/opt/mynt/releases`, with `/opt/mynt/current` pointing at the live one |
| Backups | None | Nightly, with a weekly restore test (see [Backups](#backups)) |

The confidential service is not part of either path. It is deployed separately from `deploy/confidential`; see [Confidential computing](confidential-computing.md#operator-steps-for-aws-nitro-enclaves).

Deployment scripts take the domain and every other address as arguments. Nothing about a particular server is kept in the repository.

### A fresh VM with Docker

[`deploy/setup-vm.sh`](../../deploy/setup-vm.sh) sets up an Ubuntu VM end to end:

```sh
# as root on the VM, with the domain's A record pointing at it
curl -fsSL https://raw.githubusercontent.com/never2average/mynt/main/deploy/setup-vm.sh -o setup-vm.sh
bash setup-vm.sh mcp.example.com [git-ref]
```

What it does:

- Installs Docker and opens only SSH, 80 and 443 in `ufw`.
- Runs Supabase's official Docker stack in `/opt/supabase` with freshly generated secrets. Supabase's own dashboard, its API gateway and its pooler are bound to localhost; reach the dashboard with `ssh -L 8000:127.0.0.1:8000 root@<vm>`.
- Creates a least-privilege Postgres role, `financial_products_app`, that owns only the `financial_products` schema.
- Builds the MCP image from `core/` and runs it with Caddy, which gets the TLS certificate automatically and serves `https://<domain>/mcp`.

Create users on the VM:

```sh
docker compose -f /opt/mynt/src/deploy/docker-compose.yml exec mcp \
  node dist/index.js users add --name "Ines" --role innovator
```

### On a server that already runs Caddy

[`deploy/host/install-host.sh`](../../deploy/host/install-host.sh) installs Mynt without Docker for Mynt itself (Supabase still runs in Docker):

```sh
bash install-host.sh <domain> [git-ref] [--studio-upstream <studio host> | --no-studio]
```

Each deploy:

1. Unpacks the commit into `/opt/mynt/releases/<commit>`.
2. Installs and builds the server in that release's `core/` folder, from core's own lockfile.
3. Points `/opt/mynt/current` at the release.
4. Restarts `mynt.service`, which runs `node dist/index.js serve-http` in `/opt/mynt/current/core`.

Each new release also links `dist` to `core/dist`, so `/opt/mynt/current/dist/index.js` still works for anything that runs it.

The installer generates `MYNT_PSEUDONYM_SECRET` and, unless the confidential service already holds the vault's keys, `MYNT_VAULT_KEY`, once, and keeps them across runs in the server's environment file. Losing `MYNT_VAULT_KEY` loses everything sealed with it.

**Older releases.** Releases from before the repository was split into `core/` and `platform/` ran from the release's root. The installer refuses such a commit ("uses the old layout; run that commit's own installer") before it deletes or changes anything, and it never deletes the live release. To go back to such a commit, run that commit's own `deploy/host/install-host.sh`, which puts back its own unit file.

**The hosting gateway.** Where the hosting gateway is set up (`hosting-gateway.sh`, [gateway mode](apps-and-builds.md#gateway-mode)), every deploy also replaces its installed sync script (`/usr/local/sbin/mynt-gateway-sync`) with this release's `hosting-gateway.sh`, which its timer runs within a minute. A change to that script goes live with the deploy, not only when the gateway is set up again.

### Mynt Studio on Mynt's domain

On a host installed with `deploy/host/install-host.sh`, Mynt Studio can be served on the same domain as Mynt, with no separate Studio subdomain:

```sh
bash install-host.sh <domain> [git-ref] --studio-upstream <studio host>
```

`<studio host>` is where Studio actually runs, for example its hosting deployment's address. It is a host name only: no scheme, port or path.

**What stays with Mynt.** Every path Mynt serves still goes to it:

| Paths | Request body limit |
|---|---|
| `/mcp`, `/healthz`, `/v1/*`, `/agent/*`, `/bd/*` | As without Studio |
| `/v1`, `/llms.txt`, `/llms-full.txt`, `/.well-known/*`, `/ramp-sandbox/*`, `/confidential/*` | 64 KB |
| `/webhooks/*` (the sign-in provider's events) and `/esign/*` (the e-signature service's events and the signing frame's origins) | 1 MB |

**What goes to Studio.** Everything else, `/` included, is proxied to the Studio host, with request bodies up to 4.5 MB. Streaming isn't buffered.

**Mynt's own answer at `/`.** The one-line text Mynt answers at `/` is replaced by Studio's home page. `/llms.txt` still tells MCP clients and AI assistants where the endpoint is.

**Persistence.** The setting is kept in `/etc/mynt/edge.env`, which is root-only and holds no secrets, so later deploys without the flag keep it. `--no-studio` turns it off; without Studio, Caddy's site for Mynt is exactly what it was. `deploy/host/render-site.sh` renders the site from `deploy/host/site.caddy` and `deploy/host/studio-routes.caddy`, and CI checks its routes with Caddy itself.

**The caller's address.** This server removes any `X-Mynt-Client-IP` a caller sends, on every path, and then sets it to the caller's real address on requests it passes to Studio. Studio trusts the header only when the request comes from an address in its `TRUSTED_EDGE_IPS` setting. Every response also gets `X-Content-Type-Options: nosniff`.

Going live, in this order:

1. Deploy the edge first: run `install-host.sh <domain> --studio-upstream <studio host>`. Studio keeps working at its own address meanwhile.
2. Set Studio's settings and redeploy it:
   - `APP_URL`: `https://<domain>`. Sign-in then returns to Mynt's domain, and everyone signs in once more.
   - `TRUSTED_EDGE_IPS`: every public outbound address of this server, IPv4 and IPv6.

A missing address in `TRUSTED_EDGE_IPS` doesn't break Studio. Requests from it are still served, because they carry `X-Mynt-Client-IP`, but every user coming through it shares one sign-in rate-limit bucket (429 after 20 starts in 10 minutes). Studio logs a warning naming the address to add.

From then on, people reach Studio only through Mynt's domain. A request to Studio's own deployment address from anywhere but this server, without `X-Mynt-Client-IP` (a browser, for any path), gets a 308 to the same path on `APP_URL`.

Studio's own settings are in [its README](../../platform/studio/README.md#settings).

## Backups

On a host installed with `deploy/host/install-host.sh`, Supabase is backed up every night and a backup is test-restored every week. The installer sets this up on every deploy; there is nothing to switch on. The Docker path (`deploy/setup-vm.sh`) sets up no backups.

| | |
|---|---|
| What | Every database and role in Supabase's Postgres (`pg_dumpall`, so Mynt's `financial_products` schema, sign-ins and Storage's records all come along), plus Storage's files (`volumes/storage` in the Supabase directory) |
| When | Daily around 02:30 UTC (`mynt-backup.timer`) |
| Restore test | Sundays around 04:30 UTC (`mynt-backup-verify.timer`). It restores the newest backup into a throwaway `postgres:17` container with no network, counts the tables in `financial_products`, `auth`, `storage` and `public`, and removes the container |
| Where | `/var/backups/mynt/<time>/` on the server, readable by root only, kept 7 days |
| Off-site, if you set it up | Encrypted copies in your own bucket: 14 daily and 8 weekly (Sunday's) |
| Log | `/var/log/mynt/backup.log` |

Nothing leaves the server unencrypted. Without an encryption key the backups stay on the server.

### Checking backups

`ops_status` has a `backups` section and says when something needs attention:

- no backup in 26 hours;
- a failed run;
- a failed restore test;
- "backups are on this server only; add an off-site bucket".

### Turning on off-site copies

You need a bucket at any S3-compatible storage service (Cloudflare R2, Backblaze B2 and DigitalOcean Spaces all work) and an encryption key pair that you keep.

1. On your own computer (not the server), install [age](https://github.com/FiloSottile/age) and make a key pair:

   ```sh
   age-keygen -o mynt-backup-identity.txt
   ```

   It prints a public key starting `age1`; that one goes on the server. The file `mynt-backup-identity.txt` is the only thing that can decrypt the backups: keep it in your password manager or another safe place, never on the server.
2. At your storage service, create a private bucket and an access key that can read, write and delete in that bucket only.
3. On the server, as root, open `/etc/mynt/backup.env` and fill it in. The installer created the file with these lines commented out; it is readable by root only, and the installer never changes it once it exists.

   ```sh
   BACKUP_AGE_RECIPIENT=age1...your public key...
   BACKUP_REMOTE=myntbackup:your-bucket/mynt
   RCLONE_CONFIG_MYNTBACKUP_TYPE=s3
   RCLONE_CONFIG_MYNTBACKUP_PROVIDER=Cloudflare
   RCLONE_CONFIG_MYNTBACKUP_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   RCLONE_CONFIG_MYNTBACKUP_ACCESS_KEY_ID=...
   RCLONE_CONFIG_MYNTBACKUP_SECRET_ACCESS_KEY=...
   ```

   For DigitalOcean Spaces use `PROVIDER=DigitalOcean` and `ENDPOINT=https://<region>.digitaloceanspaces.com`. For Backblaze B2 use `PROVIDER=Other` and `ENDPOINT=https://s3.<region>.backblazeb2.com`.
4. Run one backup now and check it: `systemctl start mynt-backup.service`, then `ops_status` should show `offsite: "uploaded"`.

### Restoring

Try a test restore first. It never touches production:

```sh
bash /opt/mynt/current/deploy/host/restore.sh --test /var/backups/mynt/<time>
```

To use an off-site copy, download it on the server and copy your identity file over only for the restore:

```sh
set -a; . /etc/mynt/backup.env; set +a     # in a root shell: rclone reads the bucket settings from these
rclone --config /dev/null copy myntbackup:your-bucket/mynt/daily/<time> /root/restore-<time>
bash /opt/mynt/current/deploy/host/restore.sh --test /root/restore-<time> --identity /root/mynt-backup-identity.txt
```

To replace production with a backup, use `--yes-replace-production` instead of `--test`. It:

1. takes a safety backup of the current state;
2. stops Mynt and Supabase's other services;
3. replaces every database and Storage's files (the old files are moved aside, not deleted);
4. starts everything again and prints the table counts.

Delete the identity file and the downloaded copy from the server afterwards (`shred -u /root/mynt-backup-identity.txt`).

### Backup settings

Settings such as the Supabase directory (`SUPABASE_DIR`, default `/opt/supabase`) and the Postgres container (`BACKUP_DB_CONTAINER`, default `supabase-db`) can be changed in `/etc/mynt/backup.env` too. They are listed at the top of [`deploy/host/backup.sh`](../../deploy/host/backup.sh).

## Settings by name

Mynt has two kinds of settings.

**Environment variables.** Secrets and infrastructure settings are read from the server's environment when it starts. They are referenced by name only: values live in the server's environment file, never in the repository, a command line, a log or a chat. `node dist/index.js --help` lists the main ones. The table below names every setting the server reads and links to the section that explains it.

**Database settings.** Settings Mynt admins change while the server runs are stored in the database and set through admin tools or in Studio under Platform admin, Platform settings:

| Setting | Changed with | Explained in |
|---|---|---|
| E-signature (the provider's key, the webhook, test mode) | `set_esign_api_key`, `register_esign_webhook`, `set_esign_test_mode`, `remove_esign_api_key`, or Platform settings in Studio | [E-signature](agreements.md#e-signature) |
| Public sign-up | `set_public_signup` | [Public sign-up](workspaces-and-sign-in.md#public-sign-up) |
| The Mynt Ramp's firm | `set_mynt_ramp` | [The Mynt Ramp](vendors-and-marketplace.md#the-mynt-ramp) |
| Treasury mainnet | `configure_treasury_mainnet` | [Treasury mainnet](liquidity-and-treasury.md#treasury-mainnet) |
| The Solana mainnet signer | `configure_solana_signer` | [Signers](solana-programs.md#signers) |
| Take rates | `define_take_rate` | [Take rates](platform-admin.md#take-rates) |

### Environment variables

| Setting | What it turns on or controls | Explained in |
|---|---|---|
| `DATABASE_URL` | The Postgres connection. Required | [Users and tokens](#users-and-tokens) |
| `PGPOOL_MAX` | The size of the database connection pool | This table |
| `PORT`, `HOST` | The defaults for `serve-http`'s `--port` and `--host` | [Shared server over HTTP](#shared-server-over-http) |
| `PUBLIC_URL` | The server's public origin. Needed by Clerk sign-in, builds, hosting and e-signature | [Sign-in with Clerk](#sign-in-with-clerk) |
| `FINANCIAL_PRODUCTS_TOKEN` | The user's token in stdio mode; without it the server is a guest | [Locally over stdio](#locally-over-stdio) |
| `FINANCIAL_PRODUCTS_FILE` | Named in `mynt --help` as a JSON catalogue for seeding published products. The server no longer reads it; the reference catalogue is applied with the seed script instead | [The reference catalogue](products.md#the-reference-catalogue) |
| `MYNT_PSEUDONYM_SECRET` | Pseudonyms on product requests; without it `list_product_requests` lists nothing | [Answering](products.md#answering) |
| `MYNT_VAULT_KEY` | The key that seals the vault while the confidential host is `local` | [Confidential computing settings](confidential-computing.md#confidential-computing-settings) |
| `NODE_ENV` | With `production`, webhook addresses must be public `https` addresses | [Webhook addresses](runtime-api.md#webhook-addresses) |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Clerk sign-in over HTTP, linked accounts, and workspaces as organizations | [Sign-in with Clerk](#sign-in-with-clerk) |
| `MCP_REQUIRE_AUDIENCE` | Set to `false`, access tokens need not be issued for this server's `/mcp` resource. Leave it unset | [How it works](#how-it-works) |
| `CLERK_WEBHOOK_SECRET` | The organization webhook at `/webhooks/clerk` | [The organization webhook](workspaces-and-sign-in.md#the-organization-webhook) |
| `CLERK_ACCOUNT_PORTAL_URL` | Where people manage their linked accounts | [Linked accounts](workspaces-and-sign-in.md#linked-accounts) |
| `STUDIO_URL` | Where organization invitations send people | [Organization invitations](workspaces-and-sign-in.md#organization-invitations) |
| `BOAT_API_KEY`, `FREESTYLE_API_KEY`, `SANDBOX_PROVIDER` | The agent sandbox provider; `FREESTYLE_API_KEY` also turns on direct hosting | [Agent sandbox providers](apps-and-builds.md#agent-sandbox-providers) |
| `ANTHROPIC_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEX_PROJECT_ID`, `VERTEX_REGION` | The agents' model backend | [Build settings](apps-and-builds.md#build-settings) |
| `BUILD_AGENT_MODEL`, `AGENT_MODELS` | The build agents' model, and the other models the agent proxy lets a run ask for | [Build settings](apps-and-builds.md#build-settings) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG` | Builds push branches and open pull requests | [Build settings](apps-and-builds.md#build-settings) |
| `BUILD_MANAGED_REPO_OWNER` | Managed repositories | [Setting up managed repositories](apps-and-builds.md#setting-up-managed-repositories) |
| `BUILD_CAP_USD`, `BUILD_MONTHLY_CAP_USD`, `BUILD_WORKSPACE_MONTHLY_CAP_USD`, `FREESTYLE_USD_PER_HOUR` | Spend caps for builds | [Spend](apps-and-builds.md#spend) |
| `BUILD_AUDIT`, `BUILD_AUDIT_MODEL`, `BUILD_AUDIT_CAP_USD`, `BUILD_AUDIT_MINUTES`, `BUILD_AUDIT_WORKFLOWS`, `BUILD_MAXWELL_REPO` | The optional independent security audit of a build, and where its tool is fetched from | [The independent audit](apps-and-builds.md#the-independent-audit) |
| `BUILD_SANDBOX_TYPE`, `BUILD_SANDBOX_TTL_SECONDS`, `BUILD_SESSION_IDLE_MS`, `MYNT_AGENT_HOLD`, `MYNT_AGENT_IDLE_MS` | The build's agent sandbox and session builds | [Session builds](apps-and-builds.md#session-builds) |
| `MYNT_AGENT_SETTLE_MS`, `MYNT_AGENT_BACKGROUND_MAX_MS` | How long the agent runner waits for an agent's background work | This table |
| `MYNT_TRANSIENT_GRACE_MS` | How long a transient error (a provider briefly down) may last before it fails the work | This table |
| `HOSTING_DO_TOKEN`, `HOSTING_GATEWAY_ENDPOINT`, `HOSTING_GATEWAY_PUBLIC_KEY`, `HOSTING_GATEWAY_IP`, `HOSTING_REGION`, `HOSTING_SIZE`, `HOSTING_DO_IMAGE`, `HOSTING_APPS_DOMAIN` | Hosting in gateway mode | [Gateway mode](apps-and-builds.md#gateway-mode) |
| `USAGE_SAMPLE_MS` | How often hosted machines are sampled for profit and loss | [How machines are recorded](workspaces-and-sign-in.md#how-machines-are-recorded) |
| `DESK_JOB_CAP_USD`, `DESK_RUN_CAP_USD`, `DESK_MONTHLY_CAP_USD` | The product desk | [Desk settings](products.md#desk-settings) |
| `EXPLORE_CAP_USD`, `EXPLORE_MAX_ITERATIONS`, `EXPLORE_MAX_MINUTES`, `EXPLORE_EXPERIMENT_TIMEOUT_SECONDS` | Algorithm explorations | [Algorithm explorations](products.md#algorithm-explorations) |
| `REVIEW_AUTO_OPEN`, `REVIEW_CASE_CAP_USD`, `REVIEW_MONTHLY_CAP_USD` | The governance desk | [Review settings](platform-admin.md#review-settings) |
| `BD_ENABLED`, `BD_DAILY_CAP`, `BD_RUN_CAP_USD`, `BD_MONTHLY_CAP_USD`, `BD_RUN_EVERY_HOURS`, `BD_FOLLOW_UP_GAP_DAYS`, `BD_MAX_UNANSWERED`, `BD_PROFILE_RETENTION_DAYS`, `BD_SENDER_NAME` | The connector | [Connector settings](platform-admin.md#connector-settings) |
| `FIRM_CHECKS_EVERY_DAYS`, `SPONSOR_LEGITIMACY_RULE` | Firm checks | [Firm checks](licence-providers.md#firm-checks) |
| `COVENANT_POLL_MS` | How often covenants are evaluated on their own timer | [When rules are evaluated](licence-providers.md#when-rules-are-evaluated) |
| `PARTNER_LEDGER_TIMEOUT_MS`, `PARTNER_LEDGER_MAX_AGE_HOURS`, `PARTNER_LEDGER_FILE_MAX_AGE_HOURS`, `PARTNER_CONFORMANCE_MAX_AGE_DAYS`, `PARTNER_CONFORMANCE_WARN_DAYS`, `PARTNER_MEMBER_COOLOFF_HOURS` | The partner kit | [Partner kit](licence-providers.md#partner-kit) |
| `PRODUCT_HEALTH_PROGRAM_ID`, `PRODUCT_HEALTH_INTERVAL_MINUTES`, `PRODUCT_HEALTH_COSIGN_WINDOW_MINUTES` | Product health | [Product health](licence-providers.md#product-health) |
| `VERIFIED_STATE_MAX_AGE_DAYS` | How old a customer's verified state may be | [When a verified state is refused](money-rails.md#when-a-verified-state-is-refused) |
| `VENDOR_PENDING_EXPIRY_HOURS` | When an unfinished vendor action expires | [The customer stays in control](vendors-and-marketplace.md#the-customer-stays-in-control) |
| `RAMP_LINK_EXPIRY_HOURS`, `RAMP_ADAPTER_PENDING_BUSINESS_DAYS`, `RAMP_SANDBOX_SETTLE_MS` | The Mynt Ramp | [The Mynt Ramp](vendors-and-marketplace.md#the-mynt-ramp) |
| `LIQUIDITY_POLL_MS`, `POOL_HEALTH_MAX_AGE_MINUTES`, `POOL_CORRECTION_DISPUTE_DAYS` | The withdrawal queue | [The withdrawal queue](liquidity-and-treasury.md#the-withdrawal-queue) |
| `SOLANA_DEVNET_USDC_MINT`, `TREASURY_INDEX_POLL_MS`, `TREASURY_INDEX_PER_POLL`, `TREASURY_WATCH_POLL_MS`, `TREASURY_MIN_UPGRADE_TIMELOCK_HOURS` | On-chain treasuries | [Treasury settings](liquidity-and-treasury.md#treasury-settings) |
| `SOLANA_RPC_URL_DEVNET`, `SOLANA_RPC_URL_MAINNET`, `SOLANA_RPC_MAX_RPS`, `SOLANA_RPC_MAX_RETRY_SECONDS`, `SOLANA_CONFIRM_TIMEOUT_MS`, `SOLANA_CONFIRM_POLL_MS`, `SOLANA_INDEX_POLL_MS` | Solana programs: the RPC endpoints, their limits and the indexer | [Solana settings](solana-programs.md#solana-settings) |
| `SOLANA_DEVNET_TOPUP_MAX_SOL`, `SOLANA_DEVNET_TOPUP_DAILY_SOL`, `SOLANA_DEVNET_AUTHORITY_KEEP_SOL` | Devnet funding of call keys | [Solana settings](solana-programs.md#solana-settings) |
| `SOLANA_BUILD_SNAPSHOT`, `SOLANA_BUILD_SNAPSHOT_MAX_AGE_DAYS` | The pre-built Solana build environment | [Pre-built environment](solana-programs.md#pre-built-environment) |
| `SOLANA_MAINNET_VAULT_SIGNER`, `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_APPROVAL_TIMEOUT_SECONDS` | The mainnet signer and Turnkey custody | [Turnkey custody](solana-programs.md#turnkey-custody) |
| `PROGRAM_GATE_MODEL`, `PROGRAM_GATE_MONTHLY_CAP_USD`, `PROGRAM_AUDIT_CAP_USD`, `PROGRAM_AUDIT_MINUTES`, `PROGRAM_RED_TEAM_CAP_USD`, `PROGRAM_RED_TEAM_MINUTES`, `PROGRAM_ANALYSIS_MINUTES`, `PROGRAM_GATE_CARGO_AUDIT_IGNORE` | The mainnet program gate's reviews | [Budget](solana-programs.md#budget) |
| `MAINNET_UPGRADE_TIMELOCK_HOURS`, `MAINNET_APPROVAL_TTL_DAYS`, `PROGRAM_SOURCE_RETENTION_DAYS` | The gate's timelock, approval lifetime and source retention | [Sign-off and timelock](solana-programs.md#sign-off-and-timelock) |
| `CONFIDENTIAL_HOST`, `CONFIDENTIAL_HOST_URL`, `CONFIDENTIAL_HOST_CLIENT_CERT`, `CONFIDENTIAL_HOST_CLIENT_KEY`, `CONFIDENTIAL_HOST_KMS_KEY` | The confidential host this server uses | [Confidential computing settings](confidential-computing.md#confidential-computing-settings) |
| `ESIGN_PROVIDER`, `SIGNWELL_API_KEY`, `SIGNWELL_WEBHOOK_ID`, `ESIGN_TEST_MODE` | Overrides for the e-signature set-up admins make in Studio | [Environment overrides](agreements.md#environment-overrides) |
| `MYNT_BACKUP_STATUS_FILE` | Where `ops_status` reads the backup's status from | [Checking backups](#checking-backups) |
| `BUILD_POLL_MS`, `DESK_POLL_MS`, `REVIEW_POLL_MS`, `BD_POLL_MS`, `PROGRAM_GATE_POLL_MS`, `PRODUCT_HEALTH_POLL_MS`, `FIRM_CHECKS_POLL_MS` | How often each background worker looks for work | [Background work](../architecture.md#background-work) |

The confidential service has its own settings (`KEYHOUSE_*`), set on that service and not on Mynt's server. They are in [Confidential computing settings](confidential-computing.md#confidential-computing-settings). Studio's and the sample chat's settings are in their READMEs.

### Command-line commands

Besides `serve`, `serve-http` and `users`, the `mynt` command has these. Each is explained where its feature is.

| Command | What it does | Explained in |
|---|---|---|
| `clerk setup` | Turns on Clerk's allowlist and MCP client registration | [Set it up](#set-it-up) |
| `clerk first-party` | Registers one of Mynt's own apps, or repairs its scopes | [Mynt's own apps sign in without a consent screen](#mynts-own-apps-sign-in-without-a-consent-screen) |
| `clerk sync-workspaces` | Gives each workspace from before organizations its Clerk organization and members | [Workspaces from before organizations](workspaces-and-sign-in.md#workspaces-from-before-organizations) |
| `hosting wg-peers`, `hosting egress-allowlist`, `hosting routes` | What the hosting gateway reads to keep its tunnels, outbound allow-list and routes in step | [Gateway mode](apps-and-builds.md#gateway-mode) |
| `solana import-key` | Seals an existing Solana keypair as a cluster's deploy authority | [What the operator provides for mainnet](solana-programs.md#what-the-operator-provides-for-mainnet) |
| `product-health publisher`, `product-health init` | Prints the publisher key's address; names the publisher on chain once after deploying | [Deploying the program](licence-providers.md#deploying-the-program) |
| `confidential status`, `confidential init`, `confidential adopt`, `confidential rewrap` | Shows the confidential host in use and moves the vault's keys to it | [Operator steps for AWS Nitro Enclaves](confidential-computing.md#operator-steps-for-aws-nitro-enclaves) |

## Starting empty

A new deployment starts with no products, regions or product categories. Mynt admins define regions, categories and the regulatory model (see [Set up a region's regulatory model](platform-admin.md#set-up-a-regions-regulatory-model)), and builders compose and publish products.

Mynt's reference catalogue (products with no owner, read-only and open to every builder) is kept in the database too. A Mynt admin publishes it from the seed definitions; see [The reference catalogue](products.md#the-reference-catalogue). Its products are composed of regulated primitives like any other (`admin_set_product_composition`, `get_product_regime`).

## Development

`npm test` in `core/` builds the server and then runs every file in `core/test` on in-process Postgres (PGlite). From the repository root, `npm test` runs the same.

```sh
# in core/
npm test
TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm test   # also runs the CLI and stdio test against a real Postgres
```

The whole suite needs memory to spare, and CI runs it on every push. For local work, build once and run the file for what you changed:

```sh
# in core/
npm run build
node --test test/<file>.test.js
```

Which test file checks which area, and the rules for changing the server, are in [AGENTS.md](../../AGENTS.md).
