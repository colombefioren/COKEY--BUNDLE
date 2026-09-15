# cokey-bundle

**The published content bundle behind [COKEY](https://github.com/colombefioren/COKEY)'s
"check for updates" buttons.**

This repository used to hold the whole content catalog — provider dossiers, terms of service,
and the ranking boards — behind a schema, a build step and a preview server, fetched by COKEY
from a local checkout on disk. That turned out to be a lot of machinery for content that is
really just two things: the terms (which now live in COKEY itself, since terms shouldn't change
without a release anyway) and whatever genuinely drifts faster than a release cycle — currently
the ranking boards and the dashboard's Insights fun facts.

So this repository is now one file, and its name no longer says "rankings" because it no longer
only holds rankings.

## `content/rankings.json`

Skill, rate-limit, combined and redundancy boards, the drop list, their sources, and a list of
`funFacts` for the dashboard's Insights cards — one JSON object, no build step, no schema
tooling. Edit it directly and commit. The filename stays `rankings.json` even though the file
carries more than rankings now, since that's the path COKEY's default URL already points at and
renaming it would be a break for no benefit.

Its shape mirrors `RankingsView` in COKEY's own `src/catalog/rankings.ts`:

```json
{
  "tiers": [{ "name": "S", "label": "…", "labelFr": "…", "blurb": "…", "blurbFr": "…" }],
  "skill": [
    {
      "model": "…",
      "providerId": "…",
      "tierName": "S",
      "sweScore": 62.4,
      "reason": "…",
      "reasonFr": "…"
    }
  ],
  "rateLimit": [
    {
      "providerId": "…",
      "provider": "…",
      "tier": 1,
      "quota": "…",
      "provenance": "operator",
      "reliability": "solid",
      "note": "…",
      "noteFr": "…"
    }
  ],
  "combined": [{ "rank": 1, "providerId": "…", "model": "…", "tier": 1, "why": "…", "whyFr": "…" }],
  "redundancy": [{ "family": "…", "alsoOn": ["…"], "keep": "…", "fallback": "…" }],
  "dropList": [{ "provider": "…", "reason": "…", "reasonFr": "…" }],
  "bottomLine": "…",
  "bottomLineFr": "…",
  "disclaimer": "…",
  "disclaimerFr": "…",
  "sources": [{ "label": "…", "url": "https://…" }],
  "funFacts": ["…", "…"],
  "funFactsFr": ["…", "…"]
}
```

`tier` is `1 | 2 | 3 | 4` (1 = highest volume). `tierName` is `"S" | "A" | "B" | "C"`.
`provenance` is `"operator" | "third-party" | "unpublished"`. `reliability` is
`"solid" | "watch" | "avoid"`. `funFacts` is optional — a plain array of short strings, each
shown as one card in the dashboard's bottom-right Insights corner. Keep them short: they render
in a small card, not a paragraph.

Every `xFr` field is the French sibling of `x` and is entirely optional — the dashboard falls
back to the English field when a French one is missing, so a partial translation never breaks
anything. **Never translate a `model`, `providerId`, `provider`, `family`, `alsoOn`, `keep` or
`fallback` value** — those are identifiers the dashboard matches against its own catalog and
against the model/provider names typed into your chains; only the prose fields (`label`, `blurb`,
`reason`, `note`, `why`, `bottomLine`, `disclaimer`, `funFacts`) get a translation.

## Editing without touching raw JSON

`index.html` is a small, self-contained admin page for this repo — open it (locally, or wherever
it's deployed) and it loads `content/rankings.json` and lets every board, the drop list, the
bottom line and disclaimer, and the fun facts be edited as forms instead of JSON, English and
French side by side. It has no server of its own: there is nothing to build or run beyond opening
the page, and it never talks to anything except the two JSON files sitting next to it.

It sits behind a password (client-side only — a soft gate for a private repo, not a real access
boundary) so a shared link or an accidental public deploy isn't editable by anyone who has the
URL. To change the password, replace `ADMIN_HASH` near the top of `index.html`'s script with the
SHA-256 hex digest of the new one, e.g. `echo -n 'new-password' | shasum -a 256`.

It also reads `content/catalog-snapshot.json` — a list of every provider id and the models
COKEY currently knows it serves — to power the provider/model suggestions and to warn when a
ranking entry names a provider id that snapshot doesn't recognize. That file is generated
*from COKEY*, not from here: whenever a provider or model changes there, run
`npm run export:catalog` in the COKEY repo and commit its output as this repo's
`content/catalog-snapshot.json`. It's advisory only — the page still lets you save without it and
still warns rather than blocks — but keeping it current is what makes the exact class of bug this
tool exists to prevent (a ranking entry outliving the model it names) visible while you're
editing, not after you've already published.

## Publishing an update

1. Open `index.html`, edit the boards and fun facts, and download or copy the resulting
   `rankings.json` — or edit `content/rankings.json` directly, whichever is easier for the change.
2. Commit `content/rankings.json` (and `content/catalog-snapshot.json`, if it changed) on `main`
   and push.
3. In COKEY, open **Models → Rankings** and click **check for updates** — this refreshes both the
   ranking boards and the `funFacts` list from the same fetch.

COKEY fetches `https://raw.githubusercontent.com/colombefioren/COKEY--BUNDLE/main/content/rankings.json`
by default (overridable with `COKEY_RANKINGS_URL`), validates it, and replaces the boards and
fun facts it is serving — only when that button is clicked, never automatically. A malformed
file is refused with the specific reason and changes nothing; the content already being served
keeps being served.

## Provider dossiers and terms

These now live directly in the COKEY repository — `src/catalog/dossiers.ts`, `src/catalog/models.ts`
and `src/web/pages/Terms.tsx` — and are corrected there with a normal pull request.
