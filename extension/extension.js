// Lang Indicator — индикатор раскладки у курсора ввода (GNOME Shell, Wayland).
//
// Текущее ТЗ:
//   • индикатор НЕ исчезает (без автоскрытия);
//   • позиция следует за кареткой в ЛЮБОМ окне (на каждое set-cursor-location*);
//   • текст («RU»/«EN») обновляется при смене раскладки.
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
// Глобальный AT-SPI listener может ронять сессию (нативный крэш). Временно
// отключён — включить обратно только после диагностики по журналу.
const ENABLE_ATSPI_FALLBACK = false;

const Indicator = class Indicator extends BoxPointer.BoxPointer {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(St.Side.TOP);
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

    // Показать/обновить текст и позицию. Не скрывается автоматически.
    // Названо не show(), чтобы не перекрыть Clutter.Actor.show(), который
    // BoxPointer.open() вызывает внутри себя.
    update(text, rect) {
        this._label.text = text;
        this._dummyCursor.set_position(rect.x, rect.y);
        this._dummyCursor.set_size(
            rect.width > 0 ? rect.width : 1,
            rect.height > 0 ? rect.height : 1);
        this.setPosition(this._dummyCursor, 0);

        if (!this.visible)
            this.open(BoxPointer.PopupAnimation.NONE);
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
        this._indicator = new Indicator();
        this._inputSourceManager = getInputSourceManager();
        this._ibusManager = getIBusManager();
        this._panelService = null;
        this._geometry = null;

        // IBus panel service создаётся асинхронно: подписываемся на ready.
        this._ibusManager.connectObject(
            'ready', () => this._syncPanelService(), this);
        this._syncPanelService();

        // Смена раскладки — обновляем текст индикатора.
        this._inputSourceManager.connectObject(
            'current-source-changed', () => this._updateIndicator(), this);

        // Смена окна — скрываем, пока не придёт позиция каретки нового окна.
        global.display.connectObject(
            'notify::focus-window', () => this._hideIndicator(), this);
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

        this._panelService.connectObject(
            'set-cursor-location', (_svc, x, y, w, h) => {
                this._setGeometry(x, y, w, h, false);
            }, this);

        try {
            this._panelService.connectObject(
                'set-cursor-location-relative', (_svc, x, y, w, h) => {
                    this._setGeometry(x, y, w, h, true);
                }, this);
        } catch (e) {
            // Only recent IBus versions have support for this signal.
        }

        // Потеря фокуса ввода (каретка пропала) — скрываем индикатор.
        this._panelService.connectObject(
            'focus-out', () => this._hideIndicator(), this);
    }

    _setGeometry(x, y, w, h, relative) {
        // IBus может прислать «пустую» позицию 0,0,0,0 до того, как узнает
        // каретку. Реальный прямоугольник каретки имеет ненулевую высоту
        // (ширина может быть 0 — это вертикальная черта).
        if (w === 0 && h === 0)
            return;

        const rect = this._toStage(x, y, w, h, relative);
        if (!rect)
            return;

        this._geometry = rect;
        log(`[LangIndicator] caret ${relative ? 'rel' : 'abs'} raw=${x},${y},${w},${h} -> ${rect.x},${rect.y}`);
        this._updateIndicator();
    }

    // Перевод координат IBus в stage. Повторяет ui/ibusCandidatePopup.js.
    _toStage(x, y, w, h, relative) {
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
                this._geometry = rect;
                this._updateIndicator();
            }
        } catch (e) {
            // Игнорируем отдельные события без корректных extents.
        }
    }

    // Перевод extents из window-координат AT-SPI в stage. Логика magnifier.js.
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

    _hideIndicator() {
        this._geometry = null;
        if (this._indicator)
            this._indicator.close(BoxPointer.PopupAnimation.NONE);
    }

    _updateIndicator() {
        if (!this._geometry)
            return;
        const label = this._currentLayoutLabel();
        if (!label)
            return;
        this._indicator.update(label, this._geometry);
    }

    disable() {
        this._inputSourceManager?.disconnectObject(this);
        this._ibusManager?.disconnectObject(this);
        this._panelService?.disconnectObject(this);
        global.display?.disconnectObject(this);

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
        this._geometry = null;
    }
}
