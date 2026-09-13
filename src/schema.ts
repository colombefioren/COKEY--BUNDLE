import { z } from "zod";

/**
 * The content schema.
 *
 * Every rule here exists because its absence produced a wrong or unreadable
 * entry at some point. The two that carry the most weight are `verdictReason`
 * and `sourceUrl`:
 *
 *   - A `verdict` is an opinion, so it has to come with the argument for it.
 *     Requiring the reason is what stops the catalog degrading into a list of
 *     stars with nothing behind them.
 *   - A quota claim has to cite the operator's own page. A number sourced from
 *     a blog post is how a catalog becomes confidently wrong, and COKEY renders
 *     "Quota: Unknown" rather than repeat one.
 */

/* -------------------------------------------------------------------------- *
 * Closed sets
 * -------------------------------------------------------------------------- */

/** What kind of organisation this is. Drives how a reader weighs the verdict. */
export const ProviderKindSchema = z.enum([
  "lab",
  "inference-cloud",
  "aggregator",
  "gateway",
  "local",
]);

/** Whether a reader should depend on it. */
export const ProviderVerdictSchema = z.enum(["recommended", "usable", "limited", "avoid"]);

export const ApiStyleSchema = z.enum([
  "openai",
  "anthropic",
  "google",
  "cohere",
  "cloudflare",
  "ollama",
]);

export const AuthSchemeSchema = z.enum(["bearer", "x-api-key", "query-param", "custom-header"]);

/** Where a free-tier number came from. `unknown` is a first-class answer. */
export const QuotaSourceSchema = z.enum(["provider", "unknown"]);

/** How much a rate-limit claim can be trusted. */
export const ProvenanceSchema = z.enum(["operator", "third-party", "unpublished"]);

export const ReliabilitySchema = z.enum(["solid", "watch", "avoid"]);

export const CredentialFieldSchema = z.enum(["secret", "accountId"]);

/* -------------------------------------------------------------------------- *
 * Shared scalar shapes
 * -------------------------------------------------------------------------- */

/** An ISO calendar date. Enforced so `npm run stats` can age entries correctly. */
export const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date like 2026-09-13");

/** Provider ids appear in URLs and on disk, so they stay boring. */
export const ProviderIdSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "must be lowercase alphanumeric with hyphens, and start with a letter or digit",
  );

/* -------------------------------------------------------------------------- *
 * Providers
 * -------------------------------------------------------------------------- */

export const ModelSchema = z.object({
  /** Model id exactly as the provider expects it in a request. */
  id: z.string().min(1),
  /** Advertised context window, e.g. "262K". */
  context: z.string().min(1).optional(),
  /** Code | General | Reasoning | Vision | Agent | Fallback. Free text on purpose. */
  bestFor: z.string().min(1).optional(),
  /** Measured seconds to first token. */
  latencySeconds: z.number().positive().optional(),
});

export const FreeTierSchema = z.object({
  /**
   * True only when the operator explicitly advertises a free tier. Trial credit
   * and inferred generosity deliberately do not qualify.
   */
  advertised: z.boolean(),
  summary: z.string().min(4),
  quotaSource: QuotaSourceSchema,
});

export const ProviderSchema = z.object({
  id: ProviderIdSchema,
  displayName: z.string().min(1),
  operator: z.string().min(1),
  origin: z.string().min(1),
  kind: ProviderKindSchema,
  /** One sentence a reader can act on. */
  summary: z.string().min(10).max(400),
  verdict: ProviderVerdictSchema,
  /** Why the verdict is what it is. Required: an unargued verdict helps nobody. */
  verdictReason: z.string().min(10).max(1000),

  /** The operator's own rate-limit or free-tier page. */
  sourceUrl: z.string().url().optional(),
  /** When a human last checked the claims in this file. */
  reviewedAt: DateStringSchema,

  baseUrl: z.string().url(),
  apiStyle: ApiStyleSchema,
  authScheme: AuthSchemeSchema,
  signupUrl: z.string().url().or(z.literal("")),
  docsUrl: z.string().url().optional(),

  freeTier: FreeTierSchema,
  credentialFields: z.array(CredentialFieldSchema).min(1),
  notes: z.string().optional(),

  /** Free-only model list. A model that costs money does not belong here. */
  models: z.array(ModelSchema).default([]),
});

/* -------------------------------------------------------------------------- *
 * Terms
 * -------------------------------------------------------------------------- */

export const TermsFrontMatterSchema = z.object({
  title: z.string().min(1),
  /** Position in the rendered document. Unique across sections. */
  order: z.number().int().nonnegative(),
  updatedAt: DateStringSchema,
});

export const TermsSectionSchema = TermsFrontMatterSchema.extend({
  /** Slug, derived from the file name. */
  slug: z.string().min(1),
  body: z.string().min(1),
});

/* -------------------------------------------------------------------------- *
 * Rankings
 * -------------------------------------------------------------------------- */

export const SourceSchema = z.object({
  label: z.string().min(1),
  url: z.string().url(),
});

export const SkillTierSchema = z.object({
  name: z.enum(["S", "A", "B", "C"]),
  label: z.string().min(1),
  blurb: z.string().min(1),
});

export const SkillEntrySchema = z.object({
  model: z.string().min(1),
  providerId: ProviderIdSchema.optional(),
  tierName: z.enum(["S", "A", "B", "C"]),
  sweScore: z.number().min(0).max(100).optional(),
  reason: z.string().min(1),
});

export const RateLimitEntrySchema = z.object({
  providerId: ProviderIdSchema,
  provider: z.string().min(1),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  quota: z.string().min(1),
  provenance: ProvenanceSchema,
  reliability: ReliabilitySchema,
  note: z.string().optional(),
});

export const CombinedEntrySchema = z.object({
  rank: z.number().int().positive(),
  providerId: ProviderIdSchema,
  model: z.string().min(1),
  why: z.string().min(1),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});

export const RedundancyEntrySchema = z.object({
  family: z.string().min(1),
  alsoOn: z.array(z.string().min(1)).default([]),
  keep: z.string().min(1),
  fallback: z.string().min(1),
});

export const DropEntrySchema = z.object({
  provider: z.string().min(1),
  reason: z.string().min(1),
});

export const RankingsMetaSchema = z.object({
  tiers: z.array(SkillTierSchema),
  sources: z.array(SourceSchema),
  disclaimer: z.string().min(1),
  bottomLine: z.string().min(1),
});

/* -------------------------------------------------------------------------- *
 * Inferred types
 * -------------------------------------------------------------------------- */

export type ProviderKind = z.infer<typeof ProviderKindSchema>;
export type ProviderVerdict = z.infer<typeof ProviderVerdictSchema>;
export type ApiStyle = z.infer<typeof ApiStyleSchema>;
export type AuthScheme = z.infer<typeof AuthSchemeSchema>;
export type QuotaSource = z.infer<typeof QuotaSourceSchema>;
export type ProviderModel = z.infer<typeof ModelSchema>;
export type FreeTier = z.infer<typeof FreeTierSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type TermsSection = z.infer<typeof TermsSectionSchema>;
export type SkillEntry = z.infer<typeof SkillEntrySchema>;
export type RateLimitEntry = z.infer<typeof RateLimitEntrySchema>;
export type CombinedEntry = z.infer<typeof CombinedEntrySchema>;
export type RedundancyEntry = z.infer<typeof RedundancyEntrySchema>;
export type DropEntry = z.infer<typeof DropEntrySchema>;
export type RankingsMeta = z.infer<typeof RankingsMetaSchema>;

/** The four ranking boards, keyed by the name of their content file. */
export interface Rankings {
  meta: RankingsMeta;
  skill: SkillEntry[];
  rateLimits: RateLimitEntry[];
  combined: CombinedEntry[];
  redundancy: RedundancyEntry[];
  dropList: DropEntry[];
  /** Maps a parsed board back to the file it came from, for error messages. */
  sources: Record<string, string>;
}

/** Everything the content directory holds, parsed and typed. */
export interface Content {
  providers: Provider[];
  terms: TermsSection[];
  rankings: Rankings;
}
