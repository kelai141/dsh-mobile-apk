# Plugin Mount Entry Removal Scope

## Problem

PluginMounts.removeEntry matched name and id text across nested configuration data. A product entry could therefore be altered when a nested config field or list item happened to use the same value as the plugin being removed. When removal matched both an entry ID and its name, processing both line hits after the first deletion could also shift the second hit onto a following sibling.

## Change

- Restrict identity matches to the direct entry header and its mapping keys, excluding nested config values and list items.
- Map all identity matches to their owning entry and deduplicate those entry starts before deleting in reverse order.
- Preserve matching for entries whose first key is name, and for top-level entries.
- Add regression coverage for nested scalar and list fields, name-first entries, and duplicate ID/name hits with a following sibling.

## Verification

- PluginMountsTest, SafeModeInsertBoundaryTest, and SafeModeTest passed.
- node scripts/check-code-map.mjs passed.
- git diff --check passed.
- Device validation was not performed.
