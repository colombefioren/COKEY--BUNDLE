#!/usr/bin/env node
/**
 * Import the catalog out of a COKEY checkout.
 *
 * A one-time bridge, kept in the repository because it is also the answer to
 * "how did this content get here?" — a question a content repository should be
 * able to answer about its own first commit.
 *
 * COKEY kept the catalog as TypeScript data: `PROVIDER_CATALOG` for identity,
 * `providerDossiers()` for the opinion, `MODELS_BY_PROVIDER` for the model
 * lists, and the ranking constants. This reads all four through their public
 * exports and writes one JSON file per provider, plus the ranking boards.
 *
 * Deliberately not part of `npm run build`: it is not something you run twice.
 * Running it again overwrites every file with a machine-formatted version of
 * itself, which would bury a human's edit. It refuses to clobber unless
 * `--force` is passed, because the failure mode of guessing wrong here is
 * losing hand-written prose.
 *
 * Usage
 *   npx tsx tools/import-from-cokey.ts --source ../COKEY [--force] [--reviewed 2026-09-13]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Args {
  source: string;
  force: boolean;
  reviewed: string;
}

function parse(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }

  const source = flags.get("source");
  if (typeof source !== "string") {
    console.error("Pass --source <path to a COKEY checkout>, for example --source ../COKEY");
    process.exit(2);
  }

  return {
    source: resolve(source),
    force: flags.get("force") === true,
    reviewed: (typeof flags.get("reviewed") === "string"
      ? (flags.get("reviewed") as string)
      : new Date().toISOString().slice(0, 10)),
  };
}

/** Import a module from the source checkout by path, resolved as an absolute URL. */
async function fromSource<T>(source: string, relativePath: string): Promise<T> {
  const absolute = join(source, relativePath);
  if (!existsSync(absolute)) {
    throw new Error(`Missing ${relativePath} in ${source} — is that a COKEY checkout?`);
  }
  return (await import(pathToFileURL(absolute).href)) as T;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));

  const providersModule = await fromSource<{
    PROVIDER_CATALOG: unknown[];
  }>(args.source, "src/catalog/providers.ts");

  const dossiersModule = await fromSource<{
    providerDossiers: () => Record<string, Dossier>;
  }>(args.source, "src/catalog/dossiers.ts");

  const modelsModule = await fromSource<{
    modelsForProvider: (id: string) => unknown[];
  }>(args.source, "src/catalog/models.ts");

  const dedupeModule = await fromSource<{
    mergeProviderEntries: <T>(entries: T[]) => T[];
  }>(args.source, "src/catalog/dedupe.ts");

  const rankingsModule = await fromSource<Record<string, unknown>>(
    args.source,
    "src/catalog/rankings.ts",
  );

  const catalog = dedupeModule.mergeProviderEntries(providersModule.PROVIDER_CATALOG) as Array<
    CatalogEntry
  >;
  const dossiers = dossiersModule.providerDossiers();

  const providersDir = join(ROOT, "content", "providers");
  const rankingsDir = join(ROOT, "content", "rankings");
  await mkdir(providersDir, { recursive: true });
  await mkdir(rankingsDir, { recursive: true });

  let written = 0;
  let skipped = 0;

  for (const entry of [...catalog].sort((a, b) => a.id.localeCompare(b.id))) {
    const dossier = dossiers[entry.id];
    if (!dossier) {
      console.warn(`! ${entry.id}: no dossier, skipping (it would be unopinionated content)`);
      skipped += 1;
      continue;
    }

    const target = join(providersDir, `${entry.id}.json`);
    if (existsSync(target) && !args.force) {
      skipped += 1;
      continue;
    }

    const provider = {
      id: entry.id,
      displayName: entry.displayName,
      operator: dossier.operator,
      origin: dossier.origin,
      kind: dossier.kind,
      summary: dossier.summary,
      verdict: dossier.verdict,
      verdictReason: dossier.verdictReason,
      ...(dossier.sourceUrl ? { sourceUrl: dossier.sourceUrl } : {}),
      reviewedAt: args.reviewed,
      baseUrl: entry.baseUrl,
      apiStyle: entry.apiStyle,
      authScheme: entry.authScheme,
      signupUrl: entry.signupUrl ?? "",
      ...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
      freeTier: entry.freeTier,
      credentialFields: entry.credentialFields,
      ...(entry.notes ? { notes: entry.notes } : {}),
      models: modelsModule.modelsForProvider(entry.id),
    };

    await writeFile(target, `${JSON.stringify(provider, null, 2)}\n`, "utf8");
    written += 1;
  }

  const boards: Array<[string, unknown]> = [
    [
      "meta.json",
      {
        tiers: rankingsModule.SKILL_TIERS,
        sources: rankingsModule.RANKING_SOURCES,
        disclaimer: rankingsModule.RANKING_DISCLAIMER,
        bottomLine: rankingsModule.RANKING_BOTTOM_LINE,
      },
    ],
    ["skill.json", rankingsModule.SKILL_RANKING],
    ["rate-limits.json", rankingsModule.RATE_LIMIT_RANKING],
    ["combined.json", rankingsModule.COMBINED_RANKING],
    ["redundancy.json", rankingsModule.REDUNDANCY_TABLE],
    ["drop-list.json", rankingsModule.DROP_LIST],
  ];

  let boardsWritten = 0;
  for (const [name, payload] of boards) {
    const target = join(rankingsDir, name);
    if (existsSync(target) && !args.force) continue;
    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    boardsWritten += 1;
  }

  console.log(
    `imported ${written} provider file(s) and ${boardsWritten} ranking board(s) ` +
      `from ${args.source} (${skipped} skipped, already present)`,
  );
}

interface CatalogEntry {
  id: string;
  displayName: string;
  baseUrl: string;
  apiStyle: string;
  authScheme: string;
  signupUrl?: string;
  docsUrl?: string;
  freeTier: unknown;
  credentialFields: string[];
  notes?: string;
}

interface Dossier {
  operator: string;
  origin: string;
  kind: string;
  summary: string;
  verdict: string;
  verdictReason: string;
  sourceUrl?: string;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
