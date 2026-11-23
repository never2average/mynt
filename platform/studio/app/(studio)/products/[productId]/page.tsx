import type { Metadata } from "next";
import { loadProductName } from "@/lib/conversation";
import { ProductPage } from "./product-page";

// A financial product's own workspace (components/product-workspace.tsx). The tab title is the product's name.
export async function generateMetadata({ params }: { params: Promise<{ productId: string }> }): Promise<Metadata> {
  const { productId } = await params;
  return { title: await loadProductName(productId) };
}

export default async function Page({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  return <ProductPage productId={productId} />;
}
