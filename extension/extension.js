// Lang Indicator — индикатор раскладки у курсора ввода (GNOME Shell, Wayland).
//
// Единственный источник позиции каретки — IBus panel service
// (`set-cursor-location` / `set-cursor-location-relative`). Он даёт точные
// stage-координаты, пока приложение сообщает их input-method (GTK/Qt с
// IBus-модулем). AT-SPI больше не используется: без события IBus индикатор
// не показывается, позиция мыши не подставляется никогда.
//
// Индикатор не налезает на каретку: основной вариант — ПРАВЕЕ и НИЖЕ неё,
// чтобы не закрывать ни каретку, ни строку, в которой печатают. Если там не
// помещается, перебираются остальные углы вокруг каретки (справа-сверху,
// слева-снизу, слева-сверху), и только в крайнем случае — прежняя схема «по
// центру над строкой» (или под ней, если сверху нет места). Позиция
// ограничена рабочей областью монитора (кроме случая, когда «чип» шире неё).
//
// При смене окна/потере фокуса индикатор скрывается; при потере фокуса самим
// текстовым полем внутри того же окна (IBus focus-out) — тоже. Последняя
// позиция каретки запоминается по окнам вместе с признаком «поле было в
// фокусе», чтобы при возврате в окно показать сразу.
//
// Подробности — docs/research.md, задачи — в YouGile (проект LangIndicator).

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getIBusManager} from 'resource:///org/gnome/shell/misc/ibusManager.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

// Склейка частых событий IBus/смены раскладки в один relayout (~60 Гц).
const UPDATE_DELAY_MS = 16;
// Отступ между кареткой и «чипом»: гарантия, что индикатор не закрывает ни
// каретку, ни строку, в которой печатают.
const CARET_GAP = 6;
// Минимальный отступ от края рабочей области, чтобы «чип» не лип к кромке.
const EDGE_MARGIN = 4;
// Допуск при проверке «каретка внутри окна фокуса»: отсекает запоздалые
// события предыдущего окна, но не спотыкается на тени/декорациях.
const BOUNDS_MARGIN = 12;
// Страховка, если высота «чипа» ещё не посчитана (стиль не применился):
// без неё индикатор мог бы лечь на каретку.
const FALLBACK_HEIGHT = 24;
// Если IBus не сообщил высоту каретки — считаем её обычной строкой текста.
// При крупном шрифте реальная строка выше, и «чип» под ней может задеть её
// низ; это касается только приложений, присылающих h = 0.
const FALLBACK_CARET_HEIGHT = 16;

const Indicator = class Indicator extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super({
            style_class: 'lang-indicator-content',
            visible: false,
        });
        this._caret = null;

        this._label = new St.Label({style_class: 'lang-indicator-label'});
        this.add_child(this._label);

        // Верхний chrome-слой: выше окон, не перехватывает фокус ввода.
        Main.layoutManager.addTopChrome(this);
    }

    // Названо не show(), чтобы не перекрыть Clutter.Actor.show().
    update(text, caret) {
        this._label.text = text;
        this._caret = caret;
        // Показываем до замера: размер считаем уже с новым текстом, в том же
        // кадре, поэтому промежуточной отрисовки не будет.
        this.visible = true;
        this._relayout();
    }

    _relayout() {
        if (!this._caret)
            return;

        const [, , naturalWidth, naturalHeight] = this.get_preferred_size();
        // Меньше реальной высоты — никогда: завышенный размер только
        // увеличит отступ, а заниженный мог бы наложить «чип» на каретку.
        const height = Math.max(naturalHeight, FALLBACK_HEIGHT);
        const {x, y} = this._place(naturalWidth, height);
        this.set_position(x, y);
    }

    // Ставим «чип» правее и ниже каретки — это основной вариант: он не
    // перекрывает ни каретку, ни строку, в которой печатают. Если справа
    // или снизу нет места, перебираем остальные углы вокруг каретки, и
    // только если не влезает ни один — падаем на «по центру над строкой».
    _place(width, height) {
        const caret = this._caret;
        const workArea = this._workAreaAt(caret.x, caret.y);
        const caretHeight = caret.height > 0 ? caret.height : FALLBACK_CARET_HEIGHT;
        const caretWidth = Math.max(caret.width, 0);

        // Границы рабочей области, внутри которых «чип» должен лежать целиком.
        const minX = workArea.x + EDGE_MARGIN;
        const minY = workArea.y + EDGE_MARGIN;
        const maxX = workArea.x + workArea.width - EDGE_MARGIN;
        const maxY = workArea.y + workArea.height - EDGE_MARGIN;

        const rightX = caret.x + caretWidth + CARET_GAP;
        const leftX = caret.x - width - CARET_GAP;
        const belowY = caret.y + caretHeight + CARET_GAP;
        const aboveY = caret.y - height - CARET_GAP;

        const candidates = [
            [rightX, belowY], // правее и ниже — основной
            [rightX, aboveY], // поле у нижней кромки (чаты, мессенджеры)
            [leftX, belowY],  // каретка у правого края
            [leftX, aboveY],
        ];

        for (const [rawX, rawY] of candidates) {
            const x = Math.round(rawX);
            const y = Math.round(rawY);
            if (x >= minX && y >= minY && x + width <= maxX && y + height <= maxY)
                return {x, y};
        }

        return this._placeCentered(width, height, caret, caretHeight, workArea);
    }

    // Запасная схема: по центру каретки над строкой, иначе под строкой.
    // Нужна, когда «чип» шире рабочей области и ни один угол не подошёл.
    _placeCentered(width, height, caret, caretHeight, workArea) {
        let x = caret.x + (Math.max(caret.width, 0) / 2) - (width / 2);
        x = Math.max(workArea.x + EDGE_MARGIN,
            Math.min(x, workArea.x + workArea.width - width - EDGE_MARGIN));

        let y = caret.y - height - CARET_GAP;
        if (y < workArea.y + EDGE_MARGIN)
            y = caret.y + caretHeight + CARET_GAP;

        y = Math.max(workArea.y + EDGE_MARGIN,
            Math.min(y, workArea.y + workArea.height - height - EDGE_MARGIN));

        // Кламп мог загнать «чип» на строку каретки (если он выше половины
        // рабочей области). Перекрыть кромку экрана лучше, чем каретку.
        if (y + height > caret.y && y < caret.y + caretHeight)
            y = caret.y - height - CARET_GAP;

        return {x: Math.round(x), y: Math.round(y)};
    }

    // Рабочая область монитора, на котором находится каретка (без панелей).
    _workAreaAt(x, y) {
        const monitors = Main.layoutManager.monitors;
        const index = monitors.findIndex(m =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        return Main.layoutManager.getWorkAreaForMonitor(
            index >= 0 ? index : Main.layoutManager.primaryIndex);
    }

    // Не hide(): он перекрыл бы Clutter.Actor.hide(), который Shell вызывает
    // у chrome-актёров внутри себя.
    dismiss() {
        this.visible = false;
    }

    destroy() {
        Main.layoutManager.removeChrome(this);
        super.destroy();
    }
};

export default class LangIndicatorExtension extends Extension {
    enable() {
        log(`[LangIndicator] v${this.metadata?.['version-name'] ?? '?'} enable`);
        this._indicator = new Indicator();
        this._inputSourceManager = getInputSourceManager();
        this._ibusManager = getIBusManager();
        this._panelService = null;
        this._caret = null;
        // Окно, чей input context последним получил фокус IBus (не то же самое,
        // что окно фокуса экрана): по нему отличаем потерю фокуса полем внутри
        // окна от запоздавшего focus-out прежнего окна.
        this._caretWinId = null;
        this._updateId = 0;
        // Последняя известная каретка по каждому окну: `{rect, focused}`.
        // Позволяет показать индикатор сразу при переходе в окно, не дожидаясь
        // нового события; `focused` не даёт «оживить» индикатор в окне, где
        // текстовое поле уже потеряло фокус.
        this._carets = new Map();

        // IBus panel service создаётся асинхронно: подписываемся на ready.
        this._ibusManager.connectObject(
            'ready', () => this._syncPanelService(), this);
        this._syncPanelService();

        // Фокус текстового поля (IBus input context): потеря — скрываем сразу,
        // получение — показываем из кэша, не дожидаясь события о позиции.
        this._ibusManager.connectObject(
            'focus-out', () => this._onIbusFocusOut(), this);
        this._ibusManager.connectObject(
            'focus-in', () => this._onIbusFocusIn(), this);

        // Смена раскладки — обновляем текст индикатора.
        this._inputSourceManager.connectObject(
            'current-source-changed', () => this._update(), this);

        // Смена окна/потеря фокуса — скрываем и ждём позицию нового окна.
        global.display.connectObject(
            'notify::focus-window', () => this._onFocusWindowChanged(), this);
        this._onFocusWindowChanged();
    }

    _onFocusWindowChanged() {
        const win = global.display.focus_window;
        const cached = win ? this._carets.get(win.get_id()) : null;

        // Окно могло сдвинуться, пока было без фокуса — кэш тогда бесполезен.
        // Запись с потерянным фокусом поля не показываем: переключение окна не
        // доказывает, что текстовое поле в нём снова активно.
        this._caret = cached?.focused && this._isInsideFocusWindow(cached.rect)
            ? cached.rect
            : null;
        // `_caretWinId` здесь не трогаем: он принадлежит стороне IBus и меняется
        // только по её событиям (см. `_onIbusFocusOut`).

        // Есть сохранённая позиция каретки этого окна — показываем сразу,
        // иначе ждём первое событие IBus уже с чистым состоянием.
        if (this._caret)
            this._scheduleUpdate();
        else
            this._hide();
    }

    // Текстовое поле потеряло фокус (IBus focus-out): Tab на неактивный
    // элемент, клик по пустому месту — окно при этом не меняется. Прячем и
    // помечаем запись кэша, чтобы при возврате в окно не показать индикатор
    // на устаревшей позиции.
    _onIbusFocusOut() {
        const win = global.display.focus_window;

        // Запоздавшее событие прежнего окна (фокус уже перешёл в другое) — это
        // деактивация окна, а не потеря фокуса полем внутри него: кэш не
        // трогаем, иначе при возврате не сможем показать индикатор сразу.
        // Без окна фокуса (обзор, рабочий стол) событие считаем своим.
        if (this._caretWinId && win && this._caretWinId !== win.get_id())
            return;

        const entry = this._caretWinId ? this._carets.get(this._caretWinId) : null;
        if (entry)
            entry.focused = false;

        this._caret = null;
        this._hide();
    }

    // В окне снова есть активное текстовое поле (в том числе после Tab в
    // другое поле): показываем сразу из кэша окна — точную позицию приложение
    // пришлёт следующим set-cursor-location. Событие IBus приходит уже после
    // notify::focus-window, поэтому окно берём из текущего фокуса экрана.
    _onIbusFocusIn() {
        const win = global.display.focus_window;
        if (!win)
            return;

        const entry = this._carets.get(win.get_id());
        if (!entry || !this._isInsideFocusWindow(entry.rect))
            return;

        entry.focused = true;
        this._caret = entry.rect;
        this._caretWinId = win.get_id();
        this._scheduleUpdate();
    }

    _syncPanelService() {
        if (this._panelService) {
            this._panelService.disconnectObject(this);
            this._panelService = null;
        }

        const service = this._ibusManager._panelService;
        if (!this._ibusManager._ready || !service)
            return;

        this._panelService = service;

        try {
            this._panelService.connectObject(
                'set-cursor-location', (_svc, x, y, w, h) => {
                    this._setIbusGeometry(x, y, w, h, false);
                }, this);
        } catch (e) {
            log(`[LangIndicator] set-cursor-location недоступен: ${e.message}`);
        }

        try {
            this._panelService.connectObject(
                'set-cursor-location-relative', (_svc, x, y, w, h) => {
                    this._setIbusGeometry(x, y, w, h, true);
                }, this);
        } catch (e) {
            // Only recent IBus versions have support for this signal.
        }
    }

    _setIbusGeometry(x, y, w, h, relative) {
        if (w === 0 && h === 0)
            return;

        const rect = this._ibusToStage(x, y, w, h, relative);
        if (!rect)
            return;

        this._applyGeometry(rect);
    }

    // Перевод координат IBus в stage. Повторяет ui/ibusCandidatePopup.js.
    _ibusToStage(x, y, w, h, relative) {
        const focusWindow = global.display.focus_window;
        if (!focusWindow)
            return null;

        let rect = new Mtk.Rectangle({x, y, width: w, height: h});

        if (relative) {
            rect = focusWindow.protocol_to_stage_rect(rect);
            const windowActor = focusWindow.get_compositor_private();
            if (!windowActor)
                return null;
            // IBus GtkIMModule не знает о масштабе Shell.
            const scale = windowActor.get_resource_scale();
            rect.x = windowActor.x + (rect.x / scale);
            rect.y = windowActor.y + (rect.y / scale);
            rect.width /= scale;
            rect.height /= scale;
        } else if (!global.stage.key_focus) {
            rect = focusWindow.protocol_to_stage_rect(rect);
        }

        return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        };
    }

    // --- Общее ---

    _applyGeometry(rect) {
        if (!rect)
            return;

        // Отсекаем позиции вне окна фокуса (запоздалые события, чужие окна,
        // битые extents). Позиция мыши не подставляется ни при каких условиях.
        if (!this._isInsideFocusWindow(rect))
            return;

        this._caret = rect;
        this._rememberCaret(rect);
        this._scheduleUpdate();
    }

    _isInsideFocusWindow(rect) {
        const frame = global.display.focus_window?.get_frame_rect();
        if (!frame)
            return false;

        return rect.x >= frame.x - BOUNDS_MARGIN &&
            rect.x <= frame.x + frame.width + BOUNDS_MARGIN &&
            rect.y >= frame.y - BOUNDS_MARGIN &&
            rect.y <= frame.y + frame.height + BOUNDS_MARGIN;
    }

    // Кэш последней каретки по окнам: при возврате в окно индикатор
    // показывается сразу, не дожидаясь события. `focused` — было ли поле
    // в фокусе на момент последнего события. Размер ограничен — хранить
    // историю всех окон незачем.
    _rememberCaret(rect) {
        const win = global.display.focus_window;
        if (!win)
            return;

        const id = win.get_id();
        this._caretWinId = id;
        this._carets.delete(id);
        this._carets.set(id, {rect, focused: true});
        if (this._carets.size > 16)
            this._carets.delete(this._carets.keys().next().value);
    }

    _scheduleUpdate() {
        if (this._updateId)
            return;

        this._updateId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, UPDATE_DELAY_MS, () => {
                this._updateId = 0;
                this._update();
                return GLib.SOURCE_REMOVE;
            });
    }

    _currentLayoutLabel() {
        const src = this._inputSourceManager?.currentSource;
        if (!src)
            return '';
        return (src.shortName || '?').toUpperCase();
    }

    _update() {
        if (!this._indicator || !this._caret)
            return;
        const label = this._currentLayoutLabel();
        if (!label)
            return;
        this._indicator.update(label, this._caret);
    }

    _hide() {
        this._indicator?.dismiss();
    }

    disable() {
        if (this._updateId) {
            GLib.source_remove(this._updateId);
            this._updateId = 0;
        }

        this._inputSourceManager?.disconnectObject(this);
        this._ibusManager?.disconnectObject(this);
        this._panelService?.disconnectObject(this);
        global.display?.disconnectObject(this);

        this._indicator?.destroy();
        this._indicator = null;
        this._inputSourceManager = null;
        this._ibusManager = null;
        this._panelService = null;
        this._caret = null;
        this._caretWinId = null;
        this._carets = null;
    }
}
