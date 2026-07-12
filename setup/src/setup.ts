#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// ─── Colors ──────────────────────────────────────────────────────────

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const NC = '\x1b[0m';

function info(msg: string) { console.log(`${BLUE}[INFO]${NC} ${msg}`); }
function ok(msg: string) { console.log(`${GREEN}[OK]${NC} ${msg}`); }
function warn(msg: string) { console.log(`${YELLOW}[WARN]${NC} ${msg}`); }
function fail(msg: string) { console.log(`${RED}[FAIL]${NC} ${msg}`); }

const IS_WIN = process.platform === 'win32';

function which(cmd: string): string | null {
  try {
    // `where` on Windows can print multiple lines (one per match); take the first.
    const probe = IS_WIN ? `where ${cmd}` : `which ${cmd}`;
    const out = execSync(probe, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

// ─── 1. Banner ───────────────────────────────────────────────────────

function banner() {
  console.log('');
  console.log('=========================================');
  console.log('  AgentDeck Setup');
  console.log('=========================================');
  console.log('');
}

// ─── 2. Prerequisites ────────────────────────────────────────────────

function checkPrerequisites(): boolean {
  let pass = true;

  // Node.js >= 22
  const major = parseInt(process.version.replace('v', '').split('.')[0], 10);
  if (major >= 22) {
    ok(`Node.js ${process.version}`);
  } else {
    fail(`Node.js ${process.version} — version 22+ required (Node 20 EOL April 2026)`);
    pass = false;
  }

  // Xcode Command Line Tools — required because `npm install -g @agentdeck/bridge`
  // below sets `npm_config_build_from_source=true` (see installBridge). Without
  // CLT the node-pty source build fails with a cryptic compiler-missing error
  // deep inside node-gyp. Catch it here with a clear message so the user
  // knows the one command to run.
  // Windows uses node-pty's prebuilt binary (no source build), so this check
  // is darwin-only.
  if (!IS_WIN) {
    if (which('xcode-select') && checkXcodeCliTools()) {
      ok('Xcode Command Line Tools installed');
    } else {
      fail('Xcode Command Line Tools not installed — required to build node-pty from source.');
      console.log(`       Install with: ${YELLOW}xcode-select --install${NC}`);
      console.log('       After the installer finishes, re-run `npx @agentdeck/setup`.');
      pass = false;
    }
  }

  const hasClaude = Boolean(which('claude'));
  const hasCodex = Boolean(which('codex'));

  // At least one supported coding-agent CLI is needed for a useful local setup.
  if (hasClaude) {
    ok('Claude Code CLI found');
  } else {
    warn('Claude Code CLI not found — Claude sessions will be unavailable');
    console.log('     Install with: npm install -g @anthropic-ai/claude-code');
  }

  if (hasCodex) {
    ok('Codex CLI found');
  } else {
    warn('Codex CLI not found — Codex sessions will be unavailable');
  }

  if (!hasClaude && !hasCodex) {
    fail('No supported coding-agent CLI found — install Claude Code or Codex before running AgentDeck.');
    pass = false;
  }

  // Stream Deck app — paths differ per OS
  const streamDeckPaths = IS_WIN
    ? [
        join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Elgato', 'StreamDeck', 'StreamDeck.exe'),
        join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Elgato', 'StreamDeck', 'StreamDeck.exe'),
        join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Elgato', 'StreamDeck', 'StreamDeck.exe'),
      ]
    : ['/Applications/Elgato Stream Deck.app', '/Applications/Stream Deck.app'];
  if (streamDeckPaths.some((p) => existsSync(p))) {
    ok('Stream Deck app installed');
  } else {
    fail('Stream Deck app not found — download from https://www.elgato.com/downloads');
    pass = false;
  }

  if (!pass) {
    console.log('');
    fail('Required dependencies missing. Please install them and re-run.');
  }

  return pass;
}

/// Returns true when `xcode-select -p` reports a valid developer directory.
/// On macOS without CLT installed the command exits non-zero and prints
/// a system dialog prompting the user to install; we treat both as "missing".
function checkXcodeCliTools(): boolean {
  try {
    const path = execSync('xcode-select -p', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // `xcode-select -p` returns the dev dir path even if the user cancelled
    // the install prompt — verify the path actually exists on disk.
    return path.length > 0 && existsSync(path);
  } catch {
    return false;
  }
}

// ─── 3. Stream Deck CLI ──────────────────────────────────────────────

function installStreamDeckCli() {
  if (which('streamdeck')) {
    ok('Stream Deck CLI found');
    return;
  }

  info('Installing Stream Deck CLI (@elgato/cli)...');
  execSync('npm install -g @elgato/cli', { stdio: 'inherit' });
  ok('Stream Deck CLI installed');
}

// ─── 4. Install Bridge (agentdeck CLI) ──────────────────────────────

function installBridge() {
  info('Installing AgentDeck bridge (@agentdeck/bridge)...');
  // Force source build of node-pty on macOS to avoid prebuilt binary ABI
  // mismatch (see #3). On Windows we rely on node-pty's prebuilt binary —
  // forcing a source build would require Visual Studio Build Tools, which
  // is a much larger prereq than we want.
  const env = IS_WIN
    ? { ...process.env }
    : { ...process.env, npm_config_build_from_source: 'true' };
  execSync('npm install -g @agentdeck/bridge', {
    stdio: 'inherit',
    env,
  });

  if (which('agentdeck')) {
    ok('agentdeck CLI installed');
  } else {
    fail('agentdeck CLI not found after install — check npm global path');
    process.exit(1);
  }
}

// ─── 5. Install Hooks (inlined from @agentdeck/hooks) ────────────────

const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'UserPromptSubmit',
] as const;

/**
 * Kept byte-identical with `@agentdeck/hooks` `buildHookCommand`
 * (hooks/src/install.ts — canonical commentary lives there) and the Swift
 * `HookInstaller.buildHookEntry` snippet. Any change here MUST be mirrored
 * in those two places, otherwise users installing via different paths end
 * up with inconsistent daemon discovery. The same triple-sync rule applies
 * to `claudeHookScriptContent` / `buildHookCommandWin` below.
 */
function buildHookCommand(eventName: string): string {
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
  // PreToolUse long-poll (device approval) — see canonical commentary in hooks/src/install.ts.
  if (eventName === 'PreToolUse') {
    return preamble.concat([
      `RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/PreToolUse" -H 'Content-Type: application/json' --max-time 60 -d @- 2>/dev/null)`,
      `printf '%s' "\${RESP:-}"`,
    ]).join('\n');
  }
  // Stop is request-response too (turn-end directive queue) — short --max-time
  // since it runs on every turn end. See hooks/src/install.ts.
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

/** Windows sidecar script path — kept in sync with `@agentdeck/hooks`
 *  `DEFAULT_CLAUDE_HOOK_SCRIPT_PATH`. */
const CLAUDE_HOOK_SCRIPT_PATH = join(homedir(), '.agentdeck', 'claude-hook.ps1');

/** Windows sidecar body — kept byte-identical with `@agentdeck/hooks`
 *  `claudeHookScriptContent` (canonical commentary in hooks/src/install.ts).
 *  The hook command in settings must contain no `$` (Claude Code executes
 *  hooks through git-bash on Windows, which $-expands inline PowerShell to
 *  garbage), so all logic lives in this on-disk script. */
function claudeHookScriptContent(): string {
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

/** Minimal copy of `@agentdeck/hooks` `writeScriptIfChanged` (atomic
 *  temp+rename, no-op when content is unchanged). */
function writeScriptIfChanged(content: string, path: string): boolean {
  try {
    if (existsSync(path) && readFileSync(path, 'utf-8') === content) return true;
  } catch { /* unreadable — fall through to rewrite */ }
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.agentdeck.tmp`;
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Windows variant — kept in sync with `@agentdeck/hooks` `buildHookCommandWin`.
 *  A bare `-File` pointer with the event name as positional argument: no `$`
 *  on the command line (git-bash safe), forward-slash path (PowerShell accepts
 *  it), double-quoted for user names with spaces. */
function buildHookCommandWin(eventName: string): string {
  const shellSafePath = CLAUDE_HOOK_SCRIPT_PATH.replace(/\\/g, '/');
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${shellSafePath}" ${eventName}`;
}

function buildHookEntry(eventName: string) {
  const needsToolMatcher = ['PreToolUse', 'PostToolUse'].includes(eventName);
  const command = IS_WIN ? buildHookCommandWin(eventName) : buildHookCommand(eventName);
  return {
    matcher: needsToolMatcher ? '*' : '',
    hooks: [
      {
        type: 'command',
        command,
      },
    ],
  };
}

function installHooks() {
  if (!which('claude')) {
    warn('Skipping Claude Code hooks because `claude` is not installed');
    return;
  }

  info('Installing Claude Code hooks...');

  // The Windows hook command is just a `-File` pointer — the sidecar must be
  // on disk before the settings reference it.
  if (IS_WIN && !writeScriptIfChanged(claudeHookScriptContent(), CLAUDE_HOOK_SCRIPT_PATH)) {
    fail(`Could not write hook sidecar script: ${CLAUDE_HOOK_SCRIPT_PATH}`);
    return;
  }

  const claudeDir = join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: any = {};
  if (existsSync(settingsPath)) {
    const content = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(content);
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Remove existing AgentDeck hooks (old flat + matcher format + the
    // Windows `-File` sidecar form, whose marker is the script filename)
    const isAgentDeckCommand = (cmd: unknown) =>
      typeof cmd === 'string' &&
      (cmd.includes('AGENTDECK_PORT') || cmd.includes('localhost:9120') || cmd.includes('claude-hook.ps1'));
    settings.hooks[event] = settings.hooks[event].filter((h: any) => {
      if (isAgentDeckCommand(h.command)) {
        return false;
      }
      if (Array.isArray(h.hooks) && h.hooks.some((hh: any) => isAgentDeckCommand(hh.command))) {
        return false;
      }
      return true;
    });

    settings.hooks[event].push(buildHookEntry(event));
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  ok(`Hooks installed to ${settingsPath}`);
}

// ─── 6. Data directory ───────────────────────────────────────────────

function ensureDataDir() {
  const dir = join(homedir(), '.agentdeck');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    ok('Created ~/.agentdeck/');
  }
}

// ─── 6b. Seed compatibility state ────────────────────────────────────

function seedCompatibility() {
  const compatPath = join(homedir(), '.agentdeck', 'compatibility.json');
  if (existsSync(compatPath)) return;
  try {
    const claudeVer = execSync('claude --version', { encoding: 'utf-8', timeout: 5000 })
      .trim()
      .match(/^([\d.]+)/)?.[1];
    let bridgeVer: string | null = null;
    try {
      const list = JSON.parse(
        execSync('npm list -g @agentdeck/bridge --json 2>/dev/null', { encoding: 'utf-8' }),
      );
      bridgeVer = list?.dependencies?.['@agentdeck/bridge']?.version ?? null;
    } catch { /* not installed globally yet */ }
    if (claudeVer) {
      writeFileSync(
        compatPath,
        JSON.stringify(
          {
            lastClaudeCodeVersion: claudeVer,
            lastAgentDeckVersion: bridgeVer,
            lastCheckTime: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
      );
      ok('Compatibility state initialized');
    }
  } catch { /* non-critical */ }
}

// ─── 7. Optional dependencies ────────────────────────────────────────

function checkOptionalDeps() {
  console.log('');
  console.log('----- Optional Dependencies -----');

  if (IS_WIN) {
    // Voice input (sox/whisper) on AgentDeck currently targets macOS only.
    // Skip the prompts on Windows so the user isn't told to run `brew`.
    warn('Voice input (sox + whisper.cpp) is macOS-only — skipped.');
    return;
  }

  if (which('sox') || which('rec')) {
    ok('sox installed (voice recording)');
  } else {
    warn('sox not found — voice input won\'t work');
    console.log('     Install with: brew install sox');
  }

  if (which('whisper-cli') || which('whisper')) {
    ok('whisper.cpp installed (voice transcription)');
  } else {
    warn('whisper.cpp not found — voice transcription won\'t work');
    console.log('     Install with: brew install whisper-cpp');
    console.log('     Then download model: whisper-cli --download-model large-v3-turbo');
  }
}

// ─── 8. Success ──────────────────────────────────────────────────────

function success() {
  console.log('');
  console.log('=========================================');
  console.log('  Setup Complete!');
  console.log('=========================================');
  console.log('');
  console.log('  Next steps:');
  console.log('  1. Restart Stream Deck app');
  console.log('  2. Add AgentDeck actions to your Stream Deck profile');
  console.log("  3. Run 'agentdeck claude' or 'agentdeck codex' in terminal to start the bridge");
  console.log("     Codex observation hooks are installed automatically by 'agentdeck codex'");
  console.log("  4. Optional: run 'agentdeck daemon install' to auto-start the daemon on login");
  console.log("     (macOS LaunchAgent / Windows Scheduled Task)");
  console.log('');
  console.log('  Usage:');
  console.log('    agentdeck claude   Start bridge + Claude');
  console.log('    agentdeck codex    Start bridge + Codex');
  console.log('    agentdeck status   Check status');
  console.log('    agentdeck stop     Stop bridge');
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  banner();

  if (!checkPrerequisites()) {
    process.exit(1);
  }

  console.log('');
  installStreamDeckCli();
  console.log('');
  installBridge();
  console.log('');
  installHooks();
  ensureDataDir();
  seedCompatibility();
  checkOptionalDeps();
  success();
}

main().catch((err) => {
  fail(`Unexpected error: ${err.message}`);
  process.exit(1);
});
