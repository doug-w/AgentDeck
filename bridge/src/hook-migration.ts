// Thin delegation to the canonical Claude hook installer in @agentdeck/hooks.
//
// This file previously carried its own divergent copy of the migration
// logic: it targeted the legacy ~/.claude/settings.local.json (which Claude
// Code only reads for home-directory sessions), lacked Migration 5 (Stop
// request-response), and had no win32 branch — its applyHooks wrote the
// POSIX bash command unconditionally. Delegating keeps every `agentdeck
// claude` session start on the one migration path, including the
// local→global settings.json move.
import { migrateHooksIfNeeded as canonicalMigrateHooksIfNeeded } from '@agentdeck/hooks';

export function migrateHooksIfNeeded(): void {
  try {
    canonicalMigrateHooksIfNeeded();
  } catch {
    // Best effort only; hook migration must not block session startup.
  }
}
