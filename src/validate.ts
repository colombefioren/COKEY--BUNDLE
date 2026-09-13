import { z } from "zod";
import { parseFrontMatter, type RawContent } from "./content.js";
import {
  CombinedEntrySchema,
  DropEntrySchema,
  ProviderSchema,
  RateLimitEntrySchema,
  RedundancyEntrySchema,
  RankingsMetaSchema,
  SkillEntrySchema,
  type Content,
  type Provider,
  type Rankings,
  type TermsSection,
} from "./schema.js";

/**
 * Validation.
 *
 * Two kinds of check run here, and the distinction matters:
 *
 *   Errors   — the content is malformed or contradicts itself. A provider id in
 *              a ranking board that names no provider is not a typo to fix
 *              later, it is a broken reference, and a consumer cannot render it.
 *
 *   Warnings — the content is valid but a human should look at it. An entry
 *              whose review is two hundred days old, a "recommended" verdict
 *              with no source behind it, a free tier flagged as advertised while
 *              its quota source is unknown. These are the entries that go wrong
 *              quietly.
 *
 * Only a report with zero errors yields parsed `content`, so nothing downstream
 * has to handle a half-valid catalog.
 */

export type IssueSeverity = "error" | "warning";

export interface Issue {
  /** Path relative to the repository root. Empty for repository-wide issues. */
  file: string;
  /** Dotted path to the offending field, when the issue is field-scoped. */
  field?: string;
  message: string;
  severity: IssueSeverity;
}

export interface ValidationReport {
  issues: Issue[];
  errors: number;
  warnings: number;
  /** Present only when `errors` is zero. */
  content?: Content;
  counts: {
    providers: number;
    models: number;
    terms: number;
    rankable: number;
  };
}

export interface ValidateOptions {
  /** Injected so the staleness rules are testable without waiting half a year. */
  now?: Date;
  /** A review older than this many days raises a warning. */
  staleAfterDays?: number;
}

/** A review older than this is worth a second look. */
export const DEFAULT_STALE_AFTER_DAYS = 180;

export function validateContent(raw: RawContent, options: ValidateOptions = {}): ValidationReport {
  const now = options.now ?? new Date();
  const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;

  const issues: Issue[] = [];
  const error = (file: string, message: string, field?: string): void => {
    issues.push({ file, message, field, severity: "error" });
  };
  const warn = (file: string, message: string, field?: string): void => {
    issues.push({ file, message, field, severity: "warning" });
  };

  /* ---- providers ------------------------------------------------------- */

  const providers: Provider[] = [];
  const seenProviderIds = new Map<string, string>();

  for (const entry of raw.providers) {
    const parsed = ProviderSchema.safeParse(entry.data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        error(entry.path, issue.message, issue.path.join("."));
      }
      continue;
    }

    const provider = parsed.data;

    // The file name is the id. A mismatch means a reader looking for groq.json
    // found something else, which is worse than a wrong id.
    const expected = entry.path
      .split("/")
      .pop()!
      .replace(/\.json$/, "");
    if (provider.id !== expected) {
      error(entry.path, `id "${provider.id}" does not match file name "${expected}.json"`, "id");
    }

    const previous = seenProviderIds.get(provider.id);
    if (previous) {
      error(
        entry.path,
        `duplicate provider id "${provider.id}", already defined in ${previous}`,
        "id",
      );
      continue;
    }
    seenProviderIds.set(provider.id, entry.path);

    const modelIds = new Set<string>();
    for (const model of provider.models) {
      if (modelIds.has(model.id)) {
        error(entry.path, `duplicate model id "${model.id}"`, `models.${model.id}`);
      }
      modelIds.add(model.id);
    }

    if (provider.models.length === 0) {
      warn(entry.path, "provider lists no free models, so it will not appear in the picker");
    }

    if (provider.verdict === "recommended" && !provider.sourceUrl) {
      warn(entry.path, 'verdict is "recommended" with no sourceUrl to back the claim', "sourceUrl");
    }

    if (provider.freeTier.advertised && provider.freeTier.quotaSource === "unknown") {
      warn(
        entry.path,
        "free tier is advertised but the quota source is unknown — state the limit or mark it unadvertised",
        "freeTier.quotaSource",
      );
    }

    const age = daysSince(provider.reviewedAt, now);
    if (age !== undefined && age > staleAfterDays) {
      warn(
        entry.path,
        `review is ${age} days old — free tiers change faster than that`,
        "reviewedAt",
      );
    }

    providers.push(provider);
  }

  /* ---- terms ----------------------------------------------------------- */

  const terms: TermsSection[] = [];
  const seenOrders = new Map<number, string>();

  for (const entry of raw.terms) {
    const slug = entry.path.split("/").pop()!.replace(/\.md$/, "");
    const front = parseFrontMatter(entry.text);

    if (front.unterminated) {
      error(entry.path, "frontmatter opens with --- but is never closed");
      continue;
    }

    const order = Number(front.attributes.order);
    const parsed = z
      .object({
        title: z.string().min(1),
        order: z.number().int().nonnegative(),
        updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .safeParse({
        title: front.attributes.title,
        order: Number.isFinite(order) ? order : front.attributes.order,
        updatedAt: front.attributes.updatedAt,
      });

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        error(entry.path, issue.message, issue.path.join("."));
      }
      continue;
    }

    if (front.body.trim().length === 0) {
      error(entry.path, "section has no body");
      continue;
    }

    const clash = seenOrders.get(parsed.data.order);
    if (clash) {
      error(entry.path, `order ${parsed.data.order} is already used by ${clash}`, "order");
    }
    seenOrders.set(parsed.data.order, entry.path);

    terms.push({ ...parsed.data, slug, body: front.body });
  }

  terms.sort((a, b) => a.order - b.order);

  /* ---- rankings -------------------------------------------------------- */

  const rankings = parseRankings(raw, error, warn);

  /* ---- cross references ------------------------------------------------ */

  if (rankings) {
    const known = seenProviderIds;
    const check = (file: string, providerId: string, field: string): void => {
      if (!known.has(providerId)) {
        error(file, `references provider "${providerId}", which has no content file`, field);
      }
    };

    // Note the hyphenated keys: the source map is keyed by content file name,
    // because that is what an editor needs to be told to open.
    for (const entry of rankings.skill) {
      if (entry.providerId) check(rankings.sources.skill!, entry.providerId, "providerId");
    }
    for (const entry of rankings.rateLimits) {
      check(rankings.sources["rate-limits"]!, entry.providerId, "providerId");
    }
    for (const entry of rankings.combined) {
      check(rankings.sources.combined!, entry.providerId, "providerId");
    }
    for (const entry of rankings.redundancy) {
      // `keep` and `fallback` are display names, not ids, so only `alsoOn` is
      // checked — and only when it looks like an id rather than prose.
      for (const name of entry.alsoOn) {
        if (/^[a-z0-9-]+$/.test(name) && !known.has(name)) {
          warn(
            rankings.sources.redundancy!,
            `"${name}" in alsoOn looks like a provider id but has no content file`,
            "alsoOn",
          );
        }
      }
    }

    const ranks = rankings.combined.map((entry) => entry.rank);
    if (new Set(ranks).size !== ranks.length) {
      error(rankings.sources.combined!, "two entries share a rank", "rank");
    }

    for (const entry of rankings.dropList) {
      const provider = providers.find(
        (candidate) => candidate.id === entry.provider || candidate.displayName === entry.provider,
      );
      /*
       * A drop-list entry is prose as often as it is an id — "ElectronHub and
       * Hugging Face" is a legitimate way to name a pair of services. Only a
       * value that looks like an id and matches nothing is worth a warning;
       * otherwise every sentence in the list becomes noise.
       */
      const looksLikeId = /^[a-z0-9-]+$/.test(entry.provider);
      if (!provider && looksLikeId) {
        warn(
          rankings.sources["drop-list"]!,
          `"${entry.provider}" is not in the catalog`,
          "provider",
        );
      }
    }
  }

  /* ---- report ---------------------------------------------------------- */

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;

  const report: ValidationReport = {
    issues,
    errors,
    warnings,
    counts: {
      providers: providers.length,
      models: providers.reduce((sum, provider) => sum + provider.models.length, 0),
      terms: terms.length,
      rankable: rankings?.combined.length ?? 0,
    },
  };

  if (errors === 0) {
    report.content = { providers, terms, rankings: rankings! };
  }

  return report;
}

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

type IssueFn = (file: string, message: string, field?: string) => void;

/**
 * Parse each board independently so one broken file does not hide the rest.
 *
 * `meta` is required: every board is framed by its sources and its disclaimer,
 * and a ranking without provenance is a rumour. The boards themselves are
 * optional, because a catalog with only a skill board is still usable.
 */
function parseRankings(raw: RawContent, error: IssueFn, warn: IssueFn): Rankings | undefined {
  const files = raw.rankings;
  const sources: Record<string, string> = {};

  const metaFile = files.meta;
  if (!metaFile) {
    error("content/rankings/meta.json", "missing — every board needs its sources and disclaimer");
    return undefined;
  }
  sources.meta = metaFile.path;

  const meta = RankingsMetaSchema.safeParse(metaFile.data);
  if (!meta.success) {
    for (const issue of meta.error.issues) {
      error(metaFile.path, issue.message, issue.path.join("."));
    }
    return undefined;
  }

  /*
   * `ZodType<T, Def, unknown>` and not `ZodType<T>`: the third parameter is the
   * schema's *input* type, and a field with a `.default()` is optional on the
   * way in and present on the way out. Without it, `T` is inferred from the
   * input and every defaulted field comes back as `| undefined`.
   */
  const parse = <T>(
    key: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    required = false,
  ): { value: T[]; path: string } | undefined => {
    const file = files[key];
    if (!file) {
      const message = `missing board — /api/rankings will return an empty list for it`;
      if (required) error(`content/rankings/${key}.json`, "missing");
      else warn("content/rankings", `${key}.json ${message}`, key);
      return undefined;
    }
    sources[key] = file.path;

    const parsed = z.array(schema).safeParse(file.data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        error(file.path, issue.message, issue.path.join("."));
      }
      return undefined;
    }
    return { value: parsed.data, path: file.path };
  };

  const skill = parse("skill", SkillEntrySchema);
  const rateLimits = parse("rate-limits", RateLimitEntrySchema);
  const combined = parse("combined", CombinedEntrySchema);
  const redundancy = parse("redundancy", RedundancyEntrySchema);
  const dropList = parse("drop-list", DropEntrySchema);

  return {
    meta: meta.data,
    skill: skill?.value ?? [],
    rateLimits: rateLimits?.value ?? [],
    combined: combined?.value ?? [],
    redundancy: redundancy?.value ?? [],
    dropList: dropList?.value ?? [],
    sources,
  };
}

/** Whole days between an ISO date and `now`, or undefined for an unparsable date. */
export function daysSince(isoDate: string, now: Date): number | undefined {
  const parts = isoDate.split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const [year, month, day] = parts as [number, number, number];
  const then = Date.UTC(year, month - 1, day);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - then) / (24 * 60 * 60 * 1000));
}
