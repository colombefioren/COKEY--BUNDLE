# cokey-cms

**The published ranking bundle behind [COKEY](https://github.com/colombefioren/COKEY)'s
"check for updates" button.**

This repository used to hold the whole content catalog — provider dossiers, terms of service,
and the ranking boards — behind a schema, a build step and a preview server, fetched by COKEY
from a local checkout on disk. That turned out to be a lot of machinery for content that is
really just two things: the terms (which now live in COKEY itself, since terms shouldn't change
without a release anyway) and the rankings (which genuinely drift faster than a release cycle).

So this repository is now one file.

## `content/rankings.json`

Skill, rate-limit, combined and redundancy boards, the drop list, and their sources — one JSON
object, no build step, no schema tooling. Edit it directly and commit.

Its shape mirrors `RankingsView` in COKEY's own `src/catalog/rankings.ts`:

```json
{
  "tiers": [{ "name": "S", "label": "…", "blurb": "…" }],
  "skill": [{ "model": "…", "providerId": "…", "tierName": "S", "sweScore": 62.4, "reason": "…" }],
  "rateLimit": [
    {
      "providerId": "…",
      "provider": "…",
      "tier": 1,
      "quota": "…",
      "provenance": "operator",
      "reliability": "solid"
    }
  ],
  "combined": [{ "rank": 1, "providerId": "…", "model": "…", "tier": 1, "why": "…" }],
  "redundancy": [{ "family": "…", "alsoOn": ["…"], "keep": "…", "fallback": "…" }],
  "dropList": [{ "provider": "…", "reason": "…" }],
  "bottomLine": "…",
  "disclaimer": "…",
  "sources": [{ "label": "…", "url": "https://…" }]
}
```

`tier` is `1 | 2 | 3 | 4` (1 = highest volume). `tierName` is `"S" | "A" | "B" | "C"`.
`provenance` is `"operator" | "third-party" | "unpublished"`. `reliability` is
`"solid" | "watch" | "avoid"`.

## Publishing an update

1. Edit `content/rankings.json` on `main`.
2. Commit and push.
3. In COKEY, open **Models → Rankings** and click **check for updates**.

COKEY fetches `https://raw.githubusercontent.com/colombefioren/COKEY--CMS/main/content/rankings.json`
by default (overridable with `COKEY_RANKINGS_URL`), validates it, and replaces the boards it is
serving — only when that button is clicked, never automatically. A malformed file is refused with
the specific reason and changes nothing; the boards already being served keep being served.

## Provider dossiers and terms

These now live directly in the COKEY repository — `src/catalog/dossiers.ts`, `src/catalog/models.ts`
and `src/web/pages/Terms.tsx` — and are corrected there with a normal pull request.
