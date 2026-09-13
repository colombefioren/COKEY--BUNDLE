import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultRoot, loadContent, type RawContent } from "./content.js";
import { validateContent, type ValidationReport } from "./validate.js";
import type { Content, Provider, Rankings, TermsSection } from "./schema.js";

/**
 * Building the published bundles.
 *
 * A consumer should be able to answer two questions without parsing anything
 * clever: "did the content change?" and "what is in it?". So every build emits
 * a manifest carrying a `revision` — a SHA-256 over the normalised content — and
 * one bundle per surface, so a UI that only needs the provider list does not
 * download the terms of service.
 *
 * The revision is computed over a canonical form (keys sorted, volatile fields
 * excluded) rather than over the files, so reformatting a JSON file or bumping a
 * comment does not look like a content change to a poller.
 */

export interface BuildManifest {
  /** Content hash. Compare this one string to know whether to re-fetch. */
  revision: string;
  /** ISO timestamp of the build itself. Changes on every build, by design. */
  builtAt: string;
  counts: {
    providers: number;
    models: number;
    terms: number;
    rankingEntries: number;
  };
  /** Verdict spread, so a consumer can render a summary without the full set. */
  verdicts: Record<string, number>;
  /** The newest review date in the catalog, which is the useful signal. */
  lastReviewedAt: string;
  files: string[];
}

export interface BuildResult {
  manifest: BuildManifest;
  directory: string;
  written: string[];
}

export class BuildFailedError extends Error {
  constructor(readonly report: ValidationReport) {
    super(`${report.errors} validation error(s) — nothing was written`);
    this.name = "BuildFailedError";
  }
}

const BUNDLES = [
  "index.json",
  "providers.json",
  "dossiers.json",
  "models.json",
  "terms.json",
  "rankings.json",
] as const;

/** Validate and emit. Never writes a partial build. */
export async function build(
  options: {
    root?: string;
    outDir?: string;
    now?: Date;
  } = {},
): Promise<BuildResult> {
  const root = options.root ?? defaultRoot();
  const outDir = options.outDir ?? join(root, "dist");

  const raw = await loadContent(root);
  const report = validateContent(raw, { now: options.now });
  if (!report.content) throw new BuildFailedError(report);

  const { manifest, files } = render(report.content, options.now ?? new Date());

  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const name of BUNDLES) {
    const payload = files[name];
    if (payload === undefined) continue;
    await writeFile(join(outDir, name), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    written.push(name);
  }

  return { manifest, directory: outDir, written };
}

/** Render every bundle in memory. Split out so tests need no filesystem. */
export function render(
  content: Content,
  now: Date,
): { manifest: BuildManifest; files: Record<string, unknown> } {
  const providersById = new Map(content.providers.map((provider) => [provider.id, provider]));

  const providers = Object.fromEntries(
    [...providersById.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );

  const dossiers = Object.fromEntries(
    content.providers
      .map((provider) => [
        provider.id,
        {
          operator: provider.operator,
          origin: provider.origin,
          kind: provider.kind,
          summary: provider.summary,
          verdict: provider.verdict,
          verdictReason: provider.verdictReason,
          sourceUrl: provider.sourceUrl,
          reviewedAt: provider.reviewedAt,
        },
      ])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );

  const models = Object.fromEntries(
    content.providers
      .map((provider) => [provider.id, provider.models])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );

  const revision = revisionOf({ providers, terms: content.terms, rankings: content.rankings });

  const manifest: BuildManifest = {
    revision,
    builtAt: now.toISOString(),
    counts: {
      providers: content.providers.length,
      models: content.providers.reduce((sum, provider) => sum + provider.models.length, 0),
      terms: content.terms.length,
      rankingEntries:
        content.rankings.skill.length +
        content.rankings.rateLimits.length +
        content.rankings.combined.length +
        content.rankings.redundancy.length +
        content.rankings.dropList.length,
    },
    verdicts: countVerdicts(content.providers),
    lastReviewedAt: newestReview(content.providers),
    files: [...BUNDLES],
  };

  return {
    manifest,
    files: {
      "index.json": manifest,
      "providers.json": providers,
      "dossiers.json": dossiers,
      "models.json": models,
      "terms.json": content.terms,
      "rankings.json": serializeRankings(content.rankings),
    },
  };
}

/**
 * Project the ranking boards into the shape a client expects.
 *
 * The internal `sources` map (file paths, for error messages) is dropped here:
 * it is editor metadata, not content, and shipping a reader's file paths to a
 * browser is noise at best.
 */
export function serializeRankings(rankings: Rankings): Record<string, unknown> {
  return {
    tiers: rankings.meta.tiers,
    skill: rankings.skill,
    rateLimit: rankings.rateLimits,
    combined: rankings.combined,
    redundancy: rankings.redundancy,
    dropList: rankings.dropList,
    bottomLine: rankings.meta.bottomLine,
    disclaimer: rankings.meta.disclaimer,
    sources: rankings.meta.sources,
  };
}

/** SHA-256 over the canonical form of the content, excluding build timestamps. */
export function revisionOf(input: {
  providers: unknown;
  terms: TermsSection[];
  rankings: Rankings;
}): string {
  const canonical = JSON.stringify({
    providers: sortDeep(input.providers),
    terms: input.terms.map((section) => ({
      slug: section.slug,
      title: section.title,
      order: section.order,
      updatedAt: section.updatedAt,
      body: section.body,
    })),
    rankings: serializeRankings(input.rankings),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Recursively sort object keys so key order can never change a hash. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, inner]) => [key, sortDeep(inner)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function countVerdicts(providers: Provider[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const provider of providers) {
    out[provider.verdict] = (out[provider.verdict] ?? 0) + 1;
  }
  return out;
}

function newestReview(providers: Provider[]): string {
  return providers.reduce((newest, provider) => {
    return provider.reviewedAt > newest ? provider.reviewedAt : newest;
  }, "0000-00-00");
}

/** Convenience for `npm run build` output. */
export function describeBuild(result: BuildResult): string {
  const { manifest } = result;
  return [
    `revision ${manifest.revision}`,
    `${manifest.counts.providers} providers · ${manifest.counts.models} models · ${manifest.counts.terms} terms sections · ${manifest.counts.rankingEntries} ranked entries`,
    `wrote ${result.written.length} bundle(s) to ${result.directory}`,
  ].join("\n");
}

/** Exposed for the CLI, which validates without building. */
export async function loadAndValidate(
  root = defaultRoot(),
  now = new Date(),
): Promise<{ raw: RawContent; report: ValidationReport }> {
  const raw = await loadContent(root);
  return { raw, report: validateContent(raw, { now }) };
}
