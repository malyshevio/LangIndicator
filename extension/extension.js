// Lang Indicator — индикатор раскладки у курсора ввода (GNOME Shell, Wayland).
//
// Спринт 1: базовый индикатор.
//   • отслеживание смены раскладки: getInputSourceManager → current-source-changed;
//   • позиция каретки: IBus panel service (set-cursor-location*) + AT-SPI fallback;
//   • оверлей BoxPointer с текстом «RU»/«EN» у каретки, автоскрытие ~1 с.
//
// Подробности архитектуры — docs/research.md, план — в YouGile.

import Atspi from 'gi://Atspi';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getIBusManager} from 'resource:///org/gnome/shell/misc/ibusManager.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

const CARET_MOVED = 'object:text-caret-moved';
const INDICATOR_DURATION_MS = 1000;
// Глобальный AT-SPI listener может ронять сессию (нативный крэш). Временно
// отключён — включить обратно только после диагностики по журналу.
const ENABLE_ATSPI_FALLBACK = false;

const Indicator = class Indicator extends BoxPointer.BoxPointer {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(St.Side.TOP);
        this._timeoutId = null;
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

    // Названо animate(), а не show(): show() перекрыл бы Clutter.Actor.show(),
    // который BoxPointer.open() вызывает внутри себя (рекурсивный вызов с
    // пустым rect). Тот же приём — в Better IBus.
    animate(text, rect) {
        this._label.text = text;

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        this._dummyCursor.set_position(rect.x, rect.y);
        this._dummyCursor.set_size(
            rect.width > 0 ? rect.width : 1,
            rect.height > 0 ? rect.height : 1);
        this.setPosition(this._dummyCursor, 0);
        this.open(BoxPointer.PopupAnimation.FULL);

        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, INDICATOR_DURATION_MS, () => {
                this.close(BoxPointer.PopupAnimation.FULL);
                this._timeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this.close(BoxPointer.PopupAnimation.NONE);
        Main.layoutManager.removeChrome(this);
        this._dummyCursor.destroy();
        this._dummyCursor = null;
        super.destroy();
    }
};

export default class LangIndicatorExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        this._inputSourceManager = getInputSourceManager();
        this._ibusManager = getIBusManager();
        this._panelService = null;
        this._lastGeometry = null;
        this._geometryWindowId = null;

        // Смена источника ввода (раскладки).
        this._inputSourceManager.connectObject(
            'current-source-changed', () => this._showCurrentLayout(), this);

        // IBus panel service создаётся асинхронно: подписываемся на ready,
        // чтобы подключиться к сигналам позиции, когда сервис будет готов.
        this._ibusManager.connectObject(
            'ready', () => this._syncPanelService(), this);
        this._syncPanelService();

        // Fallback: AT-SPI для приложений, не сообщающих позицию в IBus.
        if (ENABLE_ATSPI_FALLBACK)
            this._initAtspiFallback();

        // На старте позиция каретки ещё неизвестна; индикатор появится при
        // первой смене раскладки после получения позиции.
        this._showCurrentLayout();
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

        // Абсолютная позиция каретки. Логика — как в ui/ibusCandidatePopup.js.
        this._panelService.connectObject(
            'set-cursor-location', (_svc, x, y, w, h) => {
                const focusWindow = global.display.focus_window;
                let rect = new Mtk.Rectangle({x, y, width: w, height: h});
                if (!global.stage.key_focus && focusWindow)
                    rect = focusWindow.protocol_to_stage_rect(rect);
                this._lastGeometry = {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                };
                this._geometryWindowId = focusWindow ? focusWindow.get_id() : null;
            }, this);

        // Относительная позиция (Wayland-клиенты). Сигнал есть не во всех IBus.
        try {
            this._panelService.connectObject(
                'set-cursor-location-relative', (_svc, x, y, w, h) => {
                    const focusWindow = global.display.focus_window;
                    if (!focusWindow)
                        return;
                    let rect = new Mtk.Rectangle({x, y, width: w, height: h});
                    rect = focusWindow.protocol_to_stage_rect(rect);
                    const windowActor = focusWindow.get_compositor_private();
                    // IBus GtkIMModule не знает о масштабе Shell.
                    const scale = windowActor.get_resource_scale();
                    this._lastGeometry = {
                        x: Math.round(windowActor.x + (rect.x / scale)),
                        y: Math.round(windowActor.y + (rect.y / scale)),
                        width: Math.round(rect.width / scale),
                        height: Math.round(rect.height / scale),
                    };
                    this._geometryWindowId = focusWindow ? focusWindow.get_id() : null;
                }, this);
        } catch (e) {
            // Only recent IBus versions have support for this signal.
        }
    }

    _initAtspiFallback() {
        this._atspiListener = null;
        try {
            if (Atspi.init() !== 0) {
                log('[LangIndicator] AT-SPI недоступен');
                return;
            }
            Atspi.set_timeout(250, 250);
            this._atspiListener =
                Atspi.EventListener.new(this._onAtspiCaretMoved.bind(this));
            this._atspiListener.register(CARET_MOVED);
        } catch (e) {
            log(`[LangIndicator] AT-SPI fallback выключен: ${e.message}`);
            this._atspiListener = null;
        }
    }

    _onAtspiCaretMoved(event) {
        try {
            const accessible = event.source;
            const text = accessible?.get_text_iface();
            if (!text)
                return;
            const extents = text.get_character_extents(
                text.get_caret_offset(), Atspi.CoordType.WINDOW);
            const rect = this._convertExtentsToScreenSpace(accessible, extents);
            if (rect) {
                this._lastGeometry = rect;
                this._geometryWindowId =
                    global.display.focus_window?.get_id() ?? null;
            }
        } catch (e) {
            // Игнорируем отдельные события без корректных extents.
        }
    }

    // Перевод extents из window-координат AT-SPI в stage-координаты Shell.
    // Логика повторяет magnifier.js (GNOME Shell).
    _convertExtentsToScreenSpace(accessible, extents) {
        const toplevelWindowTypes = new Set(
            [Atspi.Role.FRAME, Atspi.Role.DIALOG, Atspi.Role.WINDOW]);

        try {
            let app = null;
            let parentWindow = null;
            let iter = accessible;
            while (iter) {
                if (iter.get_role() === Atspi.Role.APPLICATION) {
                    app = iter;
                    break;
                } else if (toplevelWindowTypes.has(iter.get_role())) {
                    parentWindow = iter;
                }
                iter = iter.get_parent();
            }

            // Свои же события (gnome-shell) не транслируем.
            if (app && app.get_name() === 'gnome-shell')
                return null;

            const windowActive = parentWindow &&
                parentWindow.get_state_set().contains(Atspi.StateType.ACTIVE);
            const accessibleFocused =
                accessible.get_state_set().contains(Atspi.StateType.FOCUSED);
            if (!windowActive || !accessibleFocused)
                return null;
        } catch (e) {
            return null;
        }

        const focusWindow = global.display.focus_window;
        if (!focusWindow)
            return null;

        const windowRect = focusWindow.get_client_content_rect();
        const scaleFactor =
            St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return {
            x: windowRect.x + (scaleFactor * extents.x),
            y: windowRect.y + (scaleFactor * extents.y),
            width: scaleFactor * extents.width,
            height: scaleFactor * extents.height,
        };
    }

    _currentLayoutLabel() {
        const src = this._inputSourceManager.currentSource;
        if (!src)
            return '';
        return src.shortName || '?';
    }

    _showCurrentLayout() {
        const g = this._lastGeometry;
        const focusWindow = global.display.focus_window;

        if (!g || this._geometryWindowId === null) {
            log('[LangIndicator] show: нет позиции каретки');
            return;
        }
        // Показываем только если позиция принадлежит текущему окну фокуса.
        const focusId = focusWindow ? focusWindow.get_id() : null;
        if (this._geometryWindowId !== focusId) {
            log(`[LangIndicator] show: позиция от другого окна (geom=${this._geometryWindowId} focus=${focusId}), пропускаю`);
            return;
        }

        const label = this._currentLayoutLabel();
        if (!label)
            return;

        log(`[LangIndicator] show "${label}" @ ${g.x},${g.y}`);
        this._indicator.animate(label, g);
    }

    disable() {
        this._inputSourceManager?.disconnectObject(this);
        this._ibusManager?.disconnectObject(this);
        this._panelService?.disconnectObject(this);

        if (this._atspiListener) {
            try {
                this._atspiListener.deregister(CARET_MOVED);
            } catch (e) {
                // ignore
            }
            this._atspiListener = null;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._inputSourceManager = null;
        this._ibusManager = null;
        this._panelService = null;
        this._lastGeometry = null;
        this._geometryWindowId = null;
    }
}
