import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { writeScriptIfChanged } from './codex-install.js';

// Re-export the Codex installer surface so callers reach it via the
// canonical `@agentdeck/hooks` entry point alongside the Claude installer.
export {
  installCodexHooksIfNeeded,
  uninstallCodexHooks,
  migrateCodexHooks,
  managedBlockBody as codexManagedBlockBody,
  DEFAULT_CODEX_CONFIG_PATH,
} from './codex-install.js';
export type { InstallOptions as CodexInstallOptions, InstallResult as CodexInstallResult } from './codex-install.js';

// Re-export the OpenCode plugin installer (standalone-session observation
// via opencode_* lifecycle hooks) through the same canonical entry point.
export {
  installOpenCodeHooksIfNeeded,
  uninstallOpenCodeHooks,
  opencodePluginPath,
  opencodePluginSource,
} from './opencode-install.js';
export type { OpenCodeInstallOptions, OpenCodeInstallResult } from './opencode-install.js';

export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'UserPromptSubmit',
] as const;

/**
 * Shell snippet that resolves the AgentDeck daemon's HTTP port at hook
 * runtime, then POSTs the hook payload to it. Kept in a single helper so
 * the three hook-writer code paths (`@agentdeck/hooks`, `@agentdeck/setup`
 * inlined copy, Swift `HookInstaller`) emit byte-identical shell.
 *
 * Discovery precedence:
 *   1. `$AGENTDECK_PORT` env var (set by `agentdeck claude` session bridge
 *      so the hook targets the *owning* daemon even when several daemons
 *      are running in parallel)
 *   2. `~/.agentdeck/daemon.json`                                  (CLI)
 *   3. App Store sandbox container `daemon.json`                   (Swift)
 *   4. Legacy App Store group container `daemon.json`              (Swift)
 *   5. `9120` fallback (legacy, never reached in practice)
 *
 * For (2)-(4) the snippet prefers the daemon's `httpPort` field when
 * present — Swift runs WS and HTTP on separate ports. Each candidate is
 * verified with a short `/health` probe so a stale daemon.json from a
 * crashed daemon doesn't swallow the hook.
 */
export function buildHookCommand(eventName: string): string {
  const preamble = [
    `PORT="\${AGENTDECK_PORT:-}"`,
    `if [ -z "$PORT" ]; then`,
    `  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do`,
    `    [ -f "$F" ] || continue`,
    `    P=$(python3 -c "import json;d=json.load(open('$F'));print(d.get('httpPort') or d.get('port',''))" 2>/dev/null)`,
    `    [ -n "$P" ] && curl -sf --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }`,
    `  done`,
    `fi`,
    `PORT="\${PORT:-9120}"`,
  ];
  // PreToolUse is request-response: the daemon may hold the connection open and
  // return a permission decision (device approval) or a soft-STOP deny. Capture
  // the body and echo it to stdout so Claude can gate the tool; empty output
  // (timeout/error/disabled) = Claude's normal permission flow. `--max-time 60`
  // exceeds the daemon's internal hold timeout (default 25s) so the fallback
  // reaches Claude before curl quits.
  if (eventName === 'PreToolUse') {
    return preamble.concat([
      `RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/PreToolUse" -H 'Content-Type: application/json' --max-time 60 -d @- 2>/dev/null)`,
      `printf '%s' "\${RESP:-}"`,
    ]).join('\n');
  }
  // Stop is also request-response: the daemon answers instantly — either an
  // empty body (turn ends normally) or `{decision:"block", reason}` delivering
  // a deck-queued directive so Claude continues with it. Short --max-time:
  // this runs on EVERY turn end, so a wedged daemon must never stall the TUI.
  if (eventName === 'Stop') {
    return preamble.concat([
      `RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/Stop" -H 'Content-Type: application/json' --max-time 10 -d @- 2>/dev/null)`,
      `printf '%s' "\${RESP:-}"`,
    ]).join('\n');
  }
  return preamble.concat([
    `curl -sf -X POST "http://127.0.0.1:$PORT/hooks/${eventName}" -H 'Content-Type: application/json' -d @- 2>/dev/null || true`,
  ]).join('\n');
}

/** Sidecar script the Windows hook command points at. The hook command in
 *  settings must contain no `$` (see `buildHookCommandWin`), so all logic
 *  lives in this on-disk script instead. Shares `~/.agentdeck/` with the
 *  Codex notify sidecar (`codex-notify.ps1`). */
export const DEFAULT_CLAUDE_HOOK_SCRIPT_PATH = join(homedir(), '.agentdeck', 'claude-hook.ps1');

/**
 * Body of the Windows hook sidecar (`claude-hook.ps1`). Invoked as
 * `powershell -File <path> <EventName>`; reads the hook JSON payload on
 * stdin and forwards it to the AgentDeck daemon. ASCII-only so PowerShell
 * 5.1's BOM-less ANSI fallback reads it identically to UTF-8. Exported for
 * tests and for the setup package's inlined copy.
 *
 * Port discovery matches the POSIX preamble minus the macOS App Store
 * sandbox paths (they don't exist on Windows):
 *
 *   1. `$env:AGENTDECK_PORT`
 *   2. `%USERPROFILE%\.agentdeck\daemon.json` (verified with `/health` probe)
 *   3. `9120` fallback
 *
 * PreToolUse (60s) and Stop (10s) are request-response — the daemon's reply
 * is echoed to stdout so Claude can gate the tool / continue with a queued
 * directive (parity with the POSIX `RESP=$(curl ...); printf '%s'` form).
 * The response is read from `RawContentStream` and written through a
 * BOM-less UTF-8 writer: `Invoke-RestMethod` would deserialize the JSON and
 * a BOM or OEM-codepage re-encode would corrupt the contract. All other
 * events are fire-and-forget. Errors are swallowed so a dead daemon never
 * blocks the host session.
 */
export function claudeHookScriptContent(): string {
  return [
    `# AgentDeck Claude Code hook sidecar - managed by @agentdeck/hooks, do not edit.`,
    `# Invoked as: powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <this> <EventName>`,
    `param([string]$EventName)`,
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `$port = $env:AGENTDECK_PORT`,
    `if ([string]::IsNullOrWhiteSpace($port)) {`,
    `  $daemonFile = Join-Path $env:USERPROFILE '.agentdeck\\daemon.json'`,
    `  if (Test-Path -LiteralPath $daemonFile) {`,
    `    try {`,
    `      $daemon = Get-Content -LiteralPath $daemonFile -Raw | ConvertFrom-Json`,
    `      $candidate = if ($daemon.httpPort) { $daemon.httpPort } else { $daemon.port }`,
    `      if ($candidate) {`,
    `        try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri ('http://127.0.0.1:' + $candidate + '/health') | Out-Null; $port = [string]$candidate } catch {}`,
    `      }`,
    `    } catch {}`,
    `  }`,
    `}`,
    `if ([string]::IsNullOrWhiteSpace($port)) { $port = '9120' }`,
    `# Read stdin as UTF-8: [Console]::In decodes piped stdin with the console OEM`,
    `# codepage (e.g. CP949), garbling non-ASCII payload text.`,
    `$body = (New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)).ReadToEnd()`,
    `# Post UTF-8 bytes: a string body is encoded as ISO-8859-1 when the content`,
    `# type carries no charset, replacing non-ASCII characters with '?'.`,
    `$bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$body)`,
    `$uri = 'http://127.0.0.1:' + $port + '/hooks/' + $EventName`,
    `if ($EventName -eq 'PreToolUse' -or $EventName -eq 'Stop') {`,
    `  # Request-response: echo the daemon's raw reply to stdout so Claude can gate`,
    `  # the tool (PreToolUse device approval) or continue with a turn-end directive`,
    `  # (Stop). PreToolUse waits out the daemon's approval hold; Stop runs on EVERY`,
    `  # turn end, so its timeout is short. Empty output = Claude's normal flow.`,
    `  $timeout = if ($EventName -eq 'PreToolUse') { 60 } else { 10 }`,
    `  try {`,
    `    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec $timeout -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $bytes`,
    `    if ($resp -and $resp.RawContentStream) {`,
    `      $text = [System.Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())`,
    `      if ($text.Length -gt 0) {`,
    `        $out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))`,
    `        $out.Write($text)`,
    `        $out.Flush()`,
    `      }`,
    `    }`,
    `  } catch {}`,
    `} else {`,
    `  try { Invoke-RestMethod -Method Post -TimeoutSec 2 -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $bytes | Out-Null } catch {}`,
    `}`,
    `exit 0`,
  ].join('\n') + '\n';
}

/**
 * Windows variant of `buildHookCommand`. Claude Code v2.1+ executes hook
 * commands through **git-bash** on Windows (not cmd.exe — verified
 * empirically on 2.1.173), so the command line must contain no `$` at all:
 * bash expands `$var` inside double quotes to empty before PowerShell ever
 * parses the script, which is an unrecoverable parse error. All logic
 * therefore lives in the on-disk sidecar (`claudeHookScriptContent`) and
 * the command is a bare `-File` pointer plus the event name as a positional
 * argument. The path is embedded with forward slashes (PowerShell accepts
 * them; backslash sequences are fragile under bash) and double-quoted for
 * user names containing spaces — double quotes are safe under bash, cmd.exe,
 * and PowerShell alike.
 */
export function buildHookCommandWin(
  eventName: string,
  scriptPath: string = DEFAULT_CLAUDE_HOOK_SCRIPT_PATH,
): string {
  const shellSafePath = scriptPath.replace(/\\/g, '/');
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${shellSafePath}" ${eventName}`;
}

/** Options threaded through the hook-writing entry points so tests are
 *  stable regardless of host OS (codex-install precedent). */
export interface HookBuildOptions {
  /** Override platform for tests. Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Override the Windows sidecar script path (tests). */
  scriptPath?: string;
}

/** True when a hook command is AgentDeck-owned (any generation: legacy
 *  hardcoded-port, POSIX preamble, old Windows inline one-liner, or the
 *  current Windows `-File` sidecar pointer — the sidecar form contains no
 *  `AGENTDECK_PORT` text, so the script filename is its marker). */
export function isAgentDeckHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return (
    command.includes('AGENTDECK_PORT') ||
    command.includes('localhost:9120') ||
    command.includes('claude-hook.ps1')
  );
}

// Claude Code v2.1+ requires 3-level nesting: event → matcher group → hook handler.
export function buildHookEntry(eventName: string, opts: HookBuildOptions = {}) {
  const platform = opts.platform ?? process.platform;
  const command = platform === 'win32'
    ? buildHookCommandWin(eventName, opts.scriptPath)
    : buildHookCommand(eventName);
  const handler: any = {
    type: 'command',
    command,
  };
  // Tool-specific hooks (PreToolUse, PostToolUse) need a glob matcher to fire.
  // Empty string "" means "match nothing" for tool events — use "" for non-tool
  // events (SessionStart, Stop, etc.) where matcher is ignored.
  const needsToolMatcher = ['PreToolUse', 'PostToolUse'].includes(eventName);
  return {
    matcher: needsToolMatcher ? '*' : '',
    hooks: [handler],
  };
}

/** Pure logic: apply AgentDeck hooks to a settings object (no file I/O). */
export function applyHooks(settings: any, opts: HookBuildOptions = {}): any {
  if (!settings.hooks) {
    settings.hooks = {};
  }
  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }
    // Remove every prior AgentDeck generation (flat, matcher-group, sidecar)
    settings.hooks[event] = settings.hooks[event].filter((h: any) => {
      if (isAgentDeckHookCommand(h.command)) {
        return false;
      }
      if (Array.isArray(h.hooks) && h.hooks.some((hh: any) => isAgentDeckHookCommand(hh.command))) {
        return false;
      }
      return true;
    });
    settings.hooks[event].push(buildHookEntry(event, opts));
  }
  return settings;
}

/** Pure logic: remove AgentDeck hooks from a settings object (no file I/O). */
export function removeHooks(settings: any): any {
  if (!settings.hooks) return settings;
  for (const event of HOOK_EVENTS) {
    if (settings.hooks[event]) {
      settings.hooks[event] = settings.hooks[event].filter((h: any) => {
        if (isAgentDeckHookCommand(h.command)) {
          return false;
        }
        if (Array.isArray(h.hooks) && h.hooks.some((hh: any) => isAgentDeckHookCommand(hh.command))) {
          return false;
        }
        return true;
      });
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  return settings;
}

/** Pure logic: migrate old hook formats to v2.1 matcher-group format. */
export function migrateHooks(settings: any): { settings: any; migrated: boolean } {
  let migrated = false;
  if (!settings.hooks) return { settings, migrated };

  for (const event of Object.keys(settings.hooks)) {
    const hooks = settings.hooks[event];
    if (!Array.isArray(hooks)) continue;
    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i];

      // Migration 1: hardcoded port → env var (flat format)
      if (hook.command?.includes('localhost:9120') && !hook.command?.includes('AGENTDECK_PORT')) {
        hook.command = hook.command.replace(
          /localhost:9120/g,
          'localhost:${AGENTDECK_PORT:-9120}',
        );
        migrated = true;
      }

      // Migration 2: flat format → matcher-group format
      if (hook.type === 'command' && hook.command?.includes('AGENTDECK_PORT') && !hook.hooks) {
        const handler: Record<string, unknown> = { type: hook.type, command: hook.command };
        hooks[i] = { matcher: '', hooks: [handler] };
        migrated = true;
      }

      // Migration 3: hardcoded port inside matcher-group
      if (Array.isArray(hook.hooks)) {
        for (const inner of hook.hooks) {
          if (inner.command?.includes('localhost:9120') && !inner.command?.includes('AGENTDECK_PORT')) {
            inner.command = inner.command.replace(
              /localhost:9120/g,
              'localhost:${AGENTDECK_PORT:-9120}',
            );
            migrated = true;
          }
        }
      }
    }
  }
  return { settings, migrated };
}

/** Options for the file-system entry points (overridable for tests). */
export interface HookFileOptions extends HookBuildOptions {
  /** Override the `.claude` directory (tests + non-default homes). */
  claudeDir?: string;
}

/** File-system wrapper: install hooks into ~/.claude/settings.local.json */
export function installHooks(opts: HookFileOptions = {}): void {
  const platform = opts.platform ?? process.platform;
  const scriptPath = opts.scriptPath ?? DEFAULT_CLAUDE_HOOK_SCRIPT_PATH;
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');

  // The Windows hook command is just a `-File` pointer — the sidecar must be
  // on disk before the settings reference it. A hook pointing at a missing
  // script is worse than no hook, so a failed write aborts the install.
  if (platform === 'win32' && !writeScriptIfChanged(claudeHookScriptContent(), scriptPath)) {
    throw new Error(`Failed to write hook sidecar script: ${scriptPath}`);
  }

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: any = {};
  if (existsSync(settingsPath)) {
    const content = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(content);
  }

  applyHooks(settings, { platform, scriptPath });

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Hooks installed to ${settingsPath}`);
}

/** File-system wrapper: uninstall hooks from ~/.claude/settings.local.json */
export function uninstallHooks(opts: HookFileOptions = {}): void {
  const scriptPath = opts.scriptPath ?? DEFAULT_CLAUDE_HOOK_SCRIPT_PATH;
  const settingsPath = join(opts.claudeDir ?? join(homedir(), '.claude'), 'settings.local.json');

  // The sidecar is AgentDeck-owned in its entirety — remove it best-effort.
  try { unlinkSync(scriptPath); } catch { /* absent or locked — fine */ }

  if (!existsSync(settingsPath)) return;

  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  removeHooks(settings);

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log('Hooks uninstalled');
}

/** File-system wrapper: migrate old hook formats in ~/.claude/settings.local.json.
 *  Silently catches errors to avoid breaking session startup. */
export function migrateHooksIfNeeded(opts: HookFileOptions = {}): void {
  try {
    const platform = opts.platform ?? process.platform;
    const scriptPath = opts.scriptPath ?? DEFAULT_CLAUDE_HOOK_SCRIPT_PATH;
    const settingsPath = join(opts.claudeDir ?? join(homedir(), '.claude'), 'settings.local.json');
    if (!existsSync(settingsPath)) return;

    const raw = readFileSync(settingsPath, 'utf-8');
    const hasAgentDeckHooks =
      raw.includes('AGENTDECK_PORT') || raw.includes('localhost:9120') || raw.includes('claude-hook.ps1');
    if (!hasAgentDeckHooks) return;

    // Keep the Windows sidecar current: the hook command on disk is only a
    // `-File` pointer, so script-content updates ship through this refresh
    // on every session start.
    if (platform === 'win32') {
      writeScriptIfChanged(claudeHookScriptContent(), scriptPath);
    }

    const settings = JSON.parse(raw);
    let { migrated } = migrateHooks(settings);
    const buildOpts = { platform, scriptPath };

    // Migration 4: upgrade hooks using simple :-9120 fallback to daemon.json-reading format.
    // This handles existing users from before daemon.json runtime lookup was added.
    // (`claude-hook.ps1` files contain neither marker — skip so migrated
    // Windows installs short-circuit.)
    if (raw.includes('AGENTDECK_PORT') && !raw.includes('daemon.json') && !raw.includes('claude-hook.ps1')) {
      applyHooks(settings, buildOpts);
      migrated = true;
    }

    // Migration 5: upgrade fire-and-forget Stop hooks to the request-response
    // form (turn-end directive queue needs the response echoed to Claude).
    if (
      raw.includes('/hooks/Stop') &&
      !/RESP=\$\(curl[^\n]*\/hooks\/Stop/.test(raw) &&
      !raw.includes('claude-hook.ps1')
    ) {
      applyHooks(settings, buildOpts);
      migrated = true;
    }

    // Migration 6 (win32): the pre-sidecar inline `-Command` one-liner is
    // bash-hostile — Claude Code executes hooks through git-bash, which
    // $-expands the embedded PowerShell variables to empty and produces an
    // unrecoverable parse error on every event. Rewrite to the `-File` form.
    if (platform === 'win32' && raw.includes('AGENTDECK_PORT') && !raw.includes('claude-hook.ps1')) {
      applyHooks(settings, buildOpts);
      migrated = true;
    }

    if (migrated) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  } catch {
    // Silently ignore — migration is best-effort, never block session startup
  }
}

// CLI execution
// Use pathToFileURL so the comparison is correct on Windows too — process.argv[1]
// is a native path (E:\dev\...\install.js), but import.meta.url is a file:// URL
// (file:///E:/dev/.../install.js). Manually building `file://${argv[1]}` only
// matches on POSIX, which is why the installer used to be a silent no-op on
// Windows.
import { pathToFileURL } from 'url';
const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMainModule) {
  const action = process.argv[2] || 'install';
  if (action === 'uninstall') {
    uninstallHooks();
    // The OpenCode observer plugin is AgentDeck-owned in its entirety, so
    // uninstall removes the file (unlike ~/.codex/config.toml, where only
    // the fenced block is AgentDeck's and removal has its own dedicated
    // flow to avoid touching user TOML).
    import('./opencode-install.js').then((m) => m.uninstallOpenCodeHooks()).catch(() => {});
  } else {
    installHooks();
  }
}
