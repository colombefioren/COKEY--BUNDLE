import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reading the content directory.
 *
 * This layer deliberately does no validation at all. It reads bytes, parses
 * JSON and splits frontmatter, and hands everything on tagged with the file it
 * came from — because the only thing worse than a schema error is a schema
 * error that does not say which file to open.
 *
 * Validation lives in `validate.ts`, and it is the caller's job to run it.
 */

/** The repository root, found relative to this module. */
export function defaultRoot(): string {
  // src/content.ts -> src -> repository root
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export interface RawFile<T> {
  /** Path relative to the repository root, for error messages. */
  path: string;
  /** Absolute path, for a reader who wants to open it. */
  absolute: string;
  data: T;
}

export interface RawText {
  path: string;
  absolute: string;
  text: string;
}

export interface RawContent {
  root: string;
  providers: Array<RawFile<unknown>>;
  terms: RawText[];
  rankings: Record<string, RawFile<unknown>>;
}

/** The ranking board files, and the key each one is exposed under. */
export const RANKING_FILES = {
  meta: "meta.json",
  skill: "skill.json",
  "rate-limits": "rate-limits.json",
  combined: "combined.json",
  redundancy: "redundancy.json",
  "drop-list": "drop-list.json",
} as const;

export type RankingFileKey = keyof typeof RANKING_FILES;

export class ContentMissingError extends Error {
  constructor(readonly directory: string) {
    super(`Content directory not found: ${directory}`);
    this.name = "ContentMissingError";
  }
}

/**
 * Read the whole content tree.
 *
 * Missing *optional* files are tolerated and reported as an absent key so the
 * validator can decide whether their absence is an error. A missing content
 * directory is fatal: every later message would be noise.
 */
export async function loadContent(root = defaultRoot()): Promise<RawContent> {
  const contentDir = join(root, "content");
  if (!existsSync(contentDir)) throw new ContentMissingError(contentDir);

  return {
    root,
    providers: await readJsonDirectory(join(contentDir, "providers"), root),
    terms: await readTextDirectory(join(contentDir, "terms"), root),
    rankings: await readRankings(join(contentDir, "rankings"), root),
  };
}

async function readJsonDirectory(directory: string, root: string): Promise<Array<RawFile<unknown>>> {
  if (!existsSync(directory)) return [];
  const names = await jsonFiles(directory);
  const out: Array<RawFile<unknown>> = [];
  for (const name of names) {
    const absolute = join(directory, name);
    out.push({
      path: relative(root, absolute),
      absolute,
      data: await readJson(absolute),
    });
  }
  return out;
}

async function readTextDirectory(directory: string, root: string): Promise<RawText[]> {
  if (!existsSync(directory)) return [];
  const names = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
  const out: RawText[] = [];
  for (const name of names) {
    const absolute = join(directory, name);
    out.push({ path: relative(root, absolute), absolute, text: await readFile(absolute, "utf8") });
  }
  return out;
}

async function readRankings(
  directory: string,
  root: string,
): Promise<Record<string, RawFile<unknown>>> {
  const out: Record<string, RawFile<unknown>> = {};
  for (const [key, name] of Object.entries(RANKING_FILES)) {
    const absolute = join(directory, name);
    if (!existsSync(absolute)) continue;
    out[key] = { path: relative(root, absolute), absolute, data: await readJson(absolute) };
  }
  return out;
}

async function jsonFiles(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  return names.filter((name) => name.endsWith(".json")).sort();
}

/** Parse a JSON file, naming the file when the syntax is wrong. */
export async function readJson(absolute: string): Promise<unknown> {
  const text = await readFile(absolute, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${absolute}: invalid JSON — ${(error as Error).message}`);
  }
}

function relative(root: string, absolute: string): string {
  return absolute.startsWith(root + "/") ? absolute.slice(root.length + 1) : absolute;
}

/* -------------------------------------------------------------------------- *
 * Terms frontmatter
 * -------------------------------------------------------------------------- */

export interface FrontMatter {
  attributes: Record<string, string>;
  body: string;
  /** Set when the file opens with `---` but never closes it. */
  unterminated?: boolean;
}

/**
 * Split a Markdown file into its frontmatter and its body.
 *
 * A deliberately tiny YAML subset — `key: value` lines, optionally quoted —
 * because the frontmatter carries three scalars and pulling in a YAML parser to
 * read `order: 3` would be more dependency than content. Anything richer
 * belongs in the body, where Markdown already handles it.
 *
 * A file with no frontmatter is not an error here: it parses to an empty
 * attribute set, and the validator reports the missing fields with the file's
 * name attached.
 */
export function parseFrontMatter(text: string): FrontMatter {
  const normalised = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) {
    return { attributes: {}, body: normalised.trim() };
  }

  const end = normalised.indexOf("\n---", 3);
  if (end === -1) {
    return { attributes: {}, body: normalised.trim(), unterminated: true };
  }

  const header = normalised.slice(4, end);
  const body = normalised.slice(end + 4).replace(/^\n+/, "").trimEnd();

  const attributes: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    // Strip a matching pair of quotes so a value can start with a digit.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    attributes[key] = value;
  }

  return { attributes, body };
}
