# OpenViking Memory Extension for Pi Coding Agent

Long-term semantic memory and context takeover for [pi](https://github.com/earendil-works/pi) sessions, powered by [OpenViking](https://github.com/volcengine/OpenViking). Recall happens automatically before every prompt, capture happens after every turn, and OpenViking can own long-term context by replacing committed history with an archive overview in pi's `context` hook.

> **Requires an OpenViking server with `viking://~` home-alias support.** Recall targets the
> caller's own context space through `viking://~/memories` and `viking://~/skills`; the uid-less
> `viking://user/memories` shorthand is rejected by newer servers.

> Design informed by lessons from all three OpenViking agent plugins: synchronous recall from OpenClaw, production-hardened capture/ranking from Claude Code, and anti-patterns dodged from Hermes's stale prefetch approach. See [DESIGN.md](./DESIGN.md) for the module-by-module design, including the context-takeover layer.

## Quick Start

### Prerequisites

- **pi coding agent** installed (`npm i -g @earendil-works/pi-coding-agent`)
- **Node.js 18+** (for the extension's TypeScript runtime)
- **An OpenViking server** reachable — local or remote

### 1. Have an OpenViking server reachable

Either run one locally or point at a remote one. The [quickstart guide](../../docs/en/getting-started/02-quickstart.md) walks through both options. Default port is `1933`; local mode runs without authentication.

Verify it's up:

```bash
curl http://localhost:1933/health   # or your remote URL
```

### 2. Install the extension

Use the shared installer:

```bash
bash examples/memory-plugin-shared/install.sh --harness pi
```

The installer copies the extension to `~/.pi/agent/extensions/openviking`, which is one of pi's auto-discovery roots, so pi loads it on the next `pi` invocation — no `packages` entry is needed. (Registering the same path with `pi install` would load it twice, so the installer avoids that and clears any stale entry left by older versions.)

### 3. Configure (optional)

Credentials are resolved from `OPENVIKING_*` environment variables, `~/.openviking/ovcli.conf`, then `~/.openviking/ov.conf`. Run the setup wizard when you need to configure a remote server:

```bash
node ~/.pi/agent/extensions/openviking/scripts/setup.mjs
```

Behaviour and peer-scoping knobs live in `~/.openviking/ovcli.conf` beside the credentials, in the shared `plugin` section or in the `plugin.pi` override. Changes made in the `/viking` panel are written to `~/.openviking/pi-settings.json`, which sits on top of those layers:

```json
{
  "url": "http://127.0.0.1:1933",
  "api_key": "your-api-key-here",
  "plugin": {
    "recallLimit": 6,
    "pi": {
      "autoCapture": true,
      "peerId": "",
      "workspacePeer": true,
      "recallPeerScope": "all",
      "recallTokenBudget": 2000,
      "scoreThreshold": 0.35,
      "minQueryLength": 3,
      "profileTokenBudget": 10000,
      "resumeContextBudget": 32000,
      "commitTokenThreshold": 20000,
      "takeoverEnabled": false,
      "takeoverTokenThreshold": 30000,
      "takeoverKeepRecentTurns": 3,
      "takeoverOverviewBudget": 3000,
      "takeoverOverviewPollMs": 2000,
      "takeoverOverviewPollMax": 15
    }
  }
}
```

Keys in `plugin` apply to every harness; keys in `plugin.pi` apply to this extension and override them. Resolution is `OPENVIKING_*` environment variables → the workspace's `.openviking/config.json`, `.openviking/config.local.json` and machine registry entry → `plugin.pi` → `plugin` → built-in defaults. Every knob, with its type, default, range, environment variable and accepted older spellings, is declared in [`examples/memory-plugin-shared/lib/config-schema.mjs`](../memory-plugin-shared/lib/config-schema.mjs). The panel's own file is a projection of the settings it edits: unknown keys are ignored, credential fields are never read from or written to it, and the legacy `enabled`, `syncTurns`, `bypassPatterns` and `statusBar` keys are dropped on the next save.

Credential environment variables:

| Env Var | Meaning |
|---------|---------|
| `OPENVIKING_URL` | OpenViking server URL |
| `OPENVIKING_API_KEY` / `OPENVIKING_BEARER_TOKEN` | Bearer token |
| `OPENVIKING_ACCOUNT` | Trusted-mode account |
| `OPENVIKING_USER` | Trusted-mode user |
| `OPENVIKING_PEER_ID` | Actor peer id |
| `OPENVIKING_WORKSPACE_PEER` | Derive an actor peer from the workspace's git identity by default; set `0` to send no peer |
| `OPENVIKING_RECALL_PEER_SCOPE` | `all` recalls other project memories with a score penalty; `actor` only sees global plus the current project |
| `OPENVIKING_DEBUG_LOG` | Write JSON Lines debug records to this path |

Recall asks the server to assemble the context block in one request
(`POST /api/v1/search/search` with `mode="context"`), so token budgeting, detail
tiers and cross-turn dedup are shared with every other harness. Deployments
without that endpoint fall back to `/api/v1/search/recall`, and that outcome is
cached so only the first turn pays for the probe.

API keys are sent as `Authorization: Bearer ...`. By default the extension derives a peer from the git identity of the process workspace path: the normalized `origin` URL of the repository the workspace sits in, else that repository's root path. Outside a git repository no peer is sent at all, and what is remembered there goes to the user-level space `viking://user/<you>/memories`. `git@github.com:volcengine/OpenViking.git` becomes `github.com-volcengine-openviking`; the path fallback keeps the older naming rule where every non-letter-or-digit character becomes `-`, so `/Users/x/Dev/OpenViking` becomes `-Users-x-Dev-OpenViking`. One repository therefore keeps one peer across subdirectories, worktrees, clones and machines, while a fork's different origin keeps it separate. The extension reads the workspace's `.openviking/config.json`, so a `peer.id` or `peer.source` written there applies. The effective peer is sent as `X-OpenViking-Actor-Peer` and stored as `peer_id` on captured session messages. `OPENVIKING_PEER_ID` takes precedence over every file; below it, a workspace `peer.id` or the `plugin` section's `peerId` takes precedence over `ovcli.conf`'s `actor_peer_id` and `ov.conf`'s `pi.peerId`; and a peer from any of those takes precedence over workspace derivation. Memories written under the older path-derived peer stay reachable under the default broad recall, which sweeps every peer under the user.

Recall defaults to the broad mode: global memory, the current workspace, and other workspace memories can all be recalled, with other workspaces penalized and rendered later. Set `OPENVIKING_RECALL_PEER_SCOPE=actor` for the isolation mode, which only sees global memory plus the current workspace. In deployments where one bot serves multiple real people, such as zouk, vikingbot, or AstrBot, use the isolation mode with an explicit actor peer so one person's memories are not recalled into another person's session.

### 4. Start Pi

```bash
pi
```

The extension adds its segment to pi's footer and registers the `viking_*` tools on startup. While a submitted prompt is waiting on OpenViking — the first-turn startup chain or a recall search — the footer shows a clock glyph and elapsed seconds, and the working row shows its spinner with the same seconds, so a slow server never looks like a frozen prompt. Memories persist across sessions — no additional setup.

## Configuration Reference

### Tuning fields

All fields below live in `ovcli.conf`'s `plugin` section, or in the `plugin.pi` override. Defaults are shown.

| Field                    | Default    | Description                                                              |
|--------------------------|------------|--------------------------------------------------------------------------|
| `autoCapture`            | `true`     | Enable auto-capture of conversation turns                                |

### Peer scoping

| Field                    | Default    | Description                                                              |
|--------------------------|------------|--------------------------------------------------------------------------|
| `peerId`                 | `""`      | Local explicit peer fallback; shared credential sources take precedence  |
| `workspacePeer`          | `true`     | Derive a peer from the workspace's git identity when no explicit peer is set; `false` sends no peer |
| `recallPeerScope`        | `"all"`   | Use `"actor"` for strict current-peer recall or `"all"` for broad recall |

### Recall tuning

| Field                    | Default    | Description                                                              |
|--------------------------|------------|--------------------------------------------------------------------------|
| `recallTokenBudget`      | `2000`     | Token budget for inline recall content                                   |
| `recallMaxContentChars`  | `500`      | Per-item content cap for search results                                  |
| `recallPreferAbstract`   | `true`     | Prefer L0 abstract over L2 full body when available                      |
| `recallLimit`            | `10`       | Legacy quota-scaling input converted to six coding quotas, not a final cap |
| `scoreThreshold`         | `0.35`     | Min relevance score (0–1)                                                |
| `minQueryLength`         | `3`        | Skip recall for queries shorter than N characters                        |
| `recallLedger`           | `true`     | Persist injected blocks and re-apply them to historical user messages so provider prompt-prefix caches keep hitting |
| `recallQueryExpansion`   | `"auto"`   | `auto` lets the server expand the query; `off` sends it verbatim      |

### Recall injection ledger

Pi's `context` hook hands extensions a deep copy of the session messages, so
an injected `<openviking-context>` block is never written back to session
storage. Without compensation, every request's history diverges from what the
provider saw last turn, and strict-prefix prompt caches (DeepSeek and other
OpenAI-compatible providers) miss from the first injected message onward
(#4137). The ledger records exactly which block was injected into which user
message (keyed by stable Pi entry id + content hash) in
`~/.openviking/pi-recall-ledger/<session>.json` and re-applies them on every
request, keeping the prefix byte-identical across turns while the newest
message still gets fresh, current-query recall. Disable with
`"recallLedger": false` or `OPENVIKING_RECALL_LEDGER=0`. Losing the ledger
file only costs one cache miss; alignment resumes on the next turn. Stable
entry ids let compacted retained messages and `/tree` branches recover their
own original blocks even when active-context positions change.

Explicit `recallLimit` values from 1 through 5 produce an effective total
quota of 6 because each coding category keeps one retrieval slot. Direct API
integrations should configure category `quotas` when they need exact ceilings.

### Capture tuning

| Field                    | Default    | Description                                                              |
|--------------------------|------------|--------------------------------------------------------------------------|
| `captureMode`            | `"semantic"` | `"semantic"` (always capture) or `"keyword"` (trigger-based)           |
| `captureMaxLength`       | `24000`    | Max sanitized text length for the capture decision                       |
| `captureAssistantTurns`  | `true`     | Include assistant turns (text + tool USE inputs)                         |
| `captureToolResults`     | `false`    | Include tool result output (noisy — off by default)                      |
| `captureToolMaxChars`    | `1000000`  | Guard cap on one tool part's `tool_output`; the server externalizes oversized output |
| `commitTokenThreshold`   | `20000`    | Pending-token threshold for client-driven commit                         |
| `commitKeepRecentCount`  | `10`       | Live tail kept after commit                                              |

### Context takeover

Takeover is off by default: pi's own compaction owns long sessions unless you
opt in. When enabled, OpenViking commits archived history, polls the session
overview, then the `context` hook replaces covered conversation turns with a
synthetic `[OpenViking Session Context]` user message while keeping the recent
live tail.

| Field                    | Default    | Description                                                              |
|--------------------------|------------|--------------------------------------------------------------------------|
| `takeoverEnabled`        | `false`    | Let OpenViking own long-term context through the `context` hook. Env: `OPENVIKING_TAKEOVER` |
| `takeoverTokenThreshold` | `30000`    | Synced-token pressure that triggers commit and boundary advance           |
| `takeoverKeepRecentTurns`| `3`        | Recent user turns retained in full fidelity                              |
| `takeoverOverviewBudget` | `3000`     | Token budget for the injected archive overview                           |
| `takeoverOverviewPollMs` | `2000`     | Delay between overview polling attempts after commit                     |
| `takeoverOverviewPollMax`| `15`       | Max overview polling attempts before fail-open                           |

### Injection tuning

| Field                    | Default    | Description                                                              |
|--------------------------|------------|--------------------------------------------------------------------------|
| `profileTokenBudget`     | `10000`    | Token budget for user profile block                                      |
| `resumeContextBudget`    | `32000`    | Token budget for archive overview on session resume                      |

### Misc

| Field                    | Default    | Description                                                              |
|--------------------------|------------|--------------------------------------------------------------------------|
| `bypassSession`          | `false`    | Skip capture and recall for the whole session; the panel toggles it live |
| `bypassSessionPatterns`  | `[]`       | Glob patterns matched against the cwd; a hit skips all OpenViking work for the session. Env: `OPENVIKING_BYPASS_SESSION_PATTERNS` (CSV), `OPENVIKING_BYPASS_SESSION=1` |
| `logLevel`               | `"error"`  | `"silent"`, `"error"`, or `"info"`                                      |
| `debug`                  | `false`    | Write JSON Lines debug records; when the path is empty it falls back to `~/.openviking/logs/pi.jsonl` |
| `debugLogPath`           | `""`       | Debug log destination                                                   |

Bypass now runs through the same matcher every other OpenViking harness uses, so the patterns are real globs: `*` stops at a path separator and `**` crosses them. A bare path used to match its subdirectories as a prefix, and no longer does — write `"/tmp/scratch**"` where `"/tmp/scratch"` used to be enough.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Pi Coding Agent                    │
│                                                      │
│  session_start  before_agent_start  context  turn_end│
│  session_before_compact  session_shutdown            │
└────────┬──────────────────┬───────────┬──────────────┘
         │                  │           │
         │  ┌───────────────▼───────────▼────────┐
         │  │   extension modules (.ts)           │
         │  │   client / sync / recall / tools    │──────►  OpenViking
         │  └─────────────────────────────────────┘        Server
         │                                                (HTTP API)
         │  ┌──────────────────────────────────────┐
         └──►  7 registered LLM tools              │
            │  viking_search / viking_read / …     │
            └──────────────────────────────────────┘
```

The extension is a single directory of TypeScript files loaded by pi's `jiti` transpiler — no build step, no npm dependencies, no MCP server. All communication goes over HTTP to the OpenViking REST API.

### Event Flow

| Pi Event               | Extension Action                                                                 |
|------------------------|----------------------------------------------------------------------------------|
| `session_start`        | Health check → derive OV session → build profile context → restore takeover state |
| `before_agent_start`   | Idempotent startup for `pi -c` + queue the current prompt for recall              |
| `context`              | Run current-prompt recall after UI rendering, then inject takeover and recall context |
| `turn_end`             | Extract branch entries → write or pending-queue OV messages → maybe advance boundary |
| `session_before_compact`| Takeover mode returns OV overview as pi compaction summary; otherwise commits pending messages |
| `session_shutdown`     | Persist takeover state or final non-takeover commit                              |

### Recall: Synchronous, Not Stale

Unlike Hermes's stale prefetch (recall from previous turn's query, injected one turn late), this extension searches OpenViking with the **current** user prompt via pi's `context` event. Pi renders the submitted user message before this hook, so recall latency does not hold the message off-screen. Results are still injected into the same model turn as `<openviking-context>` blocks. This means:

- **First turn** of a session gets relevant context immediately
- **Topic switches** within a session get correct recall
- No waiting for the next turn to see relevant memories

### Memory Pollution Prevention

Before pushing turns to OpenViking, shared capture sanitization strips injected context blocks such as `<openviking-context>` to prevent a self-referential pollution loop where recall context is captured back as user messages.

In takeover mode the adapter uses faithful capture: acknowledgments and short
turns are retained because they may later be represented only through the OV
archive overview. Empty text, slash commands, and OpenViking status messages
remain filtered.

### Tool Use Preservation

Tool capture preserves structured tool parts with bounded inputs and outputs. The memory extractor sees what the agent did without indexing unbounded raw output.

## LLM Tools

The extension registers 7 tools that pi's model can invoke on demand:

| Tool                     | Description                                                |
|--------------------------|------------------------------------------------------------|
| `viking_search`          | Semantic search across memories, resources, and skills     |
| `viking_read`            | Read a `viking://` URI at abstract / overview / full level |
| `viking_browse`          | List directory contents or stat a `viking://` URI          |
| `viking_remember`        | Store a fact or preference into long-term memory           |
| `viking_forget`          | Delete a memory by URI or search query                     |
| `viking_add_resource`    | Ingest a URL into OpenViking for indexed retrieval         |
| `viking_archive_expand`  | Expand an archived session back into raw conversation      |

`/viking` (type it in pi's chat) opens the OpenViking panel — settings, diagnostics and session actions in one place. There are no subcommands:

| Section        | What it holds                                                                 |
|----------------|-------------------------------------------------------------------------------|
| Session        | context-injection toggle (session only) and *commit now*                      |
| Capture        | what gets written, extraction mode, commit threshold and tail                 |
| Recall         | token budget, result quota, score threshold, abstract cap, ledger             |
| Context        | takeover switches, profile and resume budgets                                 |
| Interface      | footer density and notification level                                         |
| Diagnostics    | connection/session/queue snapshot, live config values, plus *run full doctor*  |
| Advanced       | peer scope, capture caps, polling, bypass and debug logging                    |

Booleans and enums cycle with `Enter`/`Space`; numeric values open a preset picker; type to filter the current section; `Esc` goes back. Most changes apply immediately (managers hold the config by reference); `profileTokenBudget`, `resumeContextBudget` and a mid-session takeover enable take effect at the next session start, and `logLevel` only governs startup notices. Only the setting you changed is written to `~/.openviking/pi-settings.json`, so untouched values keep coming from `ovcli.conf` and the environment. Credential-derived fields are never written. In a non-interactive run (`pi -p`), `/viking` prints a one-line status instead.

### Footer Status Bar

`statusBarLevel` selects one of four densities; `standard` is the default. It is panel-only and stored in `~/.openviking/pi-settings.json` — writing it in `ovcli.conf` has no effect:

```
hidden     (no segment)
minimal    OV ●
standard   OV ● ⇅340 · 18k/20k              (takeover off, the default)
standard   OV ● ⇅340 · 3/6 · 18k/30k        (takeover on)
verbose    OV ● ⇅340 · ctx 3/6 · 18k/30k · ⏸inj · pi-0f3a9…
```

The footer never animates: it shows standing state only. The two waits that sit between "user pressed enter" and the provider request — the first-turn startup chain and each recall retrieval — are reported in the working row instead, where pi's own spinner carries the activity and the message is the bracketed elapsed time. The brackets are the marker, so an OpenViking wait never looks like the plain `Working` row of an ordinary request:

```
ordinary request   ⠋ Working
startup chain      ⠋ [1s]
recall retrieval   ⠋ [3s]   (past a minute: ⠋ [1m15s])
```

| Segment      | Meaning                                                                          |
|--------------|----------------------------------------------------------------------------------|
| `OV ●` / `OV ○` | Connection state (green/red)                                                  |
| `⇅n`         | Entries synced in this session (the sync watermark, not a per-turn delta)         |
| `c/l`        | Takeover coverage: covered/seen user turns (only while takeover is on)            |
| `18k/30k`    | Token pressure vs the threshold that currently applies — takeover when on, commit when off |
| `⏸inj`       | Context injection paused for this session                                        |
| `pi-0f3a9…`  | OpenViking session id (verbose only)                                             |

`minimal` keeps the connection dot and shows only anomalies otherwise: `⏸` for a paused injection and `⚠` when pressure reaches 80% of the threshold. Empty segments are omitted, token counts are humanized, and colors follow the active pi theme.

## Compared to Pi's Built-in Memory

Pi has a built-in `MEMORY.md` file system. This extension **complements** it:

| Feature      | Built-in `MEMORY.md`              | OpenViking extension                              |
|--------------|-----------------------------------|---------------------------------------------------|
| Storage      | Flat markdown                     | Vector DB + structured extraction                 |
| Search       | Loaded into context wholesale     | Semantic similarity + ranking + token budget      |
| Scope        | Per-project                       | Cross-project, cross-session, cross-agent         |
| Capacity     | Context-limited                    | Unlimited (server-side storage)                   |
| Extraction   | Manual rules                      | LLM-powered entity / preference / event extraction|
| Subagents    | Same as parent                    | Isolated session + typed agent namespace          |

## Compared to Claude Code Plugin

Both plugins share the same core design (informed by each other):

| Feature             | Claude Code Plugin                     | Pi Extension                           |
|---------------------|----------------------------------------|----------------------------------------|
| Architecture        | Hook scripts (.mjs) + MCP delegation   | Native TypeScript extension            |
| Recall timing       | Synchronous (UserPromptSubmit hook)     | Synchronous (context event)            |
| Tool delivery       | OV server's MCP endpoint (16 tools)     | pi.registerTool() (7 tools)            |
| Write path          | Detached worker (async)                 | Async promise (pi's event loop)        |
| Installation        | `claude plugin install` + setup script  | Copy directory → auto-discovered       |
| Memory index        | None (flashlight search model)          | Built (map model — model sees what OV knows) |
| Subagent isolation  | Explicit hook management                | Natural process-level isolation        |

## Extension Structure

See [DESIGN.md](./DESIGN.md) for what each module is responsible for, how the modules meet pi's events, and the design ancestry shared with the other OpenViking plugins.

```
pi-coding-agent-extension/
├── config.ts            # Typed config view (shared layers + panel sidecar)
├── client.ts            # OpenViking HTTP client (fetch + response envelope)
├── sync.ts              # Turn capture, write queue, session lifecycle
├── recall.ts            # Synchronous recall with ranking + budget
├── takeover.ts          # Thin pi binding around lib/takeover-core.mjs
├── tools.ts             # 7 registered LLM tools
├── settings.ts          # The /viking panel (sections, diagnostics, doctor pager)
├── lib/pi-config.mjs     # Shared config resolution + the ~/.openviking/pi-settings.json sidecar
├── lib/pi-settings.mjs   # Canonical list of settings the panel owns
├── lib/takeover-core.mjs # Pure context-takeover state machine
├── lib/recall-ledger.mjs # Injected recall blocks, replayed to keep prompt caches warm
├── lib/dynamic-logger.mjs # Debug logger whose path follows the live config
├── scripts/doctor.mjs   # Full diagnostics host for the shared doctor core
├── index.ts             # Extension entry point (event handlers + /viking command)
├── package.json         # Name and version (the User-Agent's, and the release gate's)
├── DESIGN.md            # Module-by-module design, including context takeover
└── README.md
```

All TypeScript files are loaded directly by pi's built-in `jiti` transpiler — zero dependencies beyond Node.js.

## Troubleshooting

| Symptom                                 | Cause                                                | Fix                                                         |
|-----------------------------------------|------------------------------------------------------|-------------------------------------------------------------|
| Extension not loading                   | Package not registered with pi, or a load-time error | `pi install git:…`; run `/viking` or `node scripts/doctor.mjs` |
| No recall on first prompt               | OpenViking server not running or wrong URL           | `curl http://localhost:1933/health`                         |
| Tools not showing after `pi -c` resume  | Known pi issue (tools not re-registered on resume)   | Workaround built in — tools register in `before_agent_start`|
| Extension crashes on load               | Wrong OV server URL or network issue                 | Check `logLevel` and server accessibility                   |
| No memories extracted                   | Wrong embedding/extraction model in OV config        | Check OV's `embedding` / `vlm` configuration                |
| Takeover never advances                  | Pending addMessage replay, commit, or overview polling failed | Turn on *debug log* under Advanced, then use *commit now* in `/viking`'s Session section |

## License

Apache-2.0 — same as [OpenViking](https://github.com/volcengine/OpenViking).
