# Исследование: позиция каретки в GNOME Shell

Результат задач LAN-16 / LAN-17 (Спринт 0). Подтверждает архитектуру из README
и даёт конкретные API для Спринта 1.

## Вывод (коротко)

В GNOME Shell позицию каретки можно получить **изнутри композитора** двумя способами:

1. **IBus panel service** (основной, рекомендованный) — сигналы
   `set-cursor-location` / `set-cursor-location-relative`.
2. **AT-SPI** (fallback) — события `object:text-caret-moved` +
   `atspi_text_get_character_extents`.

Обычное Wayland-приложение эти данные не получит (изоляция композитора),
поэтому GUI-слой — расширение GNOME Shell.

## 1. IBus panel service (подход Better IBus)

`gnome-shell` публикует сервис IBus panel, который эмитит сигналы позиции
каретки. Их использует расширение
[Better IBus](https://github.com/mechtifs/better-ibus).

```js
import { getIBusManager } from 'resource:///org/gnome/shell/misc/ibusManager.js';

const panelService = getIBusManager()._panelService;

panelService.connectObject(
    // x, y — абсолютные координаты сцены (stage)
    'set-cursor-location', (_svc, x, y, w, h) => { /* … */ },

    // x, y — относительно окна с фокусом; складываем с позицией window actor
    'set-cursor-location-relative', (_svc, x, y, w, h) => {
        const wActor = global.display.focus_window?.get_compositor_private();
        if (!wActor) return;
        const absX = wActor.x + x;
        const absY = wActor.y + y;
    },
    this,
);
```

### Смена источника ввода (раскладки)

```js
import { getInputSourceManager } from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ism = getInputSourceManager();
ism.connectObject('current-source-changed', () => {
    const label = Main.panel.statusArea.keyboard
        ._indicatorLabels[ism.currentSource.index].get_text(); // «RU», «EN»
});
```

### Оверлей (Clutter actor)

Better IBus рисует `BoxPointer.BoxPointer`, позиционируя его через «dummy» актор
и добавляя как top chrome (не перехватывает фокус):

```js
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';

const dummyCursor = new Clutter.Actor();
Main.layoutManager.uiGroup.add_child(dummyCursor);
dummyCursor.set_position(x, y);
dummyCursor.set_size(w, h);
boxpointer.setPosition(dummyCursor, 0);
Main.layoutManager.addTopChrome(boxpointer);
```

## 2. kimpanel (протокол org.kde.impanel)

Расширение
[gnome-shell-extension-kimpanel](https://github.com/wengxt/gnome-shell-extension-kimpanel)
регистрирует D-Bus-интерфейсы `org.kde.impanel` / `org.kde.impanel2`. ИМ (fcitx)
вызывает методы `SetSpotRect(x, y, w, h)`, `SetRelativeSpotRect` и
`SetRelativeSpotRectV2(x, y, w, h, scale)`, передавая позицию каретки.

Преобразование в координаты сцены (`panel.js` → `updatePosition`):

- относительные: `focusWindow.protocol_to_stage_rect(rect)` + `window.x/window.y`;
- ограничение по монитору: `global.display.get_monitor_index_for_rect(rect)`.

Подтверждает: координаты каретки доступны только внутри композитора — ИМ
присылает их по D-Bus, а расширение переводит в stage-координаты.

## 3. AT-SPI (fallback)

Событие `object:text-caret-moved` и `atspi_text_get_character_extents` дают
прямоугольник каретки. Так каретку отслеживает GNOME Shell Magnifier. Доступно
для GTK/Qt (приложения с поддержкой accessibility). Из расширения:
`import Atspi from 'gi://Atspi'`.

Ограничение: не все приложения (Electron, кастомные виджеты) корректно отдают
a11y-каретку; есть известные баги (mutter#3963 — нет `text-caret-moved` при
вводе в `ClutterText`).

## 4. Рекомендация для Спринта 1

1. **Основной путь** — IBus panel service (`set-cursor-location*`): просто,
   уже встроено в Shell, работает для приложений, сообщающих позицию в ИМ
   (GTK/Qt с IBus IM-модулем).
2. **Fallback** — AT-SPI (`text-caret-moved`), для приложений без IBus-позиции.
3. Смену раскладки ловим через
   `getInputSourceManager().connectObject('current-source-changed', …)`.
4. Оверлей — `BoxPointer.BoxPointer` + dummy-актор + `addTopChrome`, чтобы не
   перехватывать фокус ввода.

## Известные ограничения

- Позиция есть только пока приложение сообщает её в ИМ или a11y; для остальных
  индикатор не показываем (не у курсора мыши).
- Возможны задержки обновления позиции (Better IBus ставит debounce 50 мс на
  `notify::focus-window`).
- wlroots (Sway и др.) — без модификации композитора не поддержать.
