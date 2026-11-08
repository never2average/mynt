import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import { MyntProgram } from "../target/types/mynt_program";

// Runs on the local validator `anchor test` starts. Mynt runs these again, in its own clean sandbox, against the
// program it built verifiably; only that run decides whether the build ships.
describe("mynt_program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.myntProgram as Program<MyntProgram>;
  const authority = provider.wallet.publicKey;
  const [ledger] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("ledger"), authority.toBuffer()], program.programId);

  it("opens a ledger for its authority", async () => {
    await program.methods.initialize().accountsPartial({ ledger, authority }).rpc({ commitment: "confirmed" });
    const account = await program.account.ledger.fetch(ledger, "confirmed");
    assert.ok(account.authority.equals(authority));
    assert.equal(account.count.toNumber(), 0);
  });

  it("records an entry and emits an event", async () => {
    const digest = Array.from(Buffer.alloc(32, 7));
    const signature = await program.methods
      .record(new anchor.BN(42), digest)
      .accountsPartial({ ledger, authority })
      .rpc({ commitment: "confirmed" });
    const account = await program.account.ledger.fetch(ledger, "confirmed");
    assert.equal(account.count.toNumber(), 1);

    const tx = await provider.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
    const events = [...parser.parseLogs(tx?.meta?.logMessages ?? [])];
    assert.equal(events.length, 1);
    assert.match(events[0].name, /^entryRecorded$/i);
    assert.equal(events[0].data.count.toString(), "1");
    assert.equal(events[0].data.reference.toString(), "42");
  });

  it("refuses an entry signed by anyone else", async () => {
    const other = anchor.web3.Keypair.generate();
    try {
      await program.methods
        .record(new anchor.BN(1), Array.from(Buffer.alloc(32)))
        .accountsPartial({ ledger, authority: other.publicKey })
        .signers([other])
        .rpc({ commitment: "confirmed" });
      assert.fail("another signer recorded an entry");
    } catch (e) {
      assert.match(String(e), /ConstraintSeeds|ConstraintHasOne|seeds constraint|has.one/i);
    }
  });
});
