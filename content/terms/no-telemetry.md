---
title: No monitoring, no telemetry
order: 6
updatedAt: 2026-09-13
---

COKEY has **no analytics, no phone-home, and no server component you did not
start yourself**.

Everything is stored in a local SQLite database under your data directory. Your
keys, your prompts, your request history and your provider catalog live on your
disk and nowhere else.

The dashboard's own fonts and icons are served from the gateway rather than a
CDN, for the same reason: rendering a page should not tell a third party that
you opened it.

If you join a community to ask a question, you choose what to share.
