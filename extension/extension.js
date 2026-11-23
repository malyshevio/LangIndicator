// Lang Indicator — индикатор раскладки у курсора ввода (GNOME Shell, Wayland).
//
// Модель позиционирования — одна и детерминированная (никаких «кто победил»):
//   • AT-SPI — основной источник: события caret-moved/focused дают ТЕКУЩУЮ
//     позицию каретки; работают при фокусе, на стрелках и backspace;
//   • IBus (set-cursor-location*) — запасной источник для приложений без a11y.
//     IBus не присылает позицию при простом фокусе и отстаёт на один отчёт,
//     поэтому как только AT-SPI дал позицию для текущего окна, IBus для этого
//     окна игнорируется — иначе индикатор прыгает между двумя источниками;
//   • при смене окна/потере фокуса индикатор скрывается и ждёт позицию нового
//     окна (не висит на каретке прошлого окна); последняя позиция каретки
//     запоминается по окнам, чтобы при возврате показать сразу;
//   • текст («RU»/«EN») обновляется при смене раскладки.
//
// AT-SPI слушаем через штатный FocusCaretTracker (тот же, что в magnifier.js),
// а не собственным листенером — меньше шансов уронить сессию.
//
// Подробности — docs/research.md, план — в YouGile.

import Atspi from 'gi://Atspi';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getIBusManager} from 'resource:///org/gnome/shell/misc/ibusManager.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {FocusCaretTracker} from 'resource:///org/gnome/shell/ui/focusCaretTracker.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

const CARET_MOVED = 'object:text-caret-moved';
const FOCUS_CHANGED = 'object:state-changed:focused';
// Склейка частых событий AT-SPI/IBus в один relayout.
// Минимальная задержка для снижения нагрузки, но достаточно быстрая, чтобы не отставать.
const UPDATE_DELAY_MS = 8;
// Допуск при проверке «каретка внутри окна фокуса»: отсекает запоздалые
// события предыдущего окна, но не спотыкается на тени/декорациях и на
// расхождении origin у разных приложений.
const BOUNDS_MARGIN = 128;

const Indicator = class Indicator extends BoxPointer.BoxPointer {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(St.Side.LEFT);
        this._isOpen = false;
        this.visible = false;
        this.add_style_class_name('lang-indicator-boxpointer');

        // «Dummy»-актор задаёт точку привязки BoxPointer к каретке.
        this._dummyCursor = new Clutter.Actor({opacity: 0});
        Main.layoutManager.uiGroup.add_child(this._dummyCursor);
        Main.layoutManager.addTopChrome(this);

        const box = new St.BoxLayout({style_class: 'lang-indicator-content'});
        this.bin.set_child(box);
        this._label = new St.Label({style_class: 'lang-indicator-label'});
        box.add_child(this._label);
    }

    // Названо не show(), чтобы не перекрыть Clutter.Actor.show(), который
    // BoxPointer.open() вызывает внутри себя.
    update(text, rect) {
        this._label.text = text;
        this._dummyCursor.set_position(rect.x, rect.y);
        this._dummyCursor.set_size(
            rect.width > 0 ? rect.width : 1,
            rect.height > 0 ? rect.height : 1);
        this.setPosition(this._dummyCursor, 0);

        if (this._isOpen)
            return;

        this._isOpen = true;
        this.open(BoxPointer.PopupAnimation.NONE);
    }

    // Не hide(): он перекрыл бы Clutter.Actor.hide(), который BoxPointer.close()
    // вызывает внутри себя.
    dismiss() {
        if (!this._isOpen)
            return;

        this._isOpen = false;
        // Прячем актёра напрямую: close() запускает анимацию и может скрыть
        // заново уже переоткрытый индикатор (гонка при смене окна).
        this.visible = false;
    }

    destroy() {
        this.close(BoxPointer.PopupAnimation.NONE);
        Main.layoutManager.removeChrome(this);
        this._dummyCursor.destroy();
        this._dummyCursor = null;
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
        this._geometry = null;
        this._source = null;
        this._updateId = 0;
        // Последняя известная каретка по каждому окну: позволяет показать
        // индикатор сразу при переходе в окно, не дожидаясь нового события.
        this._carets = new Map();

        // AT-SPI: штатный трекер Shell (он же сам делает Atspi.init()).
        this._focusCaretTracker = new FocusCaretTracker();
        this._focusCaretTracker.connectObject(
            'caret-moved', (_tracker, event) => this._onAtspiEvent(event, false), this);
        this._focusCaretTracker.connectObject(
            'focus-changed', (_tracker, event) => this._onAtspiEvent(event, true), this);
        this._focusCaretTracker.registerCaretListener();
        this._focusCaretTracker.registerFocusListener();

        // IBus panel service создаётся асинхронно: подписываемся на ready.
        this._ibusManager.connectObject(
            'ready', () => this._syncPanelService(), this);
        this._syncPanelService();

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

        this._geometry = cached?.rect ?? null;
        this._source = cached?.source ?? null;

        // Окно могло сдвинуться, пока было без фокуса — кэш тогда бесполезен.
        if (this._geometry && !this._isInsideFocusWindow(this._geometry)) {
            this._geometry = null;
            this._source = null;
        }

        // Есть сохранённая позиция каретки этого окна — показываем сразу,
        // иначе ждём первое событие (AT-SPI/IBus) уже с чистым состоянием.
        if (this._geometry)
            this._scheduleUpdate();
        else
            this._hide();
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

    // --- IBus (запасной источник) ---

    _setIbusGeometry(x, y, w, h, relative) {
        // AT-SPI уже ведёт это окно — его позиция текущая, IBus отстаёт.
        if (this._source === 'atspi')
            return;

        // IBus может прислать «пустую» позицию 0,0,0,0 до того, как узнает
        // каретку. Реальный прямоугольник каретки имеет ненулевую высоту
        // (ширина может быть 0 — это вертикальная черта).
        if (w === 0 && h === 0)
            return;

        const rect = this._ibusToStage(x, y, w, h, relative);
        this._applyGeometry(rect, 'ibus');
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

    // --- AT-SPI (основной источник) ---

    _onAtspiEvent(event, isFocus) {
        if (!this._indicator || !this._inputSourceManager)
            return;

        try {
            if (isFocus) {
                // FocusCaretTracker шлёт все state-changed — нам нужен только
                // факт получения фокуса.
                if (event.type !== FOCUS_CHANGED || event.detail1 !== 1)
                    return;
            } else if (event.type !== CARET_MOVED) {
                return;
            }

            const accessible = event.source;
            if (!accessible)
                return;

            if (!this._isFocusWindowPid(accessible))
                return;

            // Для focus-changed НЕ пытаемся получить позицию каретки — ждём caret-moved.
            // Это избежит "мигания" (индикатор наверху виджета → у каретки).
            if (isFocus)
                return;

            const extents = this._caretExtents(accessible, event);
            if (extents) {
                this._applyGeometry(this._atspiToStage(extents), 'atspi');
                return;
            }

            // Caret-moved для виджета без каретки — забываем позицию.
            this._forgetCaret();
        } catch (e) {
            // Отдельные события без корректных extents игнорируем.
        }
    }

    // Событие должно прийти от процесса окна фокуса: отсекает запоздавшие
    // события предыдущего окна и фоновых приложений. Заодно отсекает shell:
    // в его UI global.display.focus_window == null.
    _isFocusWindowPid(accessible) {
        const focusWindow = global.display.focus_window;
        if (!focusWindow)
            return false;

        const focusPid = focusWindow.get_pid();
        let sourcePid = -1;
        try {
            sourcePid = accessible.get_process_id();
        } catch (e) {
            sourcePid = -1;
        }

        return !(sourcePid > 0 && focusPid > 0 && sourcePid !== focusPid);
    }

    _caretExtents(accessible, event) {
        const text = accessible.get_text_iface();
        if (text) {
            // У caret-moved новый offset приходит в detail1.
            const offset = event.detail1;
            if (offset >= 0) {
                const extents = text.get_character_extents(
                    offset, Atspi.CoordType.WINDOW);
                if (extents && (extents.width > 0 || extents.height > 0))
                    return extents;
            }
        }
        return null;
    }

    // extents AT-SPI (в координатах окна) -> stage. Контракт mutter тот же,
    // что в magnifier.js: origin — get_client_content_rect(), масштаб — Shell.
    _atspiToStage(extents) {
        const focusWindow = global.display.focus_window;
        if (!focusWindow)
            return null;

        const windowRect = focusWindow.get_client_content_rect();
        const scaleFactor =
            St.ThemeContext.get_for_stage(global.stage).scale_factor;

        // get_character_extents возвращает позицию СИМВОЛА, а каретка находится
        // ПОСЛЕ символа. Используем extents.x + extents.width для позиции каретки.
        const caretX = extents.x + extents.width;
        const caretY = extents.y;

        return {
            x: Math.round(windowRect.x + (scaleFactor * caretX)),
            y: Math.round(windowRect.y + (scaleFactor * caretY)),
            width: Math.round(scaleFactor * extents.width),
            height: Math.round(scaleFactor * extents.height),
        };
    }

    // --- Общее ---

    _applyGeometry(rect, source) {
        if (!rect)
            return;

        // Отсекаем позиции вне окна фокуса (запоздалые события, чужие окна,
        // битые extents). Позиция мыши не подставляется ни при каких условиях.
        if (!this._isInsideFocusWindow(rect))
            return;

        this._geometry = rect;
        if (this._source !== source)
            log(`[LangIndicator] источник каретки: ${source}`);
        this._source = source;
        this._rememberCaret(rect, source);
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
    // показывается сразу, не дожидаясь события. Размер ограничен — хранить
    // историю всех окон незачем.
    _rememberCaret(rect, source) {
        const win = global.display.focus_window;
        if (!win)
            return;

        const id = win.get_id();
        this._carets.delete(id);
        this._carets.set(id, {rect, source});
        if (this._carets.size > 16)
            this._carets.delete(this._carets.keys().next().value);
    }

    // Фокус ушёл на виджет без каретки: забываем позицию текущего окна.
    _forgetCaret() {
        const win = global.display.focus_window;
        if (win)
            this._carets.delete(win.get_id());

        this._geometry = null;
        this._source = null;
        this._hide();
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
        if (!this._indicator || !this._geometry)
            return;
        const label = this._currentLayoutLabel();
        if (!label)
            return;
        this._indicator.update(label, this._geometry);
    }

    _hide() {
        this._indicator?.dismiss();
    }

    disable() {
        if (this._updateId) {
            GLib.source_remove(this._updateId);
            this._updateId = 0;
        }

        this._focusCaretTracker?.deregisterCaretListener();
        this._focusCaretTracker?.deregisterFocusListener();
        this._focusCaretTracker?.disconnectObject(this);
        this._focusCaretTracker = null;

        this._inputSourceManager?.disconnectObject(this);
        this._ibusManager?.disconnectObject(this);
        this._panelService?.disconnectObject(this);
        global.display?.disconnectObject(this);

        this._indicator?.destroy();
        this._indicator = null;
        this._inputSourceManager = null;
        this._ibusManager = null;
        this._panelService = null;
        this._geometry = null;
        this._source = null;
        this._carets = null;
    }
}
