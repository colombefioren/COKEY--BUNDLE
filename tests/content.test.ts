import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentMissingError, loadContent, parseFrontMatter } from "../src/content.js";

/**
 * The reader's job is to hand every file on with the path it came from, so that
 * a problem can name the file an editor has to open. It validates nothing, and
 * these tests hold it to that split.
 */

const dirs: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cms-content-"));
  dirs.push(dir);
  mkdirSync(join(dir, "content", "providers"), { recursive: true });
  mkdirSync(join(dir, "content", "terms"), { recursive: true });
  mkdirSync(join(dir, "content", "rankings"), { recursive: true });
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("parseFrontMatter", () => {
  it("splits attributes from the body", () => {
    const parsed = parseFrontMatter("---\ntitle: Hello\norder: 3\n---\n\nBody.\n");
    expect(parsed.attributes).toEqual({ title: "Hello", order: "3" });
    expect(parsed.body).toBe("Body.");
  });

  it("keeps a colon inside a value", () => {
    const parsed = parseFrontMatter("---\ntitle: Keys: yours\norder: 1\n---\n\nx\n");
    expect(parsed.attributes.title).toBe("Keys: yours");
  });

  it("strips a matching pair of quotes so a value may start with a digit", () => {
    expect(parseFrontMatter('---\ntitle: "404 & you"\n---\n\nx\n').attributes.title).toBe(
      "404 & you",
    );
  });

  it("ignores comments inside the header", () => {
    const parsed = parseFrontMatter("---\n# a note\ntitle: T\n---\n\nx\n");
    expect(parsed.attributes).toEqual({ title: "T" });
  });

  it("normalises CRLF and a byte-order mark", () => {
    const parsed = parseFrontMatter("\uFEFF---\r\ntitle: T\r\n---\r\n\r\nBody.\r\n");
    expect(parsed.attributes.title).toBe("T");
    expect(parsed.body).toBe("Body.");
  });

  it("treats a file with no frontmatter as body-only", () => {
    const parsed = parseFrontMatter("Just prose.");
    expect(parsed.attributes).toEqual({});
    expect(parsed.body).toBe("Just prose.");
  });

  it("flags an unterminated header instead of guessing", () => {
    const parsed = parseFrontMatter("---\ntitle: T\n\nbody");
    expect(parsed.unterminated).toBe(true);
  });
});

describe("loadContent", () => {
  it("throws when there is no content directory at all", async () => {
    await expect(loadContent("/definitely/not/here")).rejects.toBeInstanceOf(ContentMissingError);
  });

  it("reads every surface, tagging each file with its relative path", async () => {
    const root = fixture();
    writeFileSync(join(root, "content", "providers", "groq.json"), JSON.stringify({ id: "groq" }));
    writeFileSync(join(root, "content", "terms", "one.md"), "---\ntitle: One\n---\n\nBody.\n");
    writeFileSync(join(root, "content", "rankings", "meta.json"), JSON.stringify({ tiers: [] }));

    const raw = await loadContent(root);

    expect(raw.providers).toHaveLength(1);
    expect(raw.providers[0]!.path).toBe("content/providers/groq.json");
    expect(raw.terms).toHaveLength(1);
    expect(raw.rankings.meta?.path).toBe("content/rankings/meta.json");
  });

  it("reads provider files in a stable order", async () => {
    const root = fixture();
    for (const id of ["zulu", "alpha", "mike"]) {
      writeFileSync(join(root, "content", "providers", `${id}.json`), JSON.stringify({ id }));
    }

    const raw = await loadContent(root);
    expect(raw.providers.map((file) => file.path)).toEqual([
      "content/providers/alpha.json",
      "content/providers/mike.json",
      "content/providers/zulu.json",
    ]);
  });

  it("leaves an absent optional board out rather than inventing an empty one", async () => {
    const root = fixture();
    writeFileSync(join(root, "content", "rankings", "meta.json"), JSON.stringify({ tiers: [] }));

    const raw = await loadContent(root);
    expect(raw.rankings.meta).toBeDefined();
    expect(raw.rankings["combined"]).toBeUndefined();
  });

  it("names the file when the JSON syntax is wrong", async () => {
    const root = fixture();
    writeFileSync(join(root, "content", "providers", "broken.json"), "{ nope");

    await expect(loadContent(root)).rejects.toThrow(/broken\.json/);
  });

  it("ignores files that are not part of the content model", async () => {
    const root = fixture();
    writeFileSync(join(root, "content", "providers", "notes.txt"), "scratch");
    writeFileSync(join(root, "content", "terms", "draft.md.bak"), "old");
    writeFileSync(
      join(root, "content", "providers", "alpha.json"),
      JSON.stringify({ id: "alpha" }),
    );

    const raw = await loadContent(root);
    expect(raw.providers.map((file) => file.path)).toEqual(["content/providers/alpha.json"]);
    expect(raw.terms).toEqual([]);
  });
});
