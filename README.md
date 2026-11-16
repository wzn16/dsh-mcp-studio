# dsh-mcp-console

MCP server console for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
see every MCP server's **live connection state**, **probe** it, **restart** it, and **edit its
configuration in place** — without hand-editing `cordis.patch.yml` and without restarting the app.

The official `mcp-manager` plugin owns the data and exposes remote methods (`watch` / `probe` /
`restart`) plus a settings form, but ships **no UI** for them. This plugin is that UI. It reads and
writes through the official channels, so your comments and the rest of your config file stay intact.

## Why this exists

Before this plugin, answering "did my MCP server actually connect?" meant grepping YAML and reading
agent logs. Worse, the community plugins that do try to show MCP servers parse `cordis.patch.yml`
themselves, so they drift from what the host actually loaded.

Here the state comes from the host's own runtime stream, and every write goes through the official
config form (revision-fenced atomic mutate). No YAML parsing, no shadow copy of your config.

## Quick start

Ask your DSH agent to install it:

> Install the plugin at `/path/to/dsh-mcp-console` into my profile.

The agent calls `plugin_manager` with `action: install_bundle` and `target: /path/to/dsh-mcp-console`.
That is the supported path: it links the package into the profile, appends it to
`dsh.profile.bundles`, and reports `application: applied` when it takes effect.

Doing it by hand with pnpm also works, but pnpm alone does **not** register the bundle:

```bash
dsh plugin --profile <your-profile> add link:/abs/path/to/dsh-mcp-console
# then add "dsh-mcp-console" to "dsh".profile.bundles in
#   $DSH_HOME/profiles/<your-profile>/package.json
```

After install, reload the app window (⌘R / Ctrl+R) once so the client bundle is picked up.

## What you get

Four surfaces, each with a different job — deliberately not one component repeated three times.

| Surface | Where | What it does |
| --- | --- | --- |
| **Console** | main panel, via the sidebar icon | Two-column workbench: server list, detail pane, expandable tool list, add/edit drawer, delete confirm |
| **Popover** | chip in the session header | Read-only glance: counts + per-server state + inline probe/restart + "open console" |
| **Settings page** | Settings → MCP 服务器 | Single-column cards: one card per server with probe/restart/enable and the entry switches |
| **Bundle row** | Settings → Plugins → this plugin | One-line summary + "open console", nothing more |

Any of the three entry points can be switched off in the **入口** (entries) block, which appears at
the top of the settings page and in the console. The choice is stored per browser profile in
`localStorage` under `dsh-mcp-console:prefs`; it never touches your config file. The console main
panel and the bundle row stay registered so the plugin is always reachable.

## Managing servers

- **Probe** opens a temporary connection, lists tool names, and closes it. It does not disturb a
  running instance, and it works for servers that are disabled or failing.
- **Restart** reconnects the instance and resets the reconnect budget.
- **Enable / disable** rewrites the whole entry with `enabled: false` (or removes the field).
- **Add / edit** validates before writing: name pattern, transport-exclusive fields, integer
  timeouts in 1–3600000 ms, and `KEY=VALUE` / `Key: Value` line shapes.
- Servers contributed by other plugins (`configured: false`) are read-only here: probe and restart
  work, editing does not. The console labels them "由插件注册（只读）".

## Probe cost, honestly

There is **no host API that returns the tool names of a live instance**. The tool list can only come
from a probe, which means a real temporary connection — process spawn for `stdio`, HTTP handshake for
`streamable-http`. The console warns about this in every probe tooltip, and expands the tool list on
demand rather than on every render.

## How it relates to the official Settings form

Three layers, one owner:

- **Data owner**: the `mcp-manager` plugin. `config.servers` is its config, and it stays the single
  source of truth.
- **Views**: this plugin renders that same data in four places. It never caches a copy.
- **Writes**: through `ctx.configForms.get('mcp-manager')`, so revision conflicts are detected by the
  host and your YAML comments survive.

Uninstall this plugin and nothing is lost: the servers, their state, and the official settings form
are all still there.

## Known limitations

- Interface is **Chinese only** right now (no locale bundle yet).
- Tool **schemas and descriptions** are not shown — only names, because the host only exposes names.
- **No JSON import/export.** Configuration stays in the profile's patch file; read it from there.
- Bundle-level read-only servers cannot be edited (host restriction, not a UI choice).
- The session-header chip is a compact popover, not a full panel: no editing there by design.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Sidebar icon or chip missing | Entry switched off in the **入口** block — reopen the console from Settings → MCP 服务器, or clear `dsh-mcp-console:prefs` in localStorage |
| Console says the remote method is unavailable | `mcp-manager` is not enabled in this profile, or its remote methods have not mounted yet (the panel retries and shows the reason) |
| Everything says "状态未知" | The runtime stream has not produced a frame yet; check the banner text for the watch error |
| Edits rejected | The host refused the mutate (usually a concurrent write). The form re-reads the document; retry once |
| Installed but nothing appears | Reload the window once — client bundles are loaded at window boot |

## Permissions and data

- Reads: the host's MCP runtime stream and the `mcp-manager` config section.
- Writes: only that config section, through the official config form (`servers.<name>` paths).
- Stores locally: one `localStorage` key for the entry switches. No telemetry, no network calls of
  its own.

## Compatibility

- DSH `>=0.2.2-rc.2 <0.3.0-0` (developed and verified against `0.2.2-rc.3`).
- Client-side only; the host module (`index.js`) does nothing.
- Registered slots: `main` (key `mcp-console`), `sidebar.panellist` (id `mcp-console`),
  `conversation.session.header.utilities` (id `dsh-mcp-console-pill`),
  `settings.section` (id `mcp-servers`), `plugins.bundle.config` (key `dsh-mcp-console`).
  If a DSH upgrade renames a slot, the console still opens and says which slot failed.

## Development

Single-file client bundle, no build step, no dependencies:

- `client.js` — everything (hand-written `window.__ModuleLoader__` factory, `React.createElement`, CSS as a string array).
- `index.js` — host module, intentionally empty.
- `cordis.patch.yml` — bundle insert patch.

Checks used while developing:

```bash
# syntax (the app's bundled Node, since DSH ships Electron)
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --check client.js
```

A dependency-free DOM-less smoke test (`vm` + fake React + fake ctx) exercised 43 behaviours:
slot registration, watch frames, probe/mutate call shapes, the four surfaces, and the entry switches.

## Roadmap

- Locale bundle (English UI) and a `--lang` split for the docs.
- JSON import/export for `servers`, once the host offers a stable read/write shape.
- Log tail per server, if `mcp-manager` exposes one.

## License

MIT — see [LICENSE](LICENSE).

中文说明见 [README.zh.md](README.zh.md)。
