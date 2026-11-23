"use client";

// A financial product's workspace, as an app's: the sidebar folds to icons so the chat and the tabs get
// the room; its toggle brings it back.
import { useEffect } from "react";
import { ProductWorkspace } from "@/components/product-workspace";
import { useSidebar } from "@/components/ui/sidebar";

export function ProductPage({ productId }: { productId: string }) {
  const { setOpen } = useSidebar();
  useEffect(() => {
    setOpen(false);
  }, [setOpen]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-product-page>
      <ProductWorkspace key={productId} productId={productId} />
    </div>
  );
}
