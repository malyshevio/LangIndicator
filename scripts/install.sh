#!/usr/bin/env bash
# Установка расширения Lang Indicator для разработки (симлинк на репозиторий).
set -euo pipefail

UUID="lang-indicator@malyshevio.github.io"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${ROOT_DIR}/extension"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

mkdir -p "$(dirname "${EXT_DIR}")"
rm -rf "${EXT_DIR}"
ln -s "${SRC_DIR}" "${EXT_DIR}"

echo "Расширение установлено: ${EXT_DIR} -> ${SRC_DIR}"
echo "Включить: gnome-extensions enable ${UUID}"
echo "Перезапуск оболочки: X11 — Alt+F2, затем 'r'; Wayland — перелогиньтесь в сессию."
