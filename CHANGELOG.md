# Changelog

## [0.3.0]

### Changed
- **Simplified sanitization.** Replaced 700-line 3-pass redaction engine (gitleaks-style regex patterns, entropy analysis, connection string scanning) with field-level drops and truncation. User message text truncated to 100 chars. Edit/write content dropped. Bash commands truncated to 100 chars (preserving useful signal like "bun test" while limiting exposure).
- **Removed meta.json.** Plugin no longer creates or manages `meta.json` in the storage directory. Storage init creates only the directory and `.gitignore`.
- **Removed project-id detection.** No more `execSync` calls to git during plugin init. Eliminates 3-6 second timeout risk on slow/missing git.
- **Inlined safeExecute.** Moved from separate module into `index.ts`.
- **Byte-counter rotation.** File rotation now uses an in-memory byte counter seeded once on init, instead of `statSync` on every write.

### Added
- `observations_dropped` field in `session_end` observations — surfaces write failures.
- File rotation at 10MB with one backup (`.1.jsonl`).
- Init failure resilience — hooks register even if storage init fails.
- Path traversal protection on `storagePath`.
- GitHub Actions CI (typecheck + tests) and publish workflows.
- Dependabot configuration for npm and GitHub Actions.

### Removed
- `src/redaction.ts`, `src/redaction-patterns.ts`, `src/entropy.ts` (700 lines)
- `src/project-id.ts` (89 lines — git execSync calls)
- `src/safe-execute.ts` (42 lines — inlined)
- `meta.json` creation and management

## [0.2.0]

### Added
- Initial release with observation pipeline
- 5 observation types: user_message, tool_call_start, tool_call_end, session_end, compaction
- 3-pass redaction engine with gitleaks-derived patterns
- Session state tracking with stale-entry sweep
- Self-event filtering via `source: "learning"` marker

## [0.1.1]

### Fixed
- Added dist build output for OpenCode plugin loading

## [0.1.0]

### Added
- Initial implementation
