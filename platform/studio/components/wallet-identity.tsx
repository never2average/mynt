"use client"

// How a wallet is named everywhere in the studio: the wallet app's own icon and name, as its
// Wallet Standard registration gives them, when a detected wallet has connected that address; else
// a plain wallet icon and the short address only. The chain is never drawn here: each surface says
// it once, as one muted label. And Connect wallet's chooser: the detected wallets by their own names
// and icons, or a plain line when none is detected.
import { useState } from "react"
import { ChevronLeft, Wallet as WalletIcon } from "lucide-react"

import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { appOf, connectWallet, type BrowserWallet, type WalletApp } from "@/lib/browser-wallet"
import { shortAddress } from "@/lib/linked-accounts"

export const NO_WALLET_DETECTED = "No wallet found in this browser."

export function WalletAppIcon({ app, className = "size-4" }: { app: WalletApp | null; className?: string }) {
  // The app's own icon (an image data URI it registered), never a drawn brand mark.
  if (app?.icon) return <img src={app.icon} alt="" className={`${className} shrink-0 rounded-sm`} data-wallet-app-icon={app.name} />
  return <WalletIcon className={`${className} shrink-0`} />
}

// "Phantom 7EcD…FLtV" when the app is known, else "7EcD…FLtV".
export function WalletName({ address, app }: { address: string; app: WalletApp | null }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={address}>
      {app && (
        <span className="truncate" data-wallet-app={app.name}>
          {app.name}
        </span>
      )}
      <span className={`font-mono text-xs${app ? " text-muted-foreground" : ""}`}>{shortAddress(address)}</span>
    </span>
  )
}

// Inside a wallet menu: "Connect wallet", which turns the menu into the chooser. Choosing a wallet
// asks it to connect (nothing is signed); the menu stays open, back on the wallet with its app's
// name once it has connected, and `onConnected` reads the wallets again.
export function ConnectWalletItems({ wallets, onConnected }: { wallets: BrowserWallet[]; onConnected: () => void }) {
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!choosing)
    return (
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault()
          setChoosing(true)
        }}
        data-connect-wallet
      >
        <WalletIcon />
        Connect wallet
      </DropdownMenuItem>
    )
  return (
    <div data-wallet-chooser>
      {wallets.length ? (
        wallets.map((w) => {
          const app = appOf(w)
          return (
            <DropdownMenuItem
              key={w.name}
              onSelect={async (e) => {
                e.preventDefault()
                const r = await connectWallet(w)
                setError("error" in r ? r.error : null)
                if (!("error" in r)) setChoosing(false)
                onConnected()
              }}
              data-detected-wallet={w.name}
            >
              <WalletAppIcon app={app} />
              {app.name}
            </DropdownMenuItem>
          )
        })
      ) : (
        <p className="px-2 py-1.5 text-sm text-muted-foreground" data-no-wallet-detected>
          {NO_WALLET_DETECTED}
        </p>
      )}
      {error && (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault()
          setChoosing(false)
        }}
        data-connect-back
      >
        <ChevronLeft />
        Back
      </DropdownMenuItem>
    </div>
  )
}
