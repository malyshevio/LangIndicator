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
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getIBusManager} from 'resource:///org/gnome/shell/misc/ibusManager.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

const CARET_MOVED = 'object:text-caret-moved';
const INDICATOR_DURATION_MS = 1000;

const Indicator = class Indicator extends BoxPointer.BoxPointer {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(St.Side.TOP);
        this._timeoutId = null;
        this.add_style_class_name('lang-indicator-boxpointer');

        // «Dummy»-актор задаёт точку привязки BoxPointer к каретке.
        this._dummyCursor = new Clutter.Actor();
        Main.layoutManager.uiGroup.add_child(this._dummyCursor);
        Main.layoutManager.addTopChrome(this);

        const box = new St.BoxLayout({style_class: 'lang-indicator-content'});
        this.bin.set_child(box);
        this._label = new St.Label({style_class: 'lang-indicator-label'});
        box.add_child(this._label);
    }

    show(text, rect) {
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
        Main.layoutManager.uiGroup.remove_child(this._dummyCursor);
        this._dummyCursor = null;
        super.destroy();
    }
};

export default class LangIndicatorExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        this._inputSourceManager = getInputSourceManager();
        this._panelService = getIBusManager()._panelService;
        this._lastGeometry = null;

        // Смена источника ввода (раскладки).
        this._inputSourceManager.connectObject(
            'current-source-changed', () => this._showCurrentLayout(), this);

        // Основной путь: позиция каретки от IBus panel service.
        if (this._panelService) {
            this._panelService.connectObject(
                'set-cursor-location', (_svc, x, y, w, h) => {
                    this._lastGeometry = {x, y, width: w, height: h};
                },
                'set-cursor-location-relative', (_svc, x, y, w, h) => {
                    const wActor =
                        global.display.focus_window?.get_compositor_private();
                    if (!wActor)
                        return;
                    this._lastGeometry = {
                        x: wActor.x + x,
                        y: wActor.y + y,
                        width: w,
                        height: h,
                    };
                },
                this);
        }

        // Fallback: AT-SPI для приложений, не сообщающих позицию в IBus.
        this._initAtspiFallback();

        // Показ при запуске утилиты.
        this._showCurrentLayout();
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
            const text = event.source?.get_text_iface();
            if (!text)
                return;
            const extents = text.get_character_extents(
                text.get_caret_offset(), Atspi.CoordType.WINDOW);
            const rect = this._convertExtentsToScreenSpace(text, extents);
            if (rect)
                this._lastGeometry = rect;
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

        const labels = Main.panel.statusArea.keyboard?._indicatorLabels;
        if (labels && labels[src.index])
            return labels[src.index].get_text();

        return src.shortName || '?';
    }

    _showCurrentLayout() {
        const g = this._lastGeometry;
        if (!g)
            return;
        const label = this._currentLayoutLabel();
        if (!label)
            return;
        this._indicator.show(label, g);
    }

    disable() {
        this._inputSourceManager?.disconnectObject(this);
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
        this._panelService = null;
        this._lastGeometry = null;
    }
}
