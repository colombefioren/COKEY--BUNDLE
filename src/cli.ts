#!/usr/bin/env node
/**
 * The content CLI.
 *
 * Six verbs, all of which exist to answer a question an editor actually has:
 *
 *   validate   is this content correct?
 *   build      what does a consumer receive?
 *   list       what is in the catalog?
 *   show       what do we say about this one provider?
 *   stats      what is out of date?
 *   serve      what does a UI see?
 *
 * Written with a hand-rolled argument reader rather than a CLI framework: the
 * whole surface is six commands and three flags, and `cac` would be more code
 * configured than parsed.
 */

import { BuildFailedError, build, describeBuild } from "./build.js";
import { defaultRoot } from "./content.js";
import { daysSince, validateContent, DEFAULT_STALE_AFTER_DAYS, type Issue } from "./validate.js";
import { loadContent } from "./content.js";
import { startContentServer } from "./server.js";
import type { Provider } from "./schema.js";

const USAGE = `cokey-cms — content for the COKEY catalog

Usage
  cokey-cms validate [--root <dir>] [--strict]
  cokey-cms build    [--root <dir>] [--out <dir>]
  cokey-cms list     [--root <dir>] [--verdict <v>]
  cokey-cms show     <provider-id> [--root <dir>]
  cokey-cms stats    [--root <dir>]
  cokey-cms serve    [--root <dir>] [--port <n>] [--host <h>]

Flags
  --root <dir>     repository root to read (default: this repository)
  --out <dir>      build output directory (default: <root>/dist)
  --verdict <v>    filter list by recommended | usable | limited | avoid
  --strict         treat warnings as errors
  --port <n>       preview server port (default 8790)
  --host <h>       preview server host (default 127.0.0.1)
  --no-color       plain output
`;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey!;

    // Boolean flags, so `--strict` does not swallow the next argument.
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    if (key === "strict" || key === "no-color" || key === "help") {
      flags[key] = true;
      continue;
    }
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { command, positional, flags };
}

/* -------------------------------------------------------------------------- *
 * Output helpers
 * -------------------------------------------------------------------------- */

const useColor = (): boolean => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(text: string, code: string): string {
  return useColor() ? `\u001b[${code}m${text}\u001b[0m` : text;
}

const red = (text: string): string => paint(text, "31");
const yellow = (text: string): string => paint(text, "33");
const green = (text: string): string => paint(text, "32");
const dim = (text: string): string => paint(text, "2");
const bold = (text: string): string => paint(text, "1");

/** Pad to a width, ignoring the invisible ANSI codes already in the string. */
function pad(text: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = text.replace(/\u001b\[[0-9;]*m/g, "").length;
  return text + " ".repeat(Math.max(0, width - visible));
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

/* -------------------------------------------------------------------------- *
 * Commands
 * -------------------------------------------------------------------------- */

async function commandValidate(args: ParsedArgs): Promise<number> {
  const root = stringFlag(args.flags, "root") ?? defaultRoot();
  const strict = args.flags.strict === true;

  const raw = await loadContent(root);
  const report = validateContent(raw);

  printIssues(report.issues);

  const failures = strict ? report.errors + report.warnings : report.errors;

  if (failures > 0) {
    console.log(
      `\n${red("✗")} ${report.errors} error(s), ${report.warnings} warning(s)` +
        (strict ? dim(" (strict: warnings fail too)") : ""),
    );
    return 1;
  }

  console.log(
    `${green("✓")} ${report.counts.providers} providers · ${report.counts.models} models · ` +
      `${report.counts.terms} terms sections · ${report.counts.rankable} ranked entries` +
      (report.warnings ? dim(` · ${report.warnings} warning(s)`) : ""),
  );
  return 0;
}

function printIssues(issues: Issue[]): void {
  for (const issue of issues) {
    const marker = issue.severity === "error" ? red("error") : yellow("warn ");
    const where = issue.field ? `${issue.file}:${issue.field}` : issue.file;
    console.log(`${marker} ${bold(where)} ${issue.message}`);
  }
}

async function commandBuild(args: ParsedArgs): Promise<number> {
  const root = stringFlag(args.flags, "root") ?? defaultRoot();
  const outDir = stringFlag(args.flags, "out");

  try {
    const result = await build({ root, outDir });
    console.log(`${green("✓")} ${describeBuild(result)}`);
    return 0;
  } catch (error) {
    if (error instanceof BuildFailedError) {
      printIssues(error.report.issues);
      console.error(`\n${red("✗")} ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function commandList(args: ParsedArgs): Promise<number> {
  const root = stringFlag(args.flags, "root") ?? defaultRoot();
  const verdict = stringFlag(args.flags, "verdict");

  const raw = await loadContent(root);
  const report = validateContent(raw);
  if (!report.content) {
    printIssues(report.issues);
    return 1;
  }

  const rows = report.content.providers
    .filter((provider) => !verdict || provider.verdict === verdict)
    .map((provider) => ({
      id: provider.id,
      name: provider.displayName,
      verdict: provider.verdict,
      kind: provider.kind,
      models: String(provider.models.length),
      free: provider.freeTier.advertised ? "free" : "—",
    }));

  if (rows.length === 0) {
    console.log(`No providers${verdict ? ` with verdict "${verdict}"` : ""}.`);
    return 0;
  }

  const widths = {
    id: Math.max(...rows.map((row) => row.id.length), 2),
    name: Math.max(...rows.map((row) => row.name.length), 4),
    kind: Math.max(...rows.map((row) => row.kind.length), 4),
  };

  console.log(
    dim(
      `${pad("ID", widths.id)}  ${pad("NAME", widths.name)}  ${pad("VERDICT", 11)}  ${pad("KIND", widths.kind)}  MODELS`,
    ),
  );
  for (const row of rows) {
    const tally = row.verdict === "recommended" ? green(row.verdict) : row.verdict;
    console.log(
      `${pad(row.id, widths.id)}  ${pad(row.name, widths.name)}  ${pad(tally, 11)}  ` +
        `${pad(row.kind, widths.kind)}  ${pad(row.models, 6)} ${row.free}`,
    );
  }
  console.log(dim(`\n${rows.length} provider(s)`));
  return 0;
}

async function commandShow(args: ParsedArgs): Promise<number> {
  const id = args.positional[0];
  if (!id) {
    console.error("show needs a provider id, for example: cokey-cms show groq");
    return 2;
  }

  const root = stringFlag(args.flags, "root") ?? defaultRoot();
  const raw = await loadContent(root);
  const report = validateContent(raw);
  if (!report.content) {
    printIssues(report.issues);
    return 1;
  }

  const provider = report.content.providers.find((entry) => entry.id === id);
  if (!provider) {
    console.error(`No provider "${id}". Try: cokey-cms list`);
    return 1;
  }

  printProvider(provider);
  return 0;
}

function printProvider(provider: Provider): void {
  console.log(`${bold(provider.displayName)} ${dim(`(${provider.id})`)}`);
  console.log(`${provider.summary}\n`);
  console.log(`${pad("Operator", 12)} ${provider.operator}`);
  console.log(`${pad("Origin", 12)} ${provider.origin}`);
  console.log(`${pad("Kind", 12)} ${provider.kind}`);
  console.log(`${pad("Verdict", 12)} ${provider.verdict}`);
  console.log(`${pad("Why", 12)} ${provider.verdictReason}`);
  console.log(
    `${pad("Free tier", 12)} ${provider.freeTier.summary} (${provider.freeTier.quotaSource})`,
  );
  console.log(`${pad("Reviewed", 12)} ${provider.reviewedAt}`);
  console.log(
    `${pad("Endpoint", 12)} ${provider.baseUrl} · ${provider.apiStyle} · ${provider.authScheme}`,
  );
  if (provider.signupUrl) console.log(`${pad("Signup", 12)} ${provider.signupUrl}`);
  if (provider.sourceUrl) console.log(`${pad("Source", 12)} ${provider.sourceUrl}`);
  if (provider.notes) console.log(`${pad("Notes", 12)} ${provider.notes}`);

  console.log(`\n${bold(`Models (${provider.models.length})`)}`);
  for (const model of provider.models) {
    const meta = [
      model.context ? `${model.context} ctx` : "",
      model.bestFor ?? "",
      model.latencySeconds !== undefined ? `${model.latencySeconds}s` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    console.log(`  ${pad(model.id, 46)} ${dim(meta)}`);
  }
}

async function commandStats(args: ParsedArgs): Promise<number> {
  const root = stringFlag(args.flags, "root") ?? defaultRoot();
  const now = new Date();

  const raw = await loadContent(root);
  const report = validateContent(raw, { now });
  if (!report.content) {
    printIssues(report.issues);
    return 1;
  }

  const { providers, terms, rankings } = report.content;
  const models = providers.reduce((sum, provider) => sum + provider.models.length, 0);
  const kindCounts = tally(providers, (provider) => provider.kind);
  const verdictCounts = tally(providers, (provider) => provider.verdict);

  console.log(bold("cokey-cms content\n"));
  console.log(`${pad("Providers", 16)} ${providers.length}`);
  console.log(`${pad("Models", 16)} ${models}`);
  console.log(`${pad("Terms sections", 16)} ${terms.length}`);
  console.log(
    `${pad("Ranked entries", 16)} ${
      rankings.skill.length +
      rankings.rateLimits.length +
      rankings.combined.length +
      rankings.redundancy.length +
      rankings.dropList.length
    }`,
  );
  console.log(`${pad("Warnings", 16)} ${report.warnings}`);

  console.log(`\n${bold("By verdict")}`);
  for (const [verdict, count] of Object.entries(verdictCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(verdict, 14)} ${count}`);
  }

  console.log(`\n${bold("By kind")}`);
  for (const [kind, count] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(kind, 18)} ${count}`);
  }

  /*
   * The list this command exists for. A catalog is a perishable good: a review
   * date is the only thing that tells an editor which entries to re-read, and
   * nothing else in the repository surfaces it.
   */
  const overdue = providers
    .map((provider) => ({
      id: provider.id,
      age: daysSince(provider.reviewedAt, now) ?? Number.POSITIVE_INFINITY,
      reviewedAt: provider.reviewedAt,
    }))
    .filter((entry) => entry.age > DEFAULT_STALE_AFTER_DAYS)
    .sort((a, b) => b.age - a.age);

  console.log(`\n${bold(`Overdue for review (> ${DEFAULT_STALE_AFTER_DAYS} days)`)}`);
  if (overdue.length === 0) {
    console.log(`  ${green("none")} — every entry has been reviewed recently`);
  } else {
    for (const entry of overdue) {
      console.log(`  ${pad(entry.id, 24)} ${entry.age}d ${dim(`(reviewed ${entry.reviewedAt})`)}`);
    }
  }

  const freeProviders = providers.filter((provider) => provider.freeTier.advertised);
  const undocumented = freeProviders.filter(
    (provider) => provider.freeTier.quotaSource === "unknown",
  );
  if (undocumented.length > 0) {
    console.log(`\n${bold("Advertised free but quota unsourced")}`);
    for (const provider of undocumented) {
      console.log(`  ${yellow(provider.id)}`);
    }
  }

  return 0;
}

function tally<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const name = key(item);
    out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}

async function commandServe(args: ParsedArgs): Promise<number> {
  const root = stringFlag(args.flags, "root") ?? defaultRoot();
  const port = Number(stringFlag(args.flags, "port") ?? 8790);
  const host = stringFlag(args.flags, "host") ?? "127.0.0.1";

  const started = await startContentServer({ root, port, host });
  console.log(`${green("✓")} cokey-cms preview listening on ${bold(started.url)}`);
  console.log(
    dim(
      [
        "  /api/index",
        "  /api/providers",
        "  /api/providers/:id",
        "  /api/models",
        "  /api/terms",
        "  /api/rankings",
      ].join("\n"),
    ),
  );
  console.log(dim("\nContent is re-read on every request. Ctrl-C to stop."));

  // Hold the process open; the server's own handles keep it alive, but awaiting
  // a never-resolving promise makes Ctrl-C the only way out, which is intended.
  await new Promise<void>((resolvePromise) => {
    process.on("SIGINT", () => {
      void started.close().then(() => resolvePromise());
    });
    process.on("SIGTERM", () => {
      void started.close().then(() => resolvePromise());
    });
  });
  return 0;
}

/* -------------------------------------------------------------------------- *
 * Entry point
 * -------------------------------------------------------------------------- */

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  switch (args.command) {
    case "validate":
      return commandValidate(args);
    case "build":
      return commandBuild(args);
    case "list":
      return commandList(args);
    case "show":
      return commandShow(args);
    case "stats":
      return commandStats(args);
    case "serve":
      return commandServe(args);
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command "${args.command}".\n`);
      console.log(USAGE);
      return 2;
  }
}

// Only run when executed directly, so tests can import `parseArgs` and `main`.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
