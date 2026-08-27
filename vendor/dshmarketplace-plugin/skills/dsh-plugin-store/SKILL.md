---
name: dsh-plugin-store
description: Find and install DeepSeek Harness (DSH) plugins. Use when the user asks for a plugin, asks how to add a capability to DSH, or wants to know what plugins exist for something — memory, vision, terminal UI, notifications, model providers.
---

# Finding DSH plugins

Never recall a plugin from memory. The DSH ecosystem is days old and moves
faster than any training data; a name you remember is as likely to be wrong as
right. Search the catalogue.

## Search first

Call `dshmarketplace_search` with a **capability**, not a product name.
"memory", "vision", "terminal ui", "usage tracking" all work; a half-remembered
repository name usually does not.

## Reading a result

Rank on these, in order:

1. `inRegistry` — the plugin passed the community review that DSH's own plugin
   market installs from. This is the strongest signal available.
2. `pushedAt` — the DSH ecosystem is young. A plugin untouched for weeks may
   already target an older harness.
3. `license` — no licence means all rights reserved by default, whatever the
   README implies.
4. `stars` — last, and with suspicion. Large repositories often earned their
   stars for something other than their DSH plugin.

## Before installing

`riskFlags` says what the plugin reaches:

- `install script` — code runs at install time, before anyone reads anything
- `terminal surface` — the plugin executes shell commands
- `requires credentials` — the plugin asks for an API key or token

**Tell the user what a flagged plugin reaches, in plain language, and get an
explicit yes before calling `dshmarketplace_install`.** An empty `riskFlags` is
not a clean bill of health — detection is heuristic and reads only what the
repository publishes.

A listing is not a security review. Plugins run with this agent's permissions.

## Installing

Call `dshmarketplace_install` with the exact `fullName` from a search result.
Do not construct install commands by hand — the catalogue already resolves npm
over a full clone where it can, and monorepo subpaths are easy to get wrong.

Full write-up for any plugin is at the `url` on each result.
