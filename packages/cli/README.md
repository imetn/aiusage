# @aiusage/cli

`@aiusage/cli` is the AIUsage command-line tool for:

- discovering and managing projects across AI tools
- scanning local Claude Code, Codex, Cursor, Copilot CLI, Copilot for VS Code, Gemini CLI, Antigravity, Amp, Kimi Code, Qwen Code, Droid, OpenCode, Pi, and Trae usage
- importing historical usage from Anthropic Admin API
- printing local usage summaries for the last 7, 30, 90, or 180 days, or all history
- scheduling automatic sync to an AIUsage Worker
- diagnosing configuration and connectivity issues

The local scanners have been compatibility-audited against the overlapping
parsers in the MIT-licensed [tokscale](https://github.com/junhoyeo/tokscale)
project. AIUsage keeps tool-specific safeguards where the source semantics
differ, rather than treating every local record as billable token usage.

## Local scanner coverage

| Tool | Sources and compatibility behavior |
|------|------------------------------------|
| Claude Code | JSONL from `~/.config/claude/projects/`, `~/.claude/projects/`, `CLAUDE_CONFIG_DIR`, `~/.claude-*` profiles, and Claude Desktop Cowork session roots; deduplicates parent/sidechain replays, merges streaming snapshots per token field, and honors wrapper providers. Aggregate `stats-cache.json` is intentionally not converted into guessed per-message usage. |
| Codex CLI | Active and archived `~/.codex` sessions; fork-aware replay boundaries, inherited baselines, `last_token_usage`, and total-delta fallback. |
| Cursor | Reads the local `state.vscdb` credential and requests Cursor's token-strategy usage CSV; the database is snapshotted when locked. |
| Copilot CLI | OpenTelemetry JSONL under `~/.copilot/otel/` plus `session-state` shutdown totals; granular inference spans supersede same-trace aggregates. |
| Copilot for VS Code | Chat logs, legacy session JSON, and modern CRDT `workspaceStorage/**/chatSessions/*.jsonl`; modern sessions contribute real token fields, while legacy records remain interaction-only. |
| Gemini CLI | Session JSON/JSONL, headless stats, and `$set.messages` updates under `~/.gemini/tmp/`, with last-write-wins request deduplication. |
| Antigravity | Read-only SQLite usage from `~/.gemini/antigravity`, `antigravity-cli`, and `antigravity-ide`; de-duplicates generation, step, retry, and copied-session records. Legacy metadata remains event-only. Model costs use estimated API reference prices, not subscription quota or AI credit charges. |
| Amp | `~/.local/share/amp/threads/`; reconciles the usage ledger with message usage so partial ledgers are completed without double-counting. |
| Kimi CLI / Kimi Code | Legacy `~/.kimi/sessions/` and `$KIMI_CODE_HOME/sessions/` (default `~/.kimi-code/sessions/`) `wire.jsonl`; handles progressive status snapshots and nested agent sessions. |
| Qwen Code | Current `~/.qwen/projects/` and legacy `~/.qwen/tmp/` chat JSONL, with session/position deduplication and cache-aware input accounting. |
| Droid | `~/.factory/sessions/*.settings.json`; uses persisted token totals first and the transcript only as a model fallback. |
| OpenCode | All XDG `opencode*.db` channel databases, including v1 `message` and v2 `session_message`, plus legacy `storage/message/*.json`; deduplicates dual writes/forks and preserves provider-reported cost. Node 22.13+ uses built-in read-only SQLite, with system `sqlite3` as the older-Node fallback. |
| Pi / Oh My Pi | `~/.pi/agent/sessions/` and `~/.omp/agent/sessions/` JSONL, including provider, cache-write, and session metadata. |
| Trae CN | `aiusage trae sync --edition cn` reads local history through Trae's official `ai-agent` RPC and writes a privacy-minimized cache under `~/.aiusage/trae-cache/sessions/`. The encrypted SQLCipher database is never opened directly. |
| Trae / Trae Solo (international) | `aiusage trae sync --edition intl` reads the older plain-JSON or decrypts the newer desktop credential format, then queries Trae's official account usage API once; IDE and Solo share the same account-level data. Numeric session data is cached under `~/.aiusage/trae-cache/intl/sessions/`. Existing tokscale caches under `~/.config/tokscale/trae-cache/sessions/` remain compatible and are deduplicated by session. |

Only token counters and session metadata are aggregated or uploaded. Conversation
content and local credentials are never uploaded.

## Install

```bash
npm install -g @aiusage/cli
```

Or run it directly with `npx`:

```bash
npx @aiusage/cli --help
```

After installation:

```bash
aiusage --help
```

## Commands

### project

Discover and manage projects on this machine.

```bash
aiusage project                         # list all discovered projects (default)
aiusage project list                    # same as above
aiusage project alias myapp "我的应用"   # set alias for a project
aiusage project alias                   # list all configured aliases
aiusage project alias --remove myapp    # remove alias
```

Scans data directories for all supported tools, including Kimi Code session metadata and the Trae CN sync cache, listing discovered projects with their aliases and sources.

Project aliases are applied locally before upload. If two devices set the same alias for their respective project directories, the server merges them into one project.

### report

Local usage report. No cloud upload required.

```bash
aiusage report                          # default: last 7 days + today, English, compact
aiusage report --range 1m               # last 30 days
aiusage report --range 3m               # last 90 days
aiusage report --range 6m               # last 180 days
aiusage report --range all              # all history
aiusage report --tool trae-cn --range all    # Trae CN only
aiusage report --tool trae-intl --range 6m   # international only
aiusage report --tool trae --range all       # both editions
aiusage report --detail                 # show all columns, top models, pricing notes
aiusage report --lang zh                # Chinese output
aiusage report --no-emoji               # disable emoji in title
aiusage report --json                   # JSON output
```

Reads data from local tool data directories including Claude Code and Desktop Cowork session roots, `~/.codex` (Codex), Cursor local state plus usage export, VS Code Copilot Chat logs, and `~/.gemini/antigravity` (Antigravity).

**Compact mode** (default) shows Sources and Daily tables with merged Cache column and 2-decimal cost. **Detail mode** (`--detail`) expands all columns (CacheRead, CacheWrite, Reasoning), adds Top Models and Pricing Notes sections, and shows 4-decimal cost.

### trae sync

Sync either Trae edition before running a regular report or dashboard upload:

```bash
aiusage trae sync --edition cn
aiusage trae sync --edition intl --since 180
aiusage trae sync --edition all --since 180

aiusage report --tool trae-cn --range all
aiusage report --tool trae-intl --range 6m
aiusage report --tool trae --range all
```

If Trae CN is closed, AIUsage temporarily launches it with a local-only debugging port, reads the official `ai-agent` session API, then closes the temporary instance. If Trae is already running without that port, quit Trae and rerun the command. Use `--port 9230 --no-launch` to connect to an instance you started yourself.

Trae IDE and Trae Solo share account-level international usage, so AIUsage stops after the first working credential and does not double-count the account. It reads or decrypts `storage.json` locally and stores credentials with `0600` permissions under `~/.aiusage/trae-cache/intl/credentials-{ide,solo}.json`; credentials and conversation content are never uploaded. The numeric API cache is written to `~/.aiusage/trae-cache/intl/sessions/usage.json`. Existing tokscale session caches are still read, with the newest snapshot retained per session.

Use `--tool trae-cn` or `--tool trae-intl` to isolate one edition. `--tool trae` is the stable combined alias and includes compatible legacy rows. Regular `sync` deliberately rejects `--tool` because it uploads authoritative full-day snapshots.

### Shared date options

`scan`, `report`, and `sync` use the same date options:

```bash
aiusage scan --today                    # today only
aiusage report --date 2026-03-31        # specific date
aiusage sync --range 1m                 # last 30 days
aiusage report --range 6m               # last 180 days
aiusage sync --lookback 14              # last 14 days + today
aiusage scan --from 2025-01-01 --to 2026-04-05
```

Use `--range 1m`, not `range -1m`. `scan`, `report`, and `sync` support `--range 6m`; `report` also supports `--range all`. Use explicit `--from/--to` for larger scan or sync ranges.

### scan

Scan local usage and print detailed breakdowns.

```bash
aiusage scan                            # yesterday
aiusage scan --date 2026-03-31          # specific date
aiusage scan --range 1m                 # last 30 days
aiusage scan --tool trae-cn --range 6m  # Trae CN only, last 180 days
aiusage scan --date 2026-03-31 --json   # JSON output
```

Defaults to yesterday when `--date` is omitted.

### init

Initialize local configuration.

```bash
aiusage init --server https://your-worker.example.com --site-id your-site-id
```

### health

Test connectivity to the Worker.

```bash
aiusage health
```

### enroll

Register this device with the Worker.

```bash
aiusage enroll \
  --server https://your-worker.example.com \
  --site-id your-site-id \
  --enroll-token your-enroll-token \
  --device-name "MacBook Pro"
```

### sync

Upload usage data to the Worker. Default: last 7 days + today.

```bash
aiusage sync                   # last 7 days + today
aiusage sync --today           # today only
aiusage sync --date 2026-03-31 # specific date
aiusage sync --range 1m        # last 30 days
aiusage sync --lookback 14     # last 14 days + today
aiusage sync --from 2025-01-01 --to 2026-04-05  # date range
```

The server upserts, so re-syncing the same dates safely updates existing data.

### import

Import historical Claude usage from the Anthropic Admin API. Useful for recovering data from periods where local JSONL logs were rotated or deleted.

```bash
aiusage import --start 2025-06-01 --end 2025-09-15
aiusage import --key sk-ant-admin... --start 2025-06-01 --end 2025-09-15
```

Requires an **Admin API key** (`sk-ant-admin...`), not a regular API key. Get one at [console.anthropic.com](https://console.anthropic.com) → Settings → Admin Keys.

Save the key once:

```bash
aiusage config set anthropic-admin-key sk-ant-admin...
```

**Important:** Do not use `import` for dates already covered by local scan data — it will double-count.

### schedule

Manage automatic sync. Uses `launchd` on macOS and `cron` on Linux.

```bash
aiusage schedule            # enable, default every 5 minutes
aiusage schedule on         # same as above
aiusage schedule on --every 30m
aiusage schedule off        # disable
aiusage schedule status     # show current status
```

Supported intervals: `5m` – `1d`. Scheduled sync always includes today's live data (`--today`), so your dashboard stays current.

### doctor

Run diagnostic checks on configuration, server connectivity, scanner directories, and schedule status.

```bash
aiusage doctor
```

### config set

Manage local settings.

```bash
aiusage config set lang zh                              # default language: en or zh
aiusage config set emoji false                          # disable emoji in report title
aiusage config set device.alias "MacBook Pro 工作机"      # device display name on dashboard
aiusage config set privacy.projectVisibility masked     # hidden | masked | plain
aiusage config set project.alias MyApp "我的应用"        # prefer: aiusage project alias
aiusage config set scanner.opencodeDbPaths "/custom/opencode-next.db"  # extra OpenCode DB
aiusage config set anthropic-admin-key sk-ant-admin...  # for aiusage import
```

**Device alias** is shown on the dashboard to distinguish multiple devices. Set it to something recognizable (e.g. your machine name or emoji):

```bash
aiusage config set device.alias "💻 MacBook Pro"
aiusage config set device.alias "🖥️ iMac Studio"
```

CLI flags (`--lang`, `--no-emoji`) override config values for a single run.

## Configuration

Config file: `~/.aiusage/config.json`

Sync log (when scheduled): `~/.aiusage/sync.log`

## License

MIT

Only one `sync` or `import` process can scan and upload at a time for the same local configuration. A second manual or scheduled sync exits with a busy message; retry after the running sync finishes. This prevents an older scan from arriving late and replacing newer daily usage. The lock refreshes while the process runs and recovers after a crashed process becomes stale.
