import { describe, expect, it } from "vitest";
import { BuildFailedError, build, describeBuild, render } from "../src/build.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Content } from "../src/schema.js";

/**
 * The build's contract with a consumer is narrow on purpose: one revision string
 * to compare, and one bundle per surface. These tests hold it to both, and to
 * the rule that a build which fails validation writes nothing at all.
 */

const NOW = new Date(Date.UTC(2026, 8, 13, 12, 0, 0));

function content(overrides: Partial<Content> = {}): Content {
  return {
    providers: [
      {
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
      },
    ],
    terms: [
      {
        slug: "one",
        title: "One",
        order: 1,
        updatedAt: "2026-09-01",
        body: "A term.",
      },
    ],
    rankings: {
      meta: {
        tiers: [{ name: "S", label: "Purpose-built", blurb: "Start here." }],
        sources: [{ label: "Operator page", url: "https://example.test/limits" }],
        disclaimer: "Benchmarks move; your own key is the only score that counts.",
        bottomLine: "Two providers cover daily volume.",
      },
      skill: [{ model: "model-a", tierName: "S", reason: "Trained for code." }],
      rateLimits: [],
      combined: [{ rank: 1, providerId: "alpha", model: "model-a", why: "Volume.", tier: 1 }],
      redundancy: [],
      dropList: [],
      sources: {},
    },
    ...overrides,
  };
}

describe("render", () => {
  it("emits one bundle per surface plus a manifest", () => {
    const { files, manifest } = render(content(), NOW);

    expect(Object.keys(files).sort()).toEqual([
      "dossiers.json",
      "index.json",
      "models.json",
      "providers.json",
      "rankings.json",
      "terms.json",
    ]);
    expect(manifest.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest.counts).toMatchObject({ providers: 1, models: 1, terms: 1 });
    expect(manifest.verdicts).toEqual({ usable: 1 });
    expect(manifest.lastReviewedAt).toBe("2026-09-01");
  });

  it("keeps the opinion separate from the endpoint details", () => {
    const { files } = render(content(), NOW);
    const dossiers = files["dossiers.json"] as Record<string, Record<string, unknown>>;

    expect(dossiers.alpha).toMatchObject({ operator: "Alpha Ltd", verdict: "usable" });
    // A consumer that only renders verdicts should not receive base URLs.
    expect(dossiers.alpha).not.toHaveProperty("baseUrl");
  });

  it("publishes the meta sources, not the internal file-path map", () => {
    const { files } = render(content(), NOW);
    const rankings = files["rankings.json"] as Record<string, unknown>;

    // `sources` here is the editor's list of cited pages. The internal map that
    // says which file a board came from stays inside the build.
    expect(rankings.sources).toEqual([
      { label: "Operator page", url: "https://example.test/limits" },
    ]);
  });

  it("is stable across key order, so a reformat is not a content change", () => {
    const first = render(content(), NOW).manifest.revision;

    const shuffled = content();
    const reordered = {
      ...shuffled.providers[0]!,
      freeTier: { quotaSource: "provider" as const, summary: "1M tokens/day", advertised: true },
    };
    const second = render(content({ providers: [reordered] }), NOW).manifest.revision;

    expect(second).toBe(first);
  });

  it("changes when content changes", () => {
    const first = render(content(), NOW).manifest.revision;

    const edited = content();
    const second = render(
      content({
        providers: [{ ...edited.providers[0]!, verdict: "limited" }],
      }),
      NOW,
    ).manifest.revision;

    expect(second).not.toBe(first);
  });

  it("changes when the terms are edited", () => {
    const first = render(content(), NOW).manifest.revision;
    const second = render(
      content({ terms: [{ ...content().terms[0]!, body: "An amended term." }] }),
      NOW,
    ).manifest.revision;

    expect(second).not.toBe(first);
  });
});

describe("build", () => {
  it("writes every bundle to the output directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "cms-build-"));
    const out = join(root, "dist");
    try {
      mkdirSync(join(root, "content", "providers"), { recursive: true });
      mkdirSync(join(root, "content", "terms"), { recursive: true });
      mkdirSync(join(root, "content", "rankings"), { recursive: true });

      writeFileSync(
        join(root, "content", "providers", "alpha.json"),
        JSON.stringify({
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
      );

      // Every board needs the meta that frames it: sources and a disclaimer.
      writeFileSync(
        join(root, "content", "rankings", "meta.json"),
        JSON.stringify({
          tiers: [{ name: "S", label: "Purpose-built", blurb: "Start here." }],
          sources: [{ label: "Operator page", url: "https://example.test/limits" }],
          disclaimer: "Benchmarks move; your own key is the only score that counts.",
          bottomLine: "Two providers cover daily volume.",
        }),
      );

      const result = await build({ root, outDir: out, now: NOW });

      expect(result.written).toHaveLength(6);
      expect(describeBuild(result)).toContain(result.manifest.revision);
      expect(result.directory).toBe(out);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to write a partial build when content is invalid", async () => {
    const root = mkdtempSync(join(tmpdir(), "cms-build-"));
    try {
      mkdirSync(join(root, "content", "providers"), { recursive: true });
      writeFileSync(
        join(root, "content", "providers", "alpha.json"),
        JSON.stringify({ id: "alpha" }),
      );

      await expect(build({ root, outDir: join(root, "dist"), now: NOW })).rejects.toBeInstanceOf(
        BuildFailedError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
