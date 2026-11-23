# AGENTS.md

GNOME Shell extension (GJS/ESM) that shows the current keyboard layout
(`RU`/`EN`) as a popup near the **text caret**. Wayland-only, GNOME Shell 47+.

## Core constraint (don't fight it)
The GUI **must** be a GNOME Shell extension, not a standalone app: a normal
Wayland client cannot read another app's caret position (compositor isolation).
`dbus/` is a placeholder for an optional Rust/Go D-Bus XKB helper (not started).
See `docs/research.md` for reasoning and API sources.

## Architecture (current model)
- **IBus only** (`set-cursor-location*` on `getIBusManager()._panelService`).
  Gives accurate stage coordinates whenever the app reports a caret (GTK/Qt
  with an IM module). This is the baseline that worked in v0.2.0.
- **No AT-SPI fallback** (dropped in 0.6.0). Without an IBus event the indicator
  stays hidden; the mouse pointer is never used as a fallback.
- **Never overlap the caret.** The chip goes **above** the caret line with a gap
  (`CARET_GAP`), flips below the line only when it doesn't fit above, and is
  clamped to the monitor work area. No `BoxPointer`, no arrow — plain
  `St.BoxLayout` positioned with `set_position()`.
- **Hide on focus loss / window change.** Per-window caret cache lets the
  indicator reappear instantly on return.
- Coordinate conversion mirrors `ui/ibusCandidatePopup.js`
  (`protocol_to_stage_rect()` + window actor scale for `-relative`).

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
  `getIBusManager()._panelService`, `getInputSourceManager()`,
  `Main.layoutManager.addTopChrome`. Follow `ibusCandidatePopup.js` patterns
  rather than "cleaning up".
- Chrome actors added with `addTopChrome()` live in `uiGroup` (fixed layout):
  `set_position()`/`set_size()` stick, no constraints needed. Name the methods
  `update()`/`dismiss()` so they don't shadow `Clutter.Actor.show()`/`hide()`;
  toggle with `visible = …`.
- Chip height is measured with `get_preferred_size()`; a `FALLBACK_HEIGHT`
  floor keeps a not-yet-measured chip from landing on the caret.

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
(agent `coder`) + tester (agent `general`) on model `opencode-go/gpt-6-luna`
with a focused brief (≤ 3 bullets from the diff). Demand a terse review: a
numbered list of concrete findings with line numbers and a one-line fix each —
no preamble, no restating the code, no long reasoning. Trivial changes (typos,
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
