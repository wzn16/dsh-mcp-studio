# Changelog

## 1.0.2 — 2026-11-16

- README rewritten around a first screen that answers "what is this" on its own: an SVG hero carrying
  the real state panel, then the console screenshot as proof, then the mechanism diagram.
- New README diagrams: `assets/readme/hero.svg` and `assets/readme/flow.svg` (hand-written SVG, system
  fonts, no remote assets).
- All four surfaces now shown as a thumbnail row instead of separate sections; install path leads with
  the in-app route before any command.
- Chinese README mirrors the same structure.

## 1.0.1 — 2026-11-16

- Fixed: the plugin showed no icon in the plugin list. `package.json` now declares a top-level
  `"icon"` (the field other third-party plugins use), and `icon.svg` uses explicit colours instead of
  `currentColor`, which disappeared against the dark theme.
- README: added screenshots of all four surfaces (English and Chinese).

## 1.0.0 — 2026-11-16

First public release.

- **Console** (main panel): two-column workbench with live status stream, detail pane, expandable
  tool list (on-demand probe), add/edit drawer with pre-write validation, delete confirmation.
- **Popover** (session header chip): read-only counts and per-server state, inline probe/restart,
  "open console" entry.
- **Settings page**: single-column card layout, plus the entry switches.
- **Bundle row**: one-line summary in the plugin's own settings page.
- Entry switches persisted per browser profile (`localStorage` key `dsh-mcp-console:prefs`).
- Probe, restart, enable/disable, add, edit, delete through the official `mcp-manager` remote
  methods and config form (revision-fenced atomic mutate).
- Read-only handling for servers contributed by other plugins (`configured: false`).
- Chinese UI; DSH `>=0.2.2-rc.2 <0.3.0-0`.

### Fixed before release

- Preserve unknown/long-lived entry fields (`reconnect`, `closeTimeoutMs`, future host fields) when
  saving from the drawer.
- Removing `enabled: false` when a server is re-enabled (previously the field survived, so the
  server looked enabled but stayed off).
- Mask tokens in URL query strings before rendering config summaries.
- Reject timeout values the host would refuse (non-integer, `0`, above one hour) in the form.
- Report malformed `KEY=VALUE` / `Key: Value` lines instead of silently dropping them.
- Watch stream: recycle the handle in `finally`, reconnect with exponential backoff, ignore
  unparseable frames instead of blanking the list.
- Slot mounting is diff-based, so toggling an entry no longer resets the console's selection,
  search text, or drawer draft.
- Row keyboard handler no longer hijacks Enter inside the row's own action buttons.
- Drawer got `role="dialog"`, Escape to close, and initial focus.
- Toast is a live region; error text also shows in the popover.
- Contrast: secondary labels, warn/busy dot colours, and card surfaces now meet AA on both themes.
- Touch targets raised to 30 px; row actions are always visible without hover.
- "Open console" now hard-declares the `layout` service in `inject` — without it the call was
  silently undefined and the button appeared dead.
