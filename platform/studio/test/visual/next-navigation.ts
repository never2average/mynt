// The visual harness's next/navigation: the screen's pathname, and a router that goes nowhere.
const w = globalThis as unknown as { __visualPath?: string };
export const usePathname = () => w.__visualPath ?? "/";
const router = { push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined, forward: () => undefined };
export const useRouter = () => router;
export const useSearchParams = () => new URLSearchParams();
export const redirect = () => undefined;
export const notFound = () => undefined;
