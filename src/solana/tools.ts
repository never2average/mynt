import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store, User } from "../store.js";
import { CLUSTERS } from "./rpc.js";
import type { CallInput, SolanaService } from "./service.js";
import { CUSTODY_PROVIDERS, MAINNET_BACKENDS } from "./signer.js";
import { SOLANA_TOOLCHAIN } from "./toolchain.js";

// Tools for Solana programs: developers (and innovators, who are developers too) reserve, deploy, upgrade,
// simulate and call their own programs; admins choose the mainnet signer and see every program.

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const attempt = async (f: () => Promise<unknown>) => {
  try {
    return json(await f());
  } catch (e) {
    return fail((e as Error).message);
  }
};

const ADDRESS = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "a Solana address (base58)");
const instruction = z
  .object({
    method: z.string().optional().describe("An Anchor instruction's name in snake_case (e.g. 'record'); Mynt adds its discriminator"),
    args_base64: z.string().optional().describe("The method's arguments, Borsh-encoded, base64"),
    data_base64: z.string().optional().describe("Instead of method: the whole instruction data, base64 (non-Anchor programs)"),
    accounts: z
      .array(
        z.object({
          pubkey: z.string().describe("An address, or \"$caller\" for your caller key (the only signer a call may have; it signs only when listed with signer: true)"),
          writable: z.boolean().optional(),
          signer: z.boolean().optional(),
        }),
      )
      .max(32),
  })
  .describe("The instruction to send to the program");

export function registerSolanaTools(server: McpServer, store: Store, user: User, solana: SolanaService) {
  const own = async (programId: string) => {
    const p = await solana.get(programId);
    return p && solana.canAct(user, p) ? p : undefined;
  };
  const withProgram = (programId: string, f: (p: NonNullable<Awaited<ReturnType<typeof own>>>) => Promise<unknown>) =>
    attempt(async () => {
      const p = await own(programId);
      if (!p) throw new Error(`No program of yours with id '${programId}'`);
      return f(p);
    });

  server.registerTool(
    "reserve_program_id",
    {
      title: "Reserve a Solana program address",
      description:
        "Developer: reserve the address (program id) of a new Solana program on devnet or mainnet, for one of your apps or products. Put it in the program's declare_id! and Anchor.toml; Mynt keeps the address's keypair and uses it once, at the first deploy. Builds of the app get the reserved addresses in their spec.",
      inputSchema: {
        name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "the Anchor program's name, snake_case"),
        cluster: z.enum(CLUSTERS).default("devnet"),
        app_id: z.string().optional().describe("The app the program belongs to"),
        product_id: z.string().optional().describe("Or the product it belongs to"),
      },
    },
    async ({ name, cluster, app_id, product_id }) =>
      attempt(async () => {
        if (app_id) {
          const app = await store.getApp(app_id);
          if (!app || app.owner_id !== user.id) throw new Error(`No app of yours with id '${app_id}'`);
        }
        if (product_id) {
          const product = await store.getProduct(product_id);
          if (!product || product.owner_id !== user.id) throw new Error(`No product of yours with id '${product_id}'`);
        }
        const p = await solana.reserve(user, { name, cluster, app_id, product_id });
        await store.audit(user.id, "reserve_program_id", p.program_id, { name, cluster, app_id, product_id });
        return {
          ...solana.view(p),
          next: `Declare it in the program: declare_id!("${p.program_id}") and [programs.${cluster === "devnet" ? "devnet" : "mainnet"}] ${name} = "${p.program_id}" in Anchor.toml (and [programs.localnet] for tests). Build it with start_build, then deploy_program with the build.`,
          toolchain: { agave: SOLANA_TOOLCHAIN.agave.version, anchor: SOLANA_TOOLCHAIN.anchor.version, rust: SOLANA_TOOLCHAIN.rust.version },
        };
      }),
  );

  server.registerTool(
    "deploy_program",
    {
      title: "Deploy a Solana program",
      description:
        "Developer: deploy a reserved program from a build Mynt verified. Mynt deploys the program it built itself in its clean verify sandbox (Anchor's verifiable build, tested on a local validator), never the coding agent's file, and records its hash. Devnet signs with Mynt's devnet key; mainnet is refused until an admin configures and enables the mainnet signer. Runs in the background: follow it with get_program.",
      inputSchema: { program_id: ADDRESS, build_id: z.string().describe("A succeeded build whose verification built this program") },
    },
    async ({ program_id, build_id }) =>
      withProgram(program_id, async (p) => {
        const started = await solana.deploy(user, p, build_id, "deploy");
        await store.audit(user.id, "deploy_program", p.program_id, { cluster: p.cluster, build_id });
        return { ...solana.view(started), track_with: "get_program" };
      }),
  );

  server.registerTool(
    "upgrade_program",
    {
      title: "Upgrade a deployed Solana program",
      description:
        "Developer: replace a deployed program's code with the program Mynt built from a newer verified build. Same rules as deploy_program; the program keeps its address and its upgrade authority. Runs in the background: follow it with get_program.",
      inputSchema: { program_id: ADDRESS, build_id: z.string() },
    },
    async ({ program_id, build_id }) =>
      withProgram(program_id, async (p) => {
        const started = await solana.deploy(user, p, build_id, "upgrade");
        await store.audit(user.id, "upgrade_program", p.program_id, { cluster: p.cluster, build_id });
        return { ...solana.view(started), track_with: "get_program" };
      }),
  );

  server.registerTool(
    "list_programs",
    { title: "My Solana programs", description: "Developer: your Solana programs, reserved and deployed, newest first.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => json((await solana.list(user.id)).map((p) => solana.view(p))),
  );

  server.registerTool(
    "get_program",
    {
      title: "One Solana program",
      description: "Developer: a program in full: its status (and any deploy or upgrade in progress), every version Mynt deployed with its build and hash, and its latest events.",
      inputSchema: { program_id: ADDRESS },
      annotations: { readOnlyHint: true },
    },
    async ({ program_id }) => withProgram(program_id, async (p) => ({ ...solana.view(p), versions: await solana.versions(p), recent_events: await solana.events(p) })),
  );

  server.registerTool(
    "simulate_program_call",
    {
      title: "Simulate a call to a Solana program",
      description:
        "Developer: run an instruction against one of your deployed programs without sending it: the logs, compute used and any error. Fees come from your fee payer, which no program sees; $caller is your caller key.",
      inputSchema: { program_id: ADDRESS, instruction },
      annotations: { readOnlyHint: true },
    },
    async ({ program_id, instruction }) => withProgram(program_id, (p) => solana.simulate(user, p, instruction as CallInput)),
  );

  server.registerTool(
    "call_program",
    {
      title: "Call a Solana program",
      description:
        "Developer: send an instruction to one of your deployed programs. Mynt simulates it first and sends it only if the simulation succeeds, with fees from your own fee payer (never passed to the program) and signed by your caller key only where the instruction lists $caller as a signer; never Mynt's deploy authority. Mainnet is refused until it's configured and enabled.",
      inputSchema: { program_id: ADDRESS, instruction },
    },
    async ({ program_id, instruction }) => withProgram(program_id, (p) => solana.call(user, p, instruction as CallInput)),
  );
}

export function registerSolanaAdminTools(server: McpServer, store: Store, user: User, solana: SolanaService) {
  server.registerTool(
    "configure_solana_signer",
    {
      title: "Configure the Solana mainnet signer",
      description:
        "Admin: choose who signs Mynt's mainnet deploys and upgrades, and turn mainnet on or off. Backends: mainnet-vault (a key in Mynt's vault; the server must also set SOLANA_MAINNET_VAULT_SIGNER=enabled), custody-service (Turnkey signs each transaction with a Solana wallet account it holds; Mynt never sees the key, and the server must set TURNKEY_ORGANIZATION_ID, TURNKEY_API_PUBLIC_KEY and TURNKEY_API_PRIVATE_KEY), multisig (Squads-style; members approve each change). Mainnet stays refused until the backend is ready and enabled is true. Call with no arguments to see the current state and what's missing.",
      inputSchema: {
        backend: z.enum(MAINNET_BACKENDS).optional(),
        enabled: z.boolean().optional(),
        generate_key: z.boolean().optional().describe("mainnet-vault: generate the mainnet key in Mynt's vault (only its address is ever shown)"),
        custody_provider: z.enum(CUSTODY_PROVIDERS).optional().describe("custody-service: the provider that holds the key (default turnkey)"),
        custody_address: ADDRESS.optional().describe("custody-service: the Solana wallet account address the provider signs with (Turnkey's signWith)"),
        multisig_address: ADDRESS.optional(),
        multisig_vault: ADDRESS.optional().describe("multisig: the vault address that holds the upgrade authority"),
      },
    },
    async (a) =>
      attempt(async () => {
        const changing = Object.values(a).some((v) => v !== undefined);
        if (!changing) return solana.status();
        const r = await solana.configureMainnet(user, {
          ...(a.backend !== undefined ? { backend: a.backend } : {}),
          ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
          ...(a.custody_address ? { custody: { provider: a.custody_provider ?? "turnkey", address: a.custody_address } } : {}),
          ...(a.multisig_address && a.multisig_vault ? { multisig: { address: a.multisig_address, vault: a.multisig_vault } } : {}),
          generate_key: a.generate_key,
        });
        await store.audit(user.id, "configure_solana_signer", "mainnet", {
          backend: a.backend,
          enabled: a.enabled,
          generate_key: a.generate_key ?? false,
          ...(a.custody_address ? { custody_provider: a.custody_provider ?? "turnkey", custody_address: a.custody_address } : {}),
        });
        return {
          ...r,
          ...(r.mainnet.backend === "custody-service" && r.mainnet.deploy_payer
            ? {
                funding: `Fund the deploy payer ${r.mainnet.deploy_payer} with SOL before the first mainnet deploy: about 0.021 SOL per KB of program (its program data reserves twice its size for upgrades, and the upload buffer holds a copy until the deploy), plus fees. The custody address ${r.mainnet.authority ?? "(not set yet)"} needs none: it only signs.`,
              }
            : {}),
          ...(r.mainnet.authority && r.mainnet.backend === "mainnet-vault"
            ? { funding: `Fund ${r.mainnet.authority} with SOL before the first mainnet deploy: about 0.021 SOL per KB of program (its program data reserves twice its size for upgrades, and the upload buffer holds a copy until the deploy), plus fees.` }
            : {}),
        };
      }),
  );

  server.registerTool(
    "list_all_programs",
    {
      title: "Every Solana program",
      description: "Admin: every developer's Solana programs on devnet and mainnet, newest first, with the signer that deployed them.",
      inputSchema: { cluster: z.enum(CLUSTERS).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ cluster }) =>
      json(
        (await solana.list(null))
          .filter((p) => !cluster || p.cluster === cluster)
          .map((p) => ({ ...solana.view(p), owner_id: p.owner_id, entity_id: p.entity_id })),
      ),
  );
}
