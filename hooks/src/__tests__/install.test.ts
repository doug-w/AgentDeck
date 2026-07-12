import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  HOOK_EVENTS,
  buildHookCommand,
  buildHookCommandWin,
  buildHookEntry,
  claudeHookScriptContent,
  isAgentDeckHookCommand,
  applyHooks,
  removeHooks,
  migrateHooks,
  installHooks,
  uninstallHooks,
  migrateHooksIfNeeded,
} from '../install.js';

describe('Hook Installer', () => {
  describe('buildHookEntry', () => {
    it('creates matcher-group format with AGENTDECK_PORT env var (POSIX)', () => {
      const entry = buildHookEntry('SessionStart', { platform: 'linux' });
      expect(entry.matcher).toBe('');
      expect(entry.hooks).toHaveLength(1);
      expect(entry.hooks[0].type).toBe('command');
      expect(entry.hooks[0].command).toContain('AGENTDECK_PORT');
      expect(entry.hooks[0].command).toContain('SessionStart');
      expect(entry.hooks[0].command).toContain('/hooks/');
    });

    it('emits the `-File` sidecar pointer on win32', () => {
      const entry = buildHookEntry('SessionStart', { platform: 'win32' });
      expect(entry.hooks[0].command).toContain('claude-hook.ps1');
      expect(entry.hooks[0].command).toContain('SessionStart');
    });

    it('uses `*` matcher for tool events and empty matcher for lifecycle events', () => {
      expect(buildHookEntry('PreToolUse').matcher).toBe('*');
      expect(buildHookEntry('PostToolUse').matcher).toBe('*');
      expect(buildHookEntry('Stop').matcher).toBe('');
      expect(buildHookEntry('SessionStart').matcher).toBe('');
    });
  });

  describe('buildHookCommand (POSIX)', () => {
    it('reads PORT from AGENTDECK_PORT env var first, then daemon.json, then 9120', () => {
      const cmd = buildHookCommand('SessionStart');
      // Priority chain: AGENTDECK_PORT → ~/.agentdeck/daemon.json → App Store sandbox daemon.json → legacy group daemon.json → 9120
      expect(cmd).toContain('PORT="${AGENTDECK_PORT:-}"');
      expect(cmd).toContain('.agentdeck/daemon.json');
      expect(cmd).toContain('Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json');
      expect(cmd).toContain('group.bound.serendipity.agent.deck/daemon.json');
      expect(cmd).toContain('${PORT:-9120}');
      expect(cmd).toContain('curl -sf -X POST "http://127.0.0.1:$PORT/hooks/SessionStart"');
    });

    it('emits newline-separated shell so if/then/for/do keywords are not mis-terminated by `;`', () => {
      const cmd = buildHookCommand('SessionStart');
      // Regression guard: `; then;` / `; do;` is a zsh-only oddity that fails under
      // sh/bash — Claude Code runs hooks via /bin/sh so the joined output must
      // use newlines between statements.
      expect(cmd).not.toMatch(/;\s*then\s*;/);
      expect(cmd).not.toMatch(/;\s*do\s*;/);
      expect(cmd).toContain('\n');
    });
  });

  describe('buildHookCommandWin (Windows)', () => {
    it('emits a bare -File pointer to the sidecar with the event name as argument', () => {
      const cmd = buildHookCommandWin('SessionStart', 'C:\\Users\\Doug Warren\\.agentdeck\\claude-hook.ps1');
      expect(cmd).toBe(
        'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:/Users/Doug Warren/.agentdeck/claude-hook.ps1" SessionStart',
      );
    });

    it('contains no `$` — Claude Code executes hooks through git-bash, which $-expands inline PowerShell to garbage', () => {
      for (const event of HOOK_EVENTS) {
        const cmd = buildHookCommandWin(event);
        expect(cmd).not.toContain('$');
        expect(cmd).not.toContain('-Command');
        expect(cmd).not.toContain('\n');
        expect(/^[\x00-\x7F]*$/.test(cmd)).toBe(true);
      }
    });

    it('embeds the path with forward slashes and double quotes (bash/cmd/PowerShell-safe)', () => {
      const cmd = buildHookCommandWin('Stop');
      expect(cmd).not.toContain('\\');
      expect(cmd).toMatch(/-File "[^"]+\/claude-hook\.ps1" Stop$/);
    });
  });

  describe('claudeHookScriptContent (Windows sidecar)', () => {
    const script = claudeHookScriptContent();

    it('resolves the port via AGENTDECK_PORT, then daemon.json + /health probe, then 9120', () => {
      expect(script).toContain('param([string]$EventName)');
      expect(script).toContain('$env:AGENTDECK_PORT');
      expect(script).toContain(".agentdeck\\daemon.json");
      expect(script).toContain('/health');
      expect(script).toContain("$port = '9120'");
      // No macOS App Store sandbox-container paths on Windows.
      expect(script).not.toContain('Library/Containers/bound.serendipity');
      expect(script).not.toContain('group.bound.serendipity');
    });

    it('reads stdin as UTF-8 and posts UTF-8 bytes with charset (#46)', () => {
      expect(script).toContain('StreamReader([Console]::OpenStandardInput()');
      expect(script).toContain('[System.Text.Encoding]::UTF8');
      expect(script).not.toContain('[Console]::In.ReadToEnd()');
      expect(script).toContain('[System.Text.Encoding]::UTF8.GetBytes');
      expect(script).toContain('application/json; charset=utf-8');
    });

    it('handles PreToolUse/Stop as request-response with raw BOM-less stdout echo', () => {
      // Timeouts mirror POSIX: PreToolUse 60s (device-approval hold), Stop 10s
      // (runs on every turn end — must never stall the TUI).
      expect(script).toContain("if ($EventName -eq 'PreToolUse') { 60 } else { 10 }");
      // Raw bytes out of RawContentStream — Invoke-RestMethod would deserialize
      // the JSON reply and corrupt the stdout contract.
      expect(script).toContain('Invoke-WebRequest -UseBasicParsing -Method Post');
      expect(script).toContain('RawContentStream.ToArray()');
      // BOM-less UTF-8 writer — a BOM before the JSON breaks Claude's parser.
      expect(script).toContain('System.Text.UTF8Encoding($false)');
      // Fire-and-forget for everything else, short timeout.
      expect(script).toContain('Invoke-RestMethod -Method Post -TimeoutSec 2');
    });

    it('is ASCII-only, LF-separated, silently-erroring, and ends with exit 0', () => {
      expect(/^[\x00-\x7F]*$/.test(script)).toBe(true);
      expect(script).not.toContain('\r');
      expect(script).toContain("$ErrorActionPreference = 'SilentlyContinue'");
      expect(script.trimEnd().endsWith('exit 0')).toBe(true);
      expect(script.endsWith('\n')).toBe(true);
    });
  });

  describe('isAgentDeckHookCommand', () => {
    it('recognises every AgentDeck command generation', () => {
      expect(isAgentDeckHookCommand(buildHookCommand('SessionStart'))).toBe(true);
      expect(isAgentDeckHookCommand(buildHookCommandWin('SessionStart'))).toBe(true);
      // Legacy hardcoded-port generation.
      expect(isAgentDeckHookCommand('curl -sf http://localhost:9120/hooks/Stop')).toBe(true);
      // Pre-sidecar Windows inline one-liner.
      expect(isAgentDeckHookCommand('powershell -NoProfile -Command "$port=$env:AGENTDECK_PORT; ..."')).toBe(true);
    });

    it('rejects user hooks and non-strings', () => {
      expect(isAgentDeckHookCommand('echo "custom hook"')).toBe(false);
      expect(isAgentDeckHookCommand('powershell -File "C:/my/own-hook.ps1"')).toBe(false);
      expect(isAgentDeckHookCommand(undefined)).toBe(false);
      expect(isAgentDeckHookCommand(42)).toBe(false);
    });
  });

  describe('applyHooks', () => {
    it('installs hooks to empty settings in matcher-group format', () => {
      const result = applyHooks({}, { platform: 'linux' });
      expect(result.hooks).toBeDefined();
      expect(Object.keys(result.hooks)).toHaveLength(HOOK_EVENTS.length);

      for (const event of HOOK_EVENTS) {
        expect(result.hooks[event]).toHaveLength(1);
        const group = result.hooks[event][0];
        const expectStar = ['PreToolUse', 'PostToolUse'].includes(event);
        expect(group.matcher).toBe(expectStar ? '*' : '');
        expect(group.hooks).toHaveLength(1);
        expect(group.hooks[0].command).toContain('AGENTDECK_PORT');
        expect(group.hooks[0].command).toContain(event);
      }
    });

    it('installs sidecar-pointer hooks on win32', () => {
      const result = applyHooks({}, { platform: 'win32' });
      for (const event of HOOK_EVENTS) {
        expect(result.hooks[event]).toHaveLength(1);
        const cmd = result.hooks[event][0].hooks[0].command;
        expect(cmd).toContain('claude-hook.ps1');
        expect(cmd.endsWith(` ${event}`)).toBe(true);
      }
    });

    it('preserves non-AgentDeck hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            { matcher: 'custom', hooks: [{ type: 'command', command: 'echo "custom hook"' }] },
          ],
        },
      };
      const result = applyHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(2);
      expect(result.hooks.SessionStart[0].hooks[0].command).toBe('echo "custom hook"');
    });

    it('replaces old flat-format hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            {
              type: 'command',
              command: 'curl -sf -X POST http://localhost:9120/hooks/SessionStart ...',
            },
          ],
        },
      };
      const result = applyHooks(settings, { platform: 'linux' });
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].hooks[0].command).toContain('AGENTDECK_PORT');
    });

    it('replaces old matcher-format hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'curl -sf http://localhost:9120/hooks/SessionStart' }],
            },
          ],
        },
      };
      const result = applyHooks(settings, { platform: 'linux' });
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].hooks[0].command).toContain('AGENTDECK_PORT');
    });

    it('is idempotent — running twice produces same result', () => {
      const first = applyHooks({});
      const second = applyHooks(JSON.parse(JSON.stringify(first)));

      for (const event of HOOK_EVENTS) {
        expect(second.hooks[event]).toHaveLength(1);
      }
    });

    it('is idempotent on win32 — the sidecar command is recognised as AgentDeck-owned', () => {
      // Regression guard for the predicate: the `-File` command contains no
      // `AGENTDECK_PORT` text, so recognition rides on the script filename.
      const first = applyHooks({}, { platform: 'win32' });
      const second = applyHooks(JSON.parse(JSON.stringify(first)), { platform: 'win32' });

      for (const event of HOOK_EVENTS) {
        expect(second.hooks[event]).toHaveLength(1);
      }
    });

    it('replaces the pre-sidecar Windows inline one-liner (win32 → win32 upgrade)', () => {
      const settings = {
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [{
                type: 'command',
                command: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$ev=\'SessionStart\'; $port=$env:AGENTDECK_PORT; ..."',
              }],
            },
          ],
        },
      };
      const result = applyHooks(settings, { platform: 'win32' });
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].hooks[0].command).toContain('claude-hook.ps1');
    });

    it('preserves existing non-hook settings', () => {
      const settings = { permissions: { allow: true }, other: 'value' };
      const result = applyHooks(settings);
      expect(result.permissions).toEqual({ allow: true });
      expect(result.other).toBe('value');
    });
  });

  describe('removeHooks', () => {
    it('removes all AgentDeck hooks (new format)', () => {
      const installed = applyHooks({});
      const result = removeHooks(installed);
      expect(result.hooks).toBeUndefined();
    });

    it('removes old flat-format AgentDeck hooks', () => {
      const settings = {
        hooks: {
          PreToolUse: [
            { type: 'command', command: 'curl -sf http://localhost:9120/hooks/PreToolUse ...' },
          ],
        },
      };
      const result = removeHooks(settings);
      expect(result.hooks).toBeUndefined();
    });

    it('preserves non-AgentDeck hooks', () => {
      const settings = applyHooks({});
      settings.hooks.SessionStart.unshift({
        matcher: 'custom',
        hooks: [{ type: 'command', command: 'echo "keep me"' }],
      });
      const result = removeHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].hooks[0].command).toBe('echo "keep me"');
    });

    it('handles empty settings gracefully', () => {
      const result = removeHooks({});
      expect(result.hooks).toBeUndefined();
    });
  });

  describe('migrateHooks', () => {
    it('migrates old hardcoded port to env var', () => {
      const settings = {
        hooks: {
          SessionStart: [
            {
              type: 'command',
              command:
                "curl -sf -X POST http://localhost:9120/hooks/SessionStart -H 'Content-Type: application/json' -d @- 2>/dev/null || true",
            },
          ],
        },
      };
      const { settings: migrated, migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(true);
      // Should be migrated to matcher-group format
      expect(migrated.hooks.SessionStart[0].hooks).toBeDefined();
      expect(migrated.hooks.SessionStart[0].hooks[0].command).toContain('AGENTDECK_PORT');
    });

    it('migrates flat format to matcher-group format', () => {
      const settings = {
        hooks: {
          PreToolUse: [
            {
              type: 'command',
              command: "curl -sf -X POST http://localhost:${AGENTDECK_PORT:-9120}/hooks/PreToolUse ...",
            },
          ],
        },
      };
      const { settings: migrated, migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(true);
      expect(migrated.hooks.PreToolUse[0].matcher).toBe('');
      expect(migrated.hooks.PreToolUse[0].hooks[0].command).toContain('AGENTDECK_PORT');
    });

    it('skips already-migrated hooks (new format)', () => {
      const settings = applyHooks({});
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(false);
    });

    it('skips non-AgentDeck hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo "unrelated"' }] },
          ],
        },
      };
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(false);
    });

    it('migrates multiple events at once', () => {
      const settings: any = { hooks: {} };
      for (const event of HOOK_EVENTS) {
        settings.hooks[event] = [
          {
            type: 'command',
            command: `curl -sf -X POST http://localhost:9120/hooks/${event} ...`,
          },
        ];
      }
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(true);
      for (const event of HOOK_EVENTS) {
        expect(settings.hooks[event][0].hooks).toBeDefined();
        expect(settings.hooks[event][0].hooks[0].command).toContain('AGENTDECK_PORT');
      }
    });

    it('migrates hardcoded port inside matcher-group', () => {
      const settings = {
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [{
                type: 'command',
                command: "curl -sf http://localhost:9120/hooks/Stop ...",
              }],
            },
          ],
        },
      };
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(true);
      expect(settings.hooks.Stop[0].hooks[0].command).toContain('AGENTDECK_PORT');
      expect(settings.hooks.Stop[0].hooks[0].command).not.toContain('localhost:9120');
    });
  });

  describe('migrateHooksIfNeeded (file-based)', () => {
    it('upgrades old :-9120 fallback hooks to daemon.json-reading format', () => {
      // The new format should contain daemon.json instead of the old :-9120 fallback.
      // Test the POSIX builder directly so the assertion shape is stable regardless of
      // host OS — `applyHooks` picks the platform variant.
      const newCmd = buildHookCommand('SessionStart');
      expect(newCmd).toContain('daemon.json');
      expect(newCmd).not.toContain('${AGENTDECK_PORT:-9120}');
      expect(newCmd).toContain('$PORT');
    });
  });
});

describe('steering hook channels (request-response)', () => {
  it('PreToolUse and Stop echo the daemon response to stdout; others stay fire-and-forget', () => {
    const pre = buildHookCommand('PreToolUse');
    expect(pre).toContain('RESP=$(curl');
    expect(pre).toContain("printf '%s'");

    const stop = buildHookCommand('Stop');
    expect(stop).toContain('RESP=$(curl');
    expect(stop).toContain("printf '%s'");
    // Runs on EVERY turn end — short timeout so a wedged daemon can't stall the TUI.
    expect(stop).toContain('--max-time 10');

    const notif = buildHookCommand('Notification');
    expect(notif).not.toContain('RESP=');
    expect(notif).toContain('|| true');
  });

  it('migration 5 upgrades fire-and-forget Stop hooks to request-response', () => {
    const legacyStopCommand = [
      'PORT="${AGENTDECK_PORT:-}"',
      '# daemon.json lookup elided',
      'curl -sf -X POST "http://127.0.0.1:$PORT/hooks/Stop" -H \'Content-Type: application/json\' -d @- 2>/dev/null || true',
    ].join('\n');
    const settings = {
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: legacyStopCommand }] }],
      },
    };
    const raw = JSON.stringify(settings);
    // Same predicate migrateHooksIfNeeded uses to decide on a rewrite.
    expect(raw.includes('/hooks/Stop') && !/RESP=\$\(curl[^\n]*\/hooks\/Stop/.test(raw)).toBe(true);

    applyHooks(settings, { platform: 'linux' });
    const stopCmd = (settings.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((h) => h.hooks).map((h) => h.command).join('\n');
    expect(stopCmd).toContain('RESP=$(curl');
    expect(stopCmd).toContain('/hooks/Stop');
  });
});

describe('file-based install/uninstall/migrate (win32 sidecar)', () => {
  let dir: string;

  function tmp(): { claudeDir: string; scriptPath: string; settingsPath: string } {
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-hooks-test-'));
    const claudeDir = join(dir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    return {
      claudeDir,
      scriptPath: join(dir, '.agentdeck', 'claude-hook.ps1'),
      settingsPath: join(claudeDir, 'settings.local.json'),
    };
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('installHooks writes the sidecar before referencing it and installs -File hooks', () => {
    const { claudeDir, scriptPath, settingsPath } = tmp();
    installHooks({ claudeDir, scriptPath, platform: 'win32' });

    expect(existsSync(scriptPath)).toBe(true);
    expect(readFileSync(scriptPath, 'utf-8')).toBe(claudeHookScriptContent());

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    for (const event of HOOK_EVENTS) {
      const cmd = settings.hooks[event][0].hooks[0].command;
      expect(cmd).toContain(scriptPath.replace(/\\/g, '/'));
      expect(cmd).not.toContain('$');
    }
  });

  it('installHooks skips the sidecar on POSIX', () => {
    const { claudeDir, scriptPath, settingsPath } = tmp();
    installHooks({ claudeDir, scriptPath, platform: 'linux' });

    expect(existsSync(scriptPath)).toBe(false);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('AGENTDECK_PORT');
  });

  it('uninstallHooks removes the hooks and deletes the sidecar, preserving user content', () => {
    const { claudeDir, scriptPath, settingsPath } = tmp();
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(ls *)'] } }, null, 2));
    installHooks({ claudeDir, scriptPath, platform: 'win32' });

    uninstallHooks({ claudeDir, scriptPath, platform: 'win32' });

    expect(existsSync(scriptPath)).toBe(false);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeUndefined();
    expect(settings.permissions).toEqual({ allow: ['Bash(ls *)'] });
  });

  it('Migration 6: migrateHooksIfNeeded rewrites the bash-hostile inline one-liner to -File form', () => {
    const { claudeDir, scriptPath, settingsPath } = tmp();
    const legacyWinCommand =
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "$ev=\'Stop\'; $port=$env:AGENTDECK_PORT; ' +
      'if(-not $port){$f=Join-Path $env:USERPROFILE \'.agentdeck\\daemon.json\'; ...}; ' +
      'try{Invoke-RestMethod -Uri (\'http://127.0.0.1:\'+$port+\'/hooks/\'+$ev) ...}catch{}"';
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: legacyWinCommand }] }] },
    }, null, 2));

    migrateHooksIfNeeded({ claudeDir, scriptPath, platform: 'win32' });

    expect(existsSync(scriptPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const stopCmd = settings.hooks.Stop[0].hooks[0].command;
    expect(stopCmd).toContain('claude-hook.ps1');
    expect(stopCmd).not.toContain('$');
  });

  it('migrateHooksIfNeeded refreshes stale sidecar content and no-ops on current files', () => {
    const { claudeDir, scriptPath, settingsPath } = tmp();
    installHooks({ claudeDir, scriptPath, platform: 'win32' });
    const installed = readFileSync(settingsPath, 'utf-8');
    writeFileSync(scriptPath, '# stale old script\n');

    migrateHooksIfNeeded({ claudeDir, scriptPath, platform: 'win32' });

    // Sidecar refreshed to current content; settings byte-identical (no churn).
    expect(readFileSync(scriptPath, 'utf-8')).toBe(claudeHookScriptContent());
    expect(readFileSync(settingsPath, 'utf-8')).toBe(installed);
  });

  it('migrateHooksIfNeeded leaves non-AgentDeck settings files untouched', () => {
    const { claudeDir, scriptPath, settingsPath } = tmp();
    const original = JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }] } }, null, 2);
    writeFileSync(settingsPath, original);

    migrateHooksIfNeeded({ claudeDir, scriptPath, platform: 'win32' });

    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
    expect(existsSync(scriptPath)).toBe(false);
  });
});
