# Agent Instructions

## Post-Feature Testing

After completing any feature or fix, the agent MUST:

1. Run `pnpm test` to verify all unit tests pass (62 tests across 11 suites)
2. If any test fails, fix the issue immediately
3. Re-run `pnpm test` until all tests pass
4. Run `pnpm start` to verify there are no runtime errors
5. If there are errors, fix them immediately
6. Re-run `pnpm start` until all errors are resolved
7. Only then consider the task complete

This ensures the codebase remains in a working state at all times.

## Release Process (MANDATORY)

When releasing a new version, follow this exact process:

1. **Version Check**: Check if version already exists with `git log --oneline | grep "^[a-f0-9]\+ [0-9]"`
2. **Version Bump**: Update version in `package.json` (e.g., `0.1.16` → `0.1.17`)
3. **Commit ALL Changed Files**: `git add . && git commit -m "0.1.17"`
   - Always commit with just the version number as the message (e.g., "0.1.17")
   - Include ALL modified files in the commit (bin/, src/, test/, README.md, CHANGELOG.md, etc.)
4. **Push**: `git push origin main` — GitHub Actions will auto-publish to npm
5. **Wait for npm Publish":
   ```bash
   for i in $(seq 1 30); do sleep 10; v=$(npm view free-coding-models version 2>/dev/null); echo "Attempt $i: npm version = $v"; if [ "$v" = "0.1.17" ]; then echo "✅ published!"; break; fi; done
   ```
5. **Install and Verify**: `npm install -g free-coding-models@0.1.17`
6. **Test Binary**: `free-coding-models --help` (or any other command to verify it works)
7. **Only when the global npm-installed version works → the release is confirmed**

**Why:** A local `npm install -g .` can mask issues because it symlinks the repo. The real npm package is a tarball built from the `files` field — only a real npm install will catch missing files.

## Real-World npm Verification (MANDATORY for every fix/feature)

**Never trust local-only testing.** `pnpm start` runs from the repo and won't catch missing files in the published package. Always run the full npm verification:

1. Bump version in `package.json` (e.g. `0.1.14` → `0.1.15`)
2. Commit and push to `main` — GitHub Actions auto-publishes to npm
3. Wait for the new version to appear on npm:
   ```bash
   # Poll until npm has the new version
   for i in $(seq 1 30); do sleep 10; v=$(npm view free-coding-models version 2>/dev/null); echo "Attempt $i: npm version = $v"; if [ "$v" = "NEW_VERSION" ]; then echo "✅ published!"; break; fi; done
   ```
4. Install the published version globally:
   ```bash
   npm install -g free-coding-models@NEW_VERSION
   ```
5. Run the global binary and verify it works:
   ```bash
   free-coding-models
   ```
6. Only if the global npm-installed version works → the fix is confirmed

**Why:** A local `npm install -g .` can mask issues because it symlinks the repo. The real npm package is a tarball built from the `files` field — if something is missing there, only a real npm install will catch it.

## Test Architecture

- Tests live in `test/test.js` using Node.js built-in `node:test` + `node:assert` (zero deps)
- Pure logic functions are in `src/utils.js` (extracted from the main CLI for testability)
- The main CLI (`bin/free-coding-models.js`) imports from `src/utils.js`
- If you add new pure logic (calculations, parsing, filtering), add it to `src/utils.js` and write tests
- If you modify existing logic in `src/utils.js`, update the corresponding tests

### What's tested:
- **sources.js data integrity** — model structure, valid tiers, no duplicates, count consistency
- **Core logic** — getAvg, getVerdict, getUptime, filterByTier, sortResults, findBestModel
- **CLI arg parsing** — all flags (--best, --fiable, --opencode, --openclaw, --tier)
- **Package sanity** — package.json fields, bin entry exists, shebang, ESM imports

## GitHub Contributors

When new PRs are merged, add the contributor's GitHub handle to the footer in `bin/free-coding-models.js` (the `Contributors:` line near line 775), separated by spaces. Also update this list:

- @whit3rabbit
- @PhucTruong-ctrl

## Testing the TUI with terminalcp

The project's TUI is built with raw ANSI escape codes + chalk. To visually test TUI behavior:

### Setup

`terminalcp` is installed as a devDependency (`pnpm add -D @mariozechner/terminalcp`). To enable it in Claude Code, add this to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "terminalcp": {
      "command": "pnpm",
      "args": ["dlx", "@mariozechner/terminalcp", "--mcp"]
    }
  }
}
```

It allows spawning the TUI, reading its output, and sending keystrokes.

**Project reference:** See `.claude-mcp.json` for local MCP configuration details.

### Usage

**Spawn the TUI:**
```json
{
  "action": "start",
  "command": "node bin/free-coding-models.js",
  "name": "tui"
}
```

**Read the current output:**
```json
{
  "action": "stdout",
  "id": "tui"
}
```

**Send keystrokes:** Each keystroke is a separate call:
```json
{
  "action": "stdin",
  "id": "tui",
  "data": "T"
}
```

For arrow keys:
- `↓` Down: `"\u001b[B"`
- `↑` Up: `"\u001b[A"`
- `Enter`: `"\r"`
- `Ctrl+C` (exit): `"\u0003"`

**Stop the TUI:**
```json
{
  "action": "stop",
  "id": "tui"
}
```

### Key Reference

| Key | Action | Use Case |
|-----|--------|----------|
| **T** | Cycle tier filter | Test filtering logic (All → S+ → S → A+ → A → A- → B+ → B → C → All) |
| **P** | Open Settings screen | Test API key config, enable/disable providers |
| **Z** | Cycle mode | Test mode switching (OpenCode CLI → Desktop → OpenClaw) |
| **R** | Sort by rank | Verify rank-based sorting |
| **Y** | Sort by tier | Verify tier-based sorting |
| **O** | Sort by origin | Verify origin-based sorting |
| **M** | Sort by model name | Verify model name sorting |
| **L** | Sort by latest ping | Verify ping sorting |
| **A** | Sort by avg ping | Verify average ping sorting |
| **S** | Sort by SWE score | Verify SWE score sorting |
| **N** | Sort by context window | Verify context window sorting |
| **H** | Sort by health/condition | Verify health-based sorting |
| **V** | Sort by verdict | Verify verdict sorting |
| **U** | Sort by uptime | Verify uptime sorting |
| **↑/↓** | Navigate rows | Move cursor up/down |
| **Enter** | Select model | Choose model |
| **Ctrl+C** | Exit | Quit the TUI |

### Example Test Flow

```
1. Spawn: {"action": "start", "command": "node bin/free-coding-models.js", "name": "tui"}
2. Read: {"action": "stdout", "id": "tui"} → Verify table is visible
3. Send T: {"action": "stdin", "id": "tui", "data": "T"}
4. Read: {"action": "stdout", "id": "tui"} → Verify filter changed to S+
5. Send Down: {"action": "stdin", "id": "tui", "data": "\u001b[B"}
6. Read: {"action": "stdout", "id": "tui"} → Verify cursor moved
7. Stop: {"action": "stop", "id": "tui"}
```

---

## Changelog (MANDATORY)

**⚠️ CRITICAL:** After every dev session (feature, fix, refactor), add a succinct entry to `CHANGELOG.md` BEFORE pushing:

- Use the current version from `package.json`
- Add under the matching version header (or create a new one if the version was bumped)
- If the current version is already published, do **not** add new entries under that published version: create the **next** version header (example: `0.1.63` already published → document new work under `0.1.64`)
- List changes under `### Added`, `### Fixed`, or `### Changed` as appropriate
- Keep entries short — one line per change is enough
- Keep the top release section clean and user-facing so it can be reused directly in the GitHub Release notes screen (clear bullets, no internal noise)
- Include ALL changes made during the session
- Update CHANGELOG.md BEFORE committing and pushing

**Why this is critical:** The changelog is the only historical record of what was changed in each version. Without it, users cannot understand what changed between versions.
