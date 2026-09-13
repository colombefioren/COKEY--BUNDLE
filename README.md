# cokey-cms

**The content repository behind COKEY's catalog.** Provider dossiers, free-tier
notes, terms of service, ranking boards and the review dates that make all of it
auditable — as plain files, in one versioned place, with a schema and a build.

This repository holds **no application code and no secrets**. It holds the things
that are true about other people's services, which change constantly and which
should never be buried in a 1,200-line TypeScript file.

---

## Why this is a separate repository

The provider catalog started life inside COKEY as a data structure in
`src/catalog/providers.ts`. That was the right call while it was being written,
and the wrong one afterwards, for three reasons:

1. **It changes on a different schedule.** A model is retired on a Tuesday
   afternoon; a COKEY release is not. Content and code should not share a
   release train.
2. **It is prose.** A verdict reason ("this is one free pool re-exported under
   six names") is a paragraph someone has to be able to read and edit. A
   TypeScript string literal in a nested object is not that.
3. **It needs a review trail.** Every claim about a free tier has a date and a
   source. In its own repository, that is `git log` and `git blame` on one file,
   instead of archaeology through an application's history.

The practical effect: correcting a provider's quota takes one pull request that
touches one JSON file, and COKEY picks it up by fetching a build.

---

## The content model

```
content/
├── providers/<id>.json      one file per provider: identity, verdict, free tier, models
├── terms/<slug>.md          one file per terms section, with frontmatter
└── rankings/<board>.json    the skill, rate-limit, combined and redundancy boards
```

### Providers

One file per provider, named after its id. That is the whole design decision:
one file means a diff about Groq contains only Groq, and a reviewer can see the
change without scrolling past forty other services.

```json
{
  "id": "groq",
  "displayName": "Groq",
  "operator": "Groq, Inc.",
  "origin": "United States",
  "kind": "inference-cloud",
  "summary": "Custom silicon serving open models at very high speed.",
  "verdict": "recommended",
  "verdictReason": "Lowest measured latency of any free tier in the catalog.",
  "sourceUrl": "https://console.groq.com/docs/rate-limits",
  "reviewedAt": "2026-09-13",
  "baseUrl": "https://api.groq.com/openai/v1",
  "apiStyle": "openai",
  "authScheme": "bearer",
  "signupUrl": "https://console.groq.com/keys",
  "freeTier": {
    "advertised": true,
    "summary": "Free tier with daily limits",
    "quotaSource": "provider"
  },
  "models": [
    { "id": "qwen/qwen3.8-27b", "context": "262K", "bestFor": "Code", "latencySeconds": 0.3 }
  ]
}
```

`kind` and `verdict` are closed sets, enforced by the schema:

| `kind`            | meaning                                        |
| :---------------- | :--------------------------------------------- |
| `lab`             | the organisation that trains the models        |
| `inference-cloud` | runs other people's models on its own hardware |
| `aggregator`      | routes to many upstreams behind one key        |
| `gateway`         | a curated resale of a pool                     |
| `local`           | runs on the user's own machine                 |

| `verdict`     | meaning                              |
| :------------ | :----------------------------------- |
| `recommended` | fine to depend on                    |
| `usable`      | works, with caveats                  |
| `limited`     | works, but will not carry a workload |
| `avoid`       | should not be built on               |

A `verdict` is an opinion, and `verdictReason` is the argument for it. Both are
required: a verdict nobody can argue with is not useful to a reader.

### Terms

Markdown with frontmatter, one section per file, ordered by `order`:

```markdown
---
title: Your keys stay yours
order: 3
updatedAt: 2026-09-13
---

COKEY stores your credentials encrypted with AES-256-GCM...
```

Markdown rather than JSON because these are the only long-form prose in the
repository, and the difference between editing a paragraph in a `md` file and in
an escaped JSON string is the difference between the terms being maintained and
the terms going stale.

### Rankings

Four boards plus a meta file. Each entry cites where the claim came from, because
a ranking with no provenance is a rumour:

```json
{
  "entries": [
    { "rank": 1, "providerId": "groq", "model": "qwen/qwen3.8-27b", "why": "...", "tier": 1 }
  ]
}
```

`meta.json` carries the sources, the disclaimer and the bottom line that frames
every board.

---

`npm run stats` and `npm run validate` are the editorial tools: the first lists
the files whose review has gone stale and the ones advertising a free tier
without a source, the second names the file and field of every problem. Warnings
are the work queue, not noise — twenty of them mean twenty claims nobody has
checked against the operator's own page yet.

---

## Commands

```bash
npm install

npm run validate     # schema + cross-references, with file and field names in the errors
npm run build        # emit dist/ — one JSON bundle per surface, plus a revision hash
npm run list         # every provider, one line each
npm run show groq    # one provider, rendered for a terminal
npm run stats        # counts, verdict spread, which files are overdue for review
npm run serve        # preview API on http://127.0.0.1:8790
npm test
npm run typecheck
```

### The build

`npm run build` writes:

```
dist/
├── index.json        the manifest: counts, revision hash, build time
├── providers.json    every provider, keyed by id
├── dossiers.json     just the opinion half, keyed by id
├── models.json       models grouped by provider
├── terms.json        sections in order
└── rankings.json     all four boards plus their meta
```

`index.json` carries a `revision` — a SHA-256 over the normalised content. A
consumer can compare one short string to know whether anything changed, which is
what makes this cheap to poll.

### The preview API

`npm run serve` starts a dependency-free HTTP server over the content, so a UI
can be developed against real shapes before anything is published:

```
GET /api/index
GET /api/providers
GET /api/providers/:id
GET /api/models
GET /api/terms
GET /api/rankings
GET /health
```

---

## Consuming this from COKEY

COKEY reads the `content/` directory directly, at runtime, and **watches it**. The
practical effect is the one worth having: edit `content/providers/groq.json`,
save, and the open dashboard shows the new verdict — no rebuild, no restart, no
fetch from anywhere.

It looks for a checkout in three places, in order:

1. `COKEY_CMS_DIR`, if set;
2. `./cms/content`, relative to the COKEY working directory;
3. `../cokey-cms/content`, a checkout cloned beside it.

```bash
# in the COKEY repository
COKEY_CMS_DIR=../cokey-cms/content npm start
```

There is no network call and no phone-home: a gateway that fetched its own
catalog from a server on boot would break the one promise this project makes
about the network. If no checkout is present, COKEY serves the catalog compiled
into the build, so a fresh clone is useful with zero setup.

The overlay is **field by field**, not file by file. Content wins where it
speaks and COKEY's compiled catalog fills every gap, so a dossier that only
states a verdict still gets its operator, summary and source URL from the build.
A half-written file improves the dashboard rather than breaking it.

What COKEY exposes from here:

| Endpoint                         | Serves                                                                       |
| :------------------------------- | :--------------------------------------------------------------------------- |
| `GET /api/content/status`        | the directory being watched, its counts, and every file that failed to parse |
| `GET /api/content/terms`         | the terms document, in `order`                                               |
| `POST /api/content/reload`       | a forced re-read, for mounts a watcher cannot see                            |
| `GET /api/content/providers/:id` | one dossier, tagged with `source: "cms"` or `"compiled"`                     |
| `GET /api/catalog/providers`     | the catalog with the curated dossiers merged in                              |
| `GET /api/catalog/rankings`      | the curated boards, with their sources and disclaimer                        |

A reload that changes nothing observable is reported as _nothing changed_
rather than announced as a success, because a dashboard that claims to have
reloaded when it did not is worse than one that says nothing.

---

## Editorial rules

These are not style preferences. Each one exists because its absence caused a
wrong entry:

1. **Cite the source.** Every claim about a quota or a rate limit carries a
   `sourceUrl` pointing at the operator's own documentation, not a blog post. If
   no operator page states it, the answer is `quotaSource: "unknown"` — and
   COKEY will render "Quota: Unknown" rather than guess.
2. **Free means free.** A model belongs in `models` only while the provider
   serves it without payment. Trial credit is not a free tier.
3. **Date every review.** `reviewedAt` is required. `npm run stats` lists the
   files whose review has gone stale, because a catalog is a perishable good.
4. **One provider per file, one claim per field.** Keep the diff reviewable.
5. **Say the awkward thing.** If six providers are the same upstream pool,
   `verdictReason` says so. A catalog that flatters everyone helps nobody.

## License

MIT. See [LICENSE](LICENSE).
