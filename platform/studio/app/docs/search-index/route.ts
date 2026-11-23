// The docs' search (Fumadocs' search dialog asks it, components/docs/docs-frame.tsx): Fumadocs' own index over every
// page, its sections and every tool (lib/docs-source.ts), held by this app; no outside search service. Public, as
// the docs are. GET ?query=<words> answers the matches.
import { createFromSource } from "fumadocs-core/search/server";

import { source } from "@/lib/docs-source";

export const { GET } = createFromSource(source);
