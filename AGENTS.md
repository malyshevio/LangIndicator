# AGENTS.md

GNOME Shell extension (JavaScript/GJS) that shows the current keyboard layout
(`RU`/`EN`) as a popup near the **text caret**. Wayland-only, GNOME Shell 45+.

## Core constraint (don't fight it)
The GUI **must** be a GNOME Shell extension, not a standalone Rust/Go app: a
normal Wayland client cannot read another app's caret position (compositor
isolation). Rust/Go is only for the optional D-Bus XKB helper (`dbus/`, planned
but not started). See `docs/research.md` for the reasoning and API sources.

## No build system
There is **no** package.json, Makefile, test runner, linter, or CI. The
extension is plain ESM JS loaded by GNOME Shell. Don't reach for `npm`/`make`/
`test`; the only local check is a syntax check (see below).

## Files that matter
- `readme.md` — note the **lowercase** name; architecture, constraints, acceptance criteria.
- `docs/research.md` — how caret position is obtained (IBus + AT-SPI), with snippets and upstream sources (Better IBus, kimpanel, magnifier).
- `extension/extension.js` — the entire implementation, single file.
- `extension/metadata.json` — `uuid` and `shell-version` gate loading.
- `scripts/install.sh` — dev install via symlink.
- `dbus/` — placeholder for the optional D-Bus coordinator (Rust/zbus).

## Key constraints / gotchas
- **ESM only.** GNOME Shell 45+ dropped `imports.*`. Entry point is
  `export default class … extends Extension` from
  `resource:///org/gnome/shell/extensions/extension.js`. No `init()`/`enable()` globals.
- **UUID `lang-indicator@malyshevio.github.io`** is hardcoded in both
  `metadata.json` and `scripts/install.sh`; they must stay in sync or install breaks.
- The code uses **private GNOME Shell APIs intentionally** — there is no public
  API for caret position. Key ones: `getIBusManager()._panelService`,
  `getInputSourceManager()`, `Main.panel.statusArea.keyboard._indicatorLabels`.
  Follow the Better IBus / magnifier patterns rather than "cleaning up" to public APIs.
- Caret position: primary = IBus `set-cursor-location` / `set-cursor-location-relative`
  signals; fallback = AT-SPI `object:text-caret-moved` (coordinate conversion mirrors `magnifier.js`).
- `shell-version` in `metadata.json` gates loading. When targeting a new GNOME
  release, add its version or the extension won't enable.

## Dev loop (requires a real GNOME Shell Wayland session)
```bash
./scripts/install.sh                          # symlink into ~/.local/share/gnome-shell/extensions/
gnome-extensions enable lang-indicator@malyshevio.github.io
# Wayland: relogin (Alt+F2 → 'r' does NOT work on Wayland)
journalctl -f -o cat | grep LangIndicator     # extension logs
```

This code **cannot be run in a container/CI** (no GNOME Shell). Only a syntax
check works locally — `node --check` parses `.js` as CommonJS, so check as ESM:
```bash
cp extension/extension.js /tmp/extension.mjs && node --check /tmp/extension.mjs
```

## Development workflow (mandatory)
Before delivering any code change, run two review subagents on model
`opencode-go/mimo-v2.6-flash` and fix their findings before finishing:
- **codereviewer** — agent `coder`: correctness, GNOME Shell API usage, crash risk.
- **tester** — agent `general`: static verification + bug hunt; must run the
  ESM `node --check` syntax check above and verify `metadata.json` uuid /
  `shell-version` against `scripts/install.sh`.

## Versioning & commits
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`.
- Bump `extension/metadata.json` `version` (int) and `version-name` (SemVer) on
  each user-visible change; tag releases as `v<version-name>`.
- Push to `main` after committing (`git push`).

## Project tracking
Sprint plan and task board live in **YouGile** (project `LangIndicator`, prefix
`LAN`), not in this repo. `readme.md` phases map to sprints 0–3.
