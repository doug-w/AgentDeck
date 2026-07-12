# Architecture

Core bridge architecture, adapter hierarchy, and module system. See [daemon.md](daemon.md) for the daemon hub design and [plugin-conventions.md](plugin-conventions.md) for plugin internals.

## Monorepo layout

- **bridge/** — Node.js server: Daemon (sole hub for all clients, mDNS, device modules) + Session Bridge (PTY, hook HTTP, state machine). BridgeCore (shared infra), PtyAdapter hierarchy, output parser, WebSocket server, voice (whisper.cpp), usage API client, auth token, SSE broadcast, TUI dashboard (`tui/`)
- **plugin/** — Stream Deck SDK v2 plugin: actions for buttons/encoders, bridge WebSocket client
- **shared/** — TypeScript types and utilities shared between bridge and plugin (protocol, states, timeline, adapter interfaces, `format-utils` time/count/bytes formatters, `timeline-summarizer` extractTopicHint/cleanLLMOutput, `deduplicateEntry` pipeline, `session-utils` stateRank/sortSessions/assignDisplayNames — 세션 정렬/번호 공통 유틸리티, 6곳에서 import)
- **hooks/** — Claude Code CLI hook installer for the user-global `~/.claude/settings.json` (same file the App Store opt-in UI targets; the legacy `settings.local.json` target is scrubbed on install/migration — Claude Code only reads that file for home-directory sessions), Codex lifecycle hook installer for `~/.codex/config.toml`, and OpenCode observer plugin installer for `~/.config/opencode/plugins/agentdeck.js`
- **config/** — Default settings and prompt templates
- **setup/** — npm setup package: `npx @agentdeck/setup` one-command installer
- **android/** — Jetpack Compose launcher app: e-ink monitoring + interactive Deck control (CremaS, Onyx, Kobo, tablets)
- **apple/** — SwiftUI Multiplatform app: iPhone/iPad/macOS dashboard + Deck control (App Store distribution). macOS includes an **in-process Swift daemon** (`AgentDeck/Daemon/`, currently 63 Swift files) with HTTP/WS, mDNS, native Serial/Pixoo/Timebox/iDotMatrix modules, WiFi ESP32 presence, Gateway proxy, and timeline/APME support. It has no Node.js dependency and never launches sessions; Claude hooks are installed only through the explicit user-consent file picker. D200H is driven only by the external Ulanzi Studio plugin; the retained Swift direct-HID path is dormant (`enableD200hDirectHID = false`). External Node-daemon-only capabilities are shown through progressive enhancement when `DaemonService.isUsingExternalDaemon` is true. The previous **Launch Session** entry point was removed on 2026-05-10; App Store builds never create Terminal windows, scripts, AppleScript prompts, or child processes. See [appstore-feature-matrix.md](appstore-feature-matrix.md) for the canonical tier split.
- **esp32/** — PlatformIO Arduino firmware: LVGL touch displays (ESP32-S3: 86Box 480×480, IPS 3.5" 480×320 landscape / 320×480 portrait, Round AMOLED 360×360) + WS2812B LED matrix (ESP32 classic: Ulanzi TC001 8×32). Board-specific `#ifdef`, per-board partition tables, FastLED matrix renderer bypasses LVGL entirely. IPS 3.5" supports runtime portrait↔landscape switching via `set_orientation` protocol command or Settings toggle (NVS persistent, `g_screenW`/`g_screenH` runtime globals)

## Language/tooling

- **pnpm workspaces** for monorepo management
- **ES modules** throughout (type: "module")
- **Node16 module resolution** in TypeScript

## BridgeCore

`bridge/src/bridge-core.ts` — Shared infrastructure class used by both `startSession()` (index.ts) and `startDaemon()` (daemon-server.ts). Contains StateMachine, WsServer, UsageTracker, DisplayMonitor, OllamaProbe, state caches, and common event wiring. Eliminates ~600 lines of duplication.

## PtyAdapter hierarchy

`bridge/src/adapters/pty-adapter.ts` — Abstract base class for PTY-based agents. Subclasses implement `getDefaultCommand()`, `wireOutputParser()`, `feedParser()`, `handleAgentCommand()`.

- `ClaudeCodeAdapter` extends PtyAdapter with OutputParser + Shift+Tab mode switching
- `CodexCliAdapter` extends PtyAdapter with CodexOutputParser plus Codex lifecycle hooks installed in `~/.codex/config.toml`; hooks are authoritative and rollout-tail parsing supplies response text where needed
- `OpenCodeAdapter` extends PtyAdapter + SSE overlay (spawns `opencode --port XXXX` TUI, connects to embedded HTTP server for structured events — no TUI parsing needed)
- `MonitorAdapter` is hook-only (no PTY)

## Device module system

`bridge/src/modules/` — Pluggable `DeviceModule` interface with auto-detect. Modules include mDNS, serial, Pixoo, Timebox, and ADB. Timebox Mini Light is BLE (ISSC transparent-UART): the CLI daemon spawns `sync_ble.py`, while the App Store Swift daemon drives it natively through CoreBluetooth. D200H direct-HID was removed from Node and is dormant in Swift; the **sole supported driver is `plugin-ulanzi/` running inside Ulanzi Studio**, with daemon connectivity derived from its WS presence. Session bridges never activate hardware modules — dashboard devices connect through the daemon. CLI flags include `--local` and `--no-{module}`.

## AgentAdapter abstraction (Phase 1-2 complete)

- `shared/src/adapter.ts` — `AgentAdapter` interface, `AgentCapabilities`, `AdapterEvent` types, and the canonical `AgentType` union (`claude-code`, `openclaw`, `codex-cli`, `codex-app`, `opencode`, `antigravity`, `monitor`)
- `bridge/src/adapters/pty-adapter.ts` — `PtyAdapter` abstract base (PtyManager + HookServer + common start/command handling)
- `bridge/src/adapters/claude-code.ts` — `ClaudeCodeAdapter extends PtyAdapter` (OutputParser + Shift+Tab mode switch). ~100줄 (was 227)
- `bridge/src/adapters/monitor.ts` — `MonitorAdapter` (hook-only, no PTY, `isAlive()` always true)
- `bridge/src/adapters/openclaw.ts` — `OpenClawAdapter` connecting to Gateway WebSocket
- `bridge/src/adapters/index.ts` — `createAdapter(type, gatewayUrl?)` factory (`'monitor'` → MonitorAdapter)
- Bridge `cli.ts` handles `--agent` + `--gateway` CLI flags; `index.ts` exports `startSession()`
- `StateUpdateEvent` includes `agentType` + `agentCapabilities` for plugin capability gating
- Adapter emits unified `AdapterEvent` (hook/parser/metadata/activity/connection)
- **Command routing split**: ClaudeCode defers `select_option`/`navigate_option`/`send_prompt` to bridge (PTY); OpenClaw handles all commands via RPC. Bridge updates StateMachine for adapter-handled commands.
- **OpenClaw capabilities**: `hasTerminal=false`, `hasModeSwitching=false`, `hasDiffReview=false`, `hasOptionLists=true`, `hasNavigablePrompts=false`, `hasSuggestedPrompts=false`, `hasApiUsage=false`

### OpenClaw Gateway protocol (v2 + v3, verified against OpenClaw 2026.4.14)

- Custom framing: `{ type: "req"/"res"/"event", ... }` (NOT JSON-RPC)
- Ed25519 device auth handshake: `connect.challenge` → `connect`
  - **v2 (Node CLI bridge)**: signed with `~/.openclaw/identity/` keypair (file-based)
  - **v3 (App Store macOS)**: self-generated Ed25519 keypair (no file I/O; private key in Keychain). `deviceId = sha256(raw pubkey)`, `token` issued by Gateway in `hello-ok.auth.deviceToken` on first pairing and reused on reconnect. Pairing requires manual approval via `openclaw devices approve <requestId>` or OpenClaw Web UI.
- Methods: `connect`, `health`, `models.list`, `logs.tail`, `sessions.list`, `sessions.subscribe`, `sessions.messages.subscribe`, `chat.send`, `chat.abort`, `exec.approval.resolve`, `system-presence`
- Events: `connect.challenge`, `health`, `sessions.changed`, `session.message`, `session.tool`, `chat` (delta/final/aborted/error), `exec.approval.requested/resolved`, `presence`, `tick`, `shutdown`
- Session tracking via `sessionKey` from `sessions.list` / `chat` events
- Default port 18789, auto-reconnect with exponential backoff; auth failures (`pairing_required`/`token_mismatch`/`device_auth_invalid`) surface to UI instead of looping. See [docs/gateway-protocol.md](gateway-protocol.md) for wire format.

## Plugin connection (daemon-only single path)

- `plugin/src/connection-manager.ts` — Bridge-only, no direct Gateway connection. `switchToOpenClaw()`/`switchToClaude()` send `switch_agent` WS command to daemon
- `plugin/src/agent-link.ts` — `AgentLink` interface (send/isConnected/getCapabilities/disconnect)
- Plugin connects to daemon or session bridge via BridgeClient only. All OpenClaw interaction proxied through daemon
- **Removed**: `gateway-client.ts`, `log-stream.ts`, `timeline-summarizer.ts` (plugin no longer connects to Gateway directly — daemon is sole Gateway connection point)

## Plugin capability gating (Phase 5 complete)

- `iterm-dial.ts`, `option-dial.ts` → `!hasTerminal`/`!hasSuggestedPrompts`
- `response-button.ts` → `!hasDiffReview`
- `plugin.ts` → 8곳 `caps` 전달

## node-pty optional

`optionalDependencies` + dynamic `await import('node-pty')` in PtyManager. Daemon/monitor modes never load the native module. Setup forces source build (`npm_config_build_from_source=true`) to avoid prebuilt ABI mismatch across Node versions. PtyManager catches `posix_spawnp` errors with rebuild guidance.
