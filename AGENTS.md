# AGENTS.md

GNOME Shell extension (GJS/ESM) that shows the current keyboard layout
(`RU`/`EN`) as a popup near the **text caret**. Wayland-only, GNOME Shell 47+.

## Core constraint (don't fight it)
The GUI **must** be a GNOME Shell extension, not a standalone app: a normal
Wayland client cannot read another app's caret position (compositor isolation).
`dbus/` is a placeholder for an optional Rust/Go D-Bus XKB helper (not started).
See `docs/research.md` for reasoning and API sources.

## Architecture (current model)
- **AT-SPI primary** via Shell's `FocusCaretTracker` (`ui/focusCaretTracker.js`,
  the same module `magnifier.js` uses). Gives current caret position on
  focus/arrows/backspace.
- **IBus fallback** (`set-cursor-location*` on `getIBusManager()._panelService`).
  Only used while AT-SPI hasn't positioned the current window; ignored
  afterward (IBus lags one report and misses focus-only events).
- **Single source per window** — no priority flip-flop, no jitter.
- **Hide on focus loss / window change.** Per-window caret cache lets the
  indicator reappear instantly on return.
- Coordinate conversion: AT-SPI `get_character_extents(WINDOW)` +
  `focusWindow.get_client_content_rect()` + `scaleFactor` — mirrors `magnifier.js`.

## No build system
No package.json, Makefile, test runner, linter, or CI. The extension is plain
ESM JS loaded by GNOME Shell. Don't reach for `npm`/`make`/`test`.

## Files that matter
- `readme.md` (lowercase) — constraints, acceptance criteria.
- `docs/research.md` — how caret position is obtained, upstream sources.
- `extension/extension.js` — the entire implementation, single file.
- `extension/metadata.json` — `uuid` and `shell-version` gate loading.
- `scripts/install.sh` — dev install via symlink.

## Key gotchas
- **ESM only.** GNOME Shell 45+ dropped `imports.*`. Entry: `export default
  class … extends Extension`. No `init()`/`enable()` globals.
- **UUID `lang-indicator@malyshevio.github.io`** is in both `metadata.json`
  and `scripts/install.sh`; they must stay in sync or install breaks.
- **`shell-version`** gates loading. When targeting a new GNOME release, add
  its version to `metadata.json` or the extension won't enable.
- Uses **private GNOME Shell APIs** (no public API for caret position):
  `FocusCaretTracker`, `getIBusManager()._panelService`,
  `getInputSourceManager()`, `Main.layoutManager.addTopChrome`. Follow
  `magnifier.js` / `ibusCandidatePopup.js` patterns rather than "cleaning up".
- `BoxPointer.close()` triggers an animation that can hide a re-opened popup
  — use `visible = false` directly (the method is `dismiss()`, not `hide()`).

## Dev loop (requires a real GNOME Shell Wayland session)
```bash
./scripts/install.sh                          # symlink into extensions dir
gnome-extensions enable lang-indicator@malyshevio.github.io
# Wayland: relogin — Alt+F2 'r' does NOT work
journalctl -f -o cat | grep LangIndicator     # extension logs
```

This code **cannot run in a container/CI**. The only local check — syntax
(`node --check` parses as CJS, so check as ESM):
```bash
cp extension/extension.js /tmp/extension.mjs && node --check /tmp/extension.mjs
```

## Development workflow
For behavior changes, new API usage, or lifecycle changes: run codereviewer
(agent `coder`) + tester (agent `general`) on model `opencode-go/mimo-v2.6-flash`
with a focused brief (≤ 3 bullets from the diff). Trivial changes (typos,
comments, version bumps): syntax check only. Refactors: tester only.
Subagents are read-only — they must not edit files. Fix their findings before
committing.

## Versioning & commits
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`.
- Bump `extension/metadata.json` `version` (int) and `version-name` (SemVer)
  on each user-visible change; tag releases as `v<version-name>`.
- Push to `main` after committing (`git push`).

## Project tracking
Task board: **YouGile** (project `LangIndicator`, prefix `LAN`), not in this repo.
