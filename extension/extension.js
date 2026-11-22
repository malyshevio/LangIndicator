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
const ENABLE_ATSPI_FALLBACK = true;

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
        this._visible = false;
        this._lastAtspiAt = 0;
        this._updateScheduled = false;
        this._windowActor = null;
        this._actorX = 0;
        this._actorY = 0;

        // IBus panel service создаётся асинхронно: подписываемся на ready.
        this._ibusManager.connectObject(
            'ready', () => this._syncPanelService(), this);
        this._syncPanelService();

        // AT-SPI — приоритетный источник позиции каретки.
        if (ENABLE_ATSPI_FALLBACK)
            this._initAtspiFallback();

        // Смена раскладки — обновляем текст индикатора.
        this._inputSourceManager.connectObject(
            'current-source-changed', () => this._updateIndicator(), this);

        // Смена окна — скрываем, пока не придёт позиция каретки нового окна.
        global.display.connectObject(
            'notify::focus-window', () => this._onFocusWindowChanged(), this);
        this._onFocusWindowChanged();
    }

    _onFocusWindowChanged() {
        if (this._windowActor) {
            this._windowActor.disconnectObject(this);
            this._windowActor = null;
        }

        const win = global.display.focus_window;
        const actor = win?.get_compositor_private();
        if (actor) {
            this._windowActor = actor;
            this._actorX = actor.x;
            this._actorY = actor.y;
            actor.connectObject(
                'notify::x', () => this._followWindow(),
                'notify::y', () => this._followWindow(),
                this);
        }

        this._hideIndicator();
    }

    // Каретка на экране смещается вместе с окном — сдвигаем позицию индикатора.
    _followWindow() {
        if (!this._windowActor || !this._geometry)
            return;

        const dx = this._windowActor.x - this._actorX;
        const dy = this._windowActor.y - this._actorY;
        if (dx === 0 && dy === 0)
            return;

        this._actorX = this._windowActor.x;
        this._actorY = this._windowActor.y;
        this._geometry.x += dx;
        this._geometry.y += dy;

        if (this._visible)
            this._updateIndicator();
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
        // AT-SPI точнее; если он недавно присылал позицию — IBus не перебиваем.
        if (this._lastAtspiAt &&
            GLib.get_monotonic_time() - this._lastAtspiAt < 800000)
            return;

        // IBus может прислать «пустую» позицию 0,0,0,0 до того, как узнает
        // каретку. Реальный прямоугольник каретки имеет ненулевую высоту
        // (ширина может быть 0 — это вертикальная черта).
        if (w === 0 && h === 0)
            return;

        const rect = this._toStage(x, y, w, h, relative);
        if (!rect)
            return;

        const fw = global.display.focus_window;
        const fr = fw ? fw.get_frame_rect() : null;
        this._geometry = rect;
        this._visible = true;
        log(`[LangIndicator] caret ${relative ? 'rel' : 'abs'} raw=${x},${y} win=${fr ? `${fr.x},${fr.y}` : '?'} kf=${!!global.stage.key_focus} -> ${rect.x},${rect.y}`);
        this._scheduleUpdate();
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
            log('[LangIndicator] AT-SPI listener registered');
        } catch (e) {
            log(`[LangIndicator] AT-SPI fallback выключен: ${e.message}`);
            this._atspiListener = null;
        }
    }

    _onAtspiCaretMoved(event) {
        try {
            const accessible = event.source;
            const text = accessible?.get_text_iface();
            if (!text) {
                log('[LangIndicator] atspi: событие без text-интерфейса');
                return;
            }
            const extents = text.get_character_extents(
                text.get_caret_offset(), Atspi.CoordType.WINDOW);
            const rect = this._convertExtentsToScreenSpace(accessible, extents);
            if (!rect) {
                log('[LangIndicator] atspi: позиция отфильтрована/пустая');
                return;
            }
            this._lastAtspiAt = GLib.get_monotonic_time();
            this._geometry = rect;
            this._visible = true;
            log(`[LangIndicator] atspi caret -> ${rect.x},${rect.y}`);
            this._scheduleUpdate();
        } catch (e) {
            log(`[LangIndicator] atspi error: ${e.message}`);
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

            // Только события приложения из текущего окна фокуса.
            const focusWindow = global.display.focus_window;
            if (focusWindow) {
                const focusPid = focusWindow.get_pid();
                if (focusPid > 0 && app) {
                    let appPid = -1;
                    try {
                        appPid = app.get_process_id();
                    } catch (e2) {
                        appPid = -1;
                    }
                    if (appPid > 0 && appPid !== focusPid)
                        return null;
                }
            }
        } catch (e) {
            return null;
        }

        const focusWindow = global.display.focus_window;
        if (!focusWindow)
            return null;

        const windowRect = focusWindow.get_client_content_rect();
        const scaleFactor =
            St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const x = windowRect.x + (scaleFactor * extents.x);
        const y = windowRect.y + (scaleFactor * extents.y);

        // Санити-чек: каретка должна попадать в окно. AT-SPI для терминалов и
        // больших текстовых буферов иногда даёт смещение за пределы окна.
        if (x < windowRect.x - 8 || x > windowRect.x + windowRect.width + 8 ||
            y < windowRect.y - 8 || y > windowRect.y + windowRect.height + 8)
            return null;

        return {
            x,
            y,
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
        this._visible = false;
        if (this._indicator)
            this._indicator.close(BoxPointer.PopupAnimation.NONE);
    }

    _scheduleUpdate() {
        if (this._updateScheduled)
            return;
        this._updateScheduled = true;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            this._updateScheduled = false;
            this._updateIndicator();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateIndicator() {
        if (!this._geometry || !this._visible)
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
        this._windowActor?.disconnectObject(this);
        this._windowActor = null;

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
        this._visible = false;
        this._lastAtspiAt = 0;
        this._updateScheduled = false;
    }
}
