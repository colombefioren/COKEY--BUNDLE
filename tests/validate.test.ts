import { describe, expect, it } from "vitest";
import type { RawContent, RawFile, RawText } from "../src/content.js";
import { daysSince, validateContent } from "../src/validate.js";

/**
 * The validator is where a content repository stays honest, so the tests are
 * about the two different things it reports: errors that make the content
 * unusable, and warnings that mean a human should look at it.
 */

const NOW = new Date(Date.UTC(2026, 8, 13));

function provider(data: unknown, id = "alpha"): RawFile<unknown> {
  return { path: `content/providers/${id}.json`, absolute: `/tmp/${id}.json`, data };
}

function term(title: string, order: number, body = "A body long enough to render."): RawText {
  const slug = title.toLowerCase().replace(/\s+/g, "-");
  return {
    path: `content/terms/${slug}.md`,
    absolute: `/tmp/${slug}.md`,
    text: `---\ntitle: ${title}\norder: ${order}\nupdatedAt: 2026-09-01\n---\n\n${body}\n`,
  };
}

const META: RawFile<unknown> = {
  path: "content/rankings/meta.json",
  absolute: "/tmp/meta.json",
  data: {
    tiers: [{ name: "S", label: "Purpose-built", blurb: "Start here." }],
    sources: [{ label: "Operator page", url: "https://example.test/limits" }],
    disclaimer: "Benchmarks move; your own key is the only score that counts.",
    bottomLine: "Two providers cover daily volume.",
  },
};

function entry(data: unknown): RawFile<unknown> {
  return { path: "content/rankings/combined.json", absolute: "/tmp/combined.json", data };
}

function raw(overrides: Partial<RawContent> = {}): RawContent {
  return {
    root: "/tmp",
    providers: [
      provider({
        id: "alpha",
        displayName: "Alpha API",
        operator: "Alpha Ltd",
        origin: "France",
        kind: "aggregator",
        summary: "A free pool with a published daily allowance.",
        verdict: "usable",
        verdictReason: "Worth a key if the allowance holds up.",
        reviewedAt: "2026-09-01",
        baseUrl: "https://api.alpha.test/v1",
        apiStyle: "openai",
        authScheme: "bearer",
        signupUrl: "https://alpha.test/keys",
        freeTier: { advertised: true, summary: "1M tokens/day", quotaSource: "provider" },
        credentialFields: ["secret"],
        models: [{ id: "model-a" }],
      }),
    ],
    terms: [term("One", 1)],
    rankings: {
      meta: META,
      combined: entry([{ rank: 1, providerId: "alpha", model: "model-a", why: "ok", tier: 1 }]),
    },
    ...overrides,
  };
}

describe("validateContent", () => {
  it("accepts content that is complete and cross-referenced", () => {
    const report = validateContent(raw(), { now: NOW });

    expect(report.errors).toBe(0);
    expect(report.content).toBeDefined();
    expect(report.counts).toEqual({ providers: 1, models: 1, terms: 1, rankable: 1 });
  });

  it("withholds parsed content while an error stands", () => {
    const report = validateContent(raw({ providers: [provider({ id: "alpha" })] }), { now: NOW });

    expect(report.errors).toBeGreaterThan(0);
    // Nothing downstream should have to handle half-valid content.
    expect(report.content).toBeUndefined();
  });

  it("names the file and the field of a schema error", () => {
    const report = validateContent(
      raw({ providers: [provider({ id: "alpha", displayName: "" })] }),
      { now: NOW },
    );

    const issue = report.issues.find((entry) => entry.field === "displayName")!;
    expect(issue.file).toBe("content/providers/alpha.json");
  });

  it("reports an id that disagrees with the file name", () => {
    const base = raw().providers[0]!.data as Record<string, unknown>;
    const report = validateContent(
      raw({ providers: [provider({ ...base, id: "beta" }, "alpha")] }),
      { now: NOW },
    );

    expect(report.issues.some((issue) => issue.message.includes("does not match file name"))).toBe(
      true,
    );
  });

  it("reports a duplicate provider id", () => {
    const first = provider(
      {
        id: "alpha",
        displayName: "Alpha",
        operator: "A",
        origin: "FR",
        kind: "aggregator",
        summary: "A summary long enough.",
        verdict: "usable",
        verdictReason: "A reason long enough.",
        reviewedAt: "2026-09-01",
        baseUrl: "https://a.test",
        apiStyle: "openai",
        authScheme: "bearer",
        signupUrl: "",
        freeTier: { advertised: false, summary: "No free tier", quotaSource: "unknown" },
        credentialFields: ["secret"],
      },
      "alpha",
    );

    const report = validateContent(
      raw({ providers: [first, { ...first, path: "content/providers/alpha2.json" }] }),
      {
        now: NOW,
      },
    );

    // One survives, the later one is reported rather than silently merged.
    expect(report.counts.providers).toBe(1);
    expect(report.issues.some((issue) => issue.message.includes("duplicate provider id"))).toBe(
      true,
    );
  });

  it("reports a duplicate model id inside one provider", () => {
    const base = raw().providers[0]!.data as Record<string, unknown>;
    const report = validateContent(
      raw({ providers: [provider({ ...base, models: [{ id: "dup" }, { id: "dup" }] })] }),
      { now: NOW },
    );

    expect(report.issues.some((issue) => issue.message.includes('duplicate model id "dup"'))).toBe(
      true,
    );
  });

  it("reports a ranking entry that names no provider", () => {
    const report = validateContent(
      raw({
        rankings: {
          meta: META,
          combined: entry([{ rank: 1, providerId: "ghost", model: "m", why: "ok", tier: 1 }]),
        },
      }),
      { now: NOW },
    );

    const issue = report.issues.find((entry) => entry.severity === "error")!;
    expect(issue.file).toBe("content/rankings/combined.json");
    expect(issue.message).toContain("ghost");
  });

  it("reports two combined entries sharing a rank", () => {
    const report = validateContent(
      raw({
        rankings: {
          meta: META,
          combined: entry([
            { rank: 1, providerId: "alpha", model: "a", why: "ok", tier: 1 },
            { rank: 1, providerId: "alpha", model: "b", why: "ok", tier: 1 },
          ]),
        },
      }),
      { now: NOW },
    );

    expect(report.issues.some((issue) => issue.message.includes("share a rank"))).toBe(true);
  });

  it("reports a missing rankings meta file", () => {
    const report = validateContent(raw({ rankings: {} }), { now: NOW });

    expect(report.issues.some((issue) => issue.file === "content/rankings/meta.json")).toBe(true);
    expect(report.content).toBeUndefined();
  });

  it("reports two terms sections claiming one position", () => {
    const report = validateContent(raw({ terms: [term("One", 1), term("Also one", 1)] }), {
      now: NOW,
    });

    // Both are parsed so the editor can see what collided, but the report is an
    // error, so no consumer ever receives an ambiguous reading order.
    expect(report.errors).toBeGreaterThan(0);
    expect(report.content).toBeUndefined();
    expect(report.issues.some((issue) => issue.message.includes("already used"))).toBe(true);
  });

  it("orders terms by their declared position", () => {
    const report = validateContent(raw({ terms: [term("Third", 3), term("First", 1)] }), {
      now: NOW,
    });

    expect(report.content!.terms.map((section) => section.title)).toEqual(["First", "Third"]);
  });

  it("warns when a review has gone stale", () => {
    const base = raw().providers[0]!.data as Record<string, unknown>;
    const report = validateContent(
      raw({ providers: [provider({ ...base, reviewedAt: "2025-01-01" })] }),
      { now: NOW },
    );

    expect(report.errors).toBe(0);
    expect(report.issues.some((issue) => issue.message.includes("days old"))).toBe(true);
  });

  it("warns when a recommended verdict cites no source", () => {
    const base = raw().providers[0]!.data as Record<string, unknown>;
    const report = validateContent(
      raw({ providers: [provider({ ...base, verdict: "recommended" })] }),
      { now: NOW },
    );

    expect(report.issues.some((issue) => issue.message.includes("no sourceUrl"))).toBe(true);
  });

  it("warns when a free tier is advertised without a quota source", () => {
    const base = raw().providers[0]!.data as Record<string, unknown>;
    /** Warnings about this one provider, ignoring the absent-boards chatter. */
    const aboutProvider = (report: ReturnType<typeof validateContent>): number =>
      report.issues.filter((issue) => issue.file === "content/providers/alpha.json").length;

    const sourced = validateContent(raw({ providers: [provider(base, "alpha")] }), { now: NOW });
    expect(aboutProvider(sourced)).toBe(0);

    const unsourced = validateContent(
      raw({
        providers: [
          provider({
            ...base,
            freeTier: { ...(base.freeTier as object), quotaSource: "unknown" },
          }),
        ],
      }),
      { now: NOW },
    );
    expect(
      unsourced.issues.some((issue) => issue.message.includes("quota source is unknown")),
    ).toBe(true);
  });

  it("warns that a provider with no free models will not appear in the picker", () => {
    const base = raw().providers[0]!.data as Record<string, unknown>;
    const report = validateContent(
      raw({
        providers: [provider({ ...base, models: [] })],
        rankings: { meta: META },
      }),
      { now: NOW },
    );

    expect(report.issues.some((issue) => issue.message.includes("no free models"))).toBe(true);
  });

  it("does not warn about a drop-list entry written as prose", () => {
    // "ElectronHub and Hugging Face" names two services; only something that
    // looks like an id and matches nothing is worth a warning.
    const report = validateContent(
      raw({
        rankings: {
          meta: META,
          combined: entry([{ rank: 1, providerId: "alpha", model: "m", why: "ok", tier: 1 }]),
          "drop-list": {
            path: "content/rankings/drop-list.json",
            absolute: "/tmp/drop-list.json",
            data: [{ provider: "ElectronHub and Hugging Face", reason: "Credit capped." }],
          },
        },
      }),
      { now: NOW },
    );

    expect(report.errors).toBe(0);
    expect(report.issues.some((issue) => issue.file.includes("drop-list"))).toBe(false);
  });

  it("warns about a drop-list entry that looks like an id and matches nothing", () => {
    const report = validateContent(
      raw({
        rankings: {
          meta: META,
          combined: entry([{ rank: 1, providerId: "alpha", model: "m", why: "ok", tier: 1 }]),
          "drop-list": {
            path: "content/rankings/drop-list.json",
            absolute: "/tmp/drop-list.json",
            data: [{ provider: "ghost-provider", reason: "Gone." }],
          },
        },
      }),
      { now: NOW },
    );

    expect(report.issues.some((issue) => issue.message.includes("not in the catalog"))).toBe(true);
  });
});

describe("daysSince", () => {
  it("counts whole days between an ISO date and now", () => {
    expect(daysSince("2026-09-01", NOW)).toBe(12);
  });

  it("returns undefined for a date it cannot parse", () => {
    expect(daysSince("sometime", NOW)).toBeUndefined();
  });
});
