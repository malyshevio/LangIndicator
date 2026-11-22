// Lang Indicator — индикатор раскладки у курсора ввода (GNOME Shell, Wayland).
//
// Позиционирование: IBus (set-cursor-location*) даёт точные stage-координаты, но
// приходит только при движении/вводе. AT-SPI дополняет — показывает позицию при
// фокусе и на стрелках (IBus там молчит). Приоритета нет: последнее событие
// (IBus или AT-SPI) побеждает.
//
// Поведение: индикатор следует за кареткой, не исчезает; скрывается при потере
// фокуса; при смене окна ждёт позицию новой каретки (не висит на прошлой).

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
const ENABLE_ATSPI_FALLBACK = true;
const DEBUG = true;

const Indicator = class Indicator extends BoxPointer.BoxPointer {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(St.Side.TOP);
        this.visible = false;
        this.add_style_class_name('lang-indicator-boxpointer');

        this._dummyCursor = new Clutter.Actor({opacity: 0});
        Main.layoutManager.uiGroup.add_child(this._dummyCursor);
        Main.layoutManager.addTopChrome(this);

        const box = new St.BoxLayout({style_class: 'lang-indicator-content'});
        this.bin.set_child(box);
        this._label = new St.Label({style_class: 'lang-indicator-label'});
        box.add_child(this._label);
    }

    // Названо не show(), чтобы не перекрыть Clutter.Actor.show().
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
        const version = this.metadata?.['version-name'] ?? 'unknown';
        log(`[LangIndicator] v${version} enable`);
        this._indicator = new Indicator();
        this._inputSourceManager = getInputSourceManager();
        this._ibusManager = getIBusManager();
        this._panelService = null;

        this._geometry = null;
        this._visible = false;
        this._updateScheduled = false;
        this._updateTimeoutId = 0;
        this._windowActor = null;
        this._actorX = 0;
        this._actorY = 0;

        this._ibusManager.connectObject(
            'ready', () => this._syncPanelService(), this);
        this._syncPanelService();

        if (ENABLE_ATSPI_FALLBACK)
            this._initAtspiFallback();

        this._inputSourceManager.connectObject(
            'current-source-changed', () => this._updateIndicator(), this);

        global.display.connectObject(
            'notify::focus-window', () => this._onFocusWindowChanged(), this);
        this._onFocusWindowChanged();
    }

    _syncPanelService() {
        if (this._panelService) {
            this._panelService.disconnectObject(this);
            this._panelService = null;
        }

        const service = this._ibusManager._panelService;
        if (!this._ibusManager._ready || !service) {
            if (DEBUG)
                log(`[LangIndicator] ibus panel service не готов (ready=${this._ibusManager._ready}, service=${!!service})`);
            return;
        }

        this._panelService = service;
        if (DEBUG)
            log('[LangIndicator] ibus panel service подключён');

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

        this._panelService.connectObject(
            'focus-out', () => this._hideIndicator('focus-out'), this);
    }

    _onFocusWindowChanged() {
        if (this._windowActor) {
            this._windowActor.disconnectObject(this);
            this._windowActor = null;
        }

        const win = global.display.focus_window;
        const actor = win?.get_compositor_private();
        if (DEBUG)
            log(`[LangIndicator] focus window=${win ? win.get_id() : 'null'} actor=${actor ? `${actor.x},${actor.y}` : 'null'}`);
        if (actor) {
            this._windowActor = actor;
            this._actorX = actor.x;
            this._actorY = actor.y;
            actor.connectObject(
                'notify::x', () => this._followWindow(),
                'notify::y', () => this._followWindow(),
                this);
        }

        // Смена окна: сбрасываем геометрию, чтобы не показать на прошлом месте.
        this._geometry = null;
        this._hideIndicator('focus-window-changed');
    }

    // Каретка на экране смещается вместе с окном — сдвигаем позицию.
    _followWindow() {
        if (!this._windowActor)
            return;

        const dx = this._windowActor.x - this._actorX;
        const dy = this._windowActor.y - this._actorY;
        if (dx === 0 && dy === 0)
            return;
        if (DEBUG)
            log(`[LangIndicator] window moved dx=${dx} dy=${dy}`);

        // Базу обновляем ВСЕГДА, даже без геометрии каретки: иначе при
        // следующем движении применим накопленную дельту повторно.
        this._actorX = this._windowActor.x;
        this._actorY = this._windowActor.y;

        if (!this._geometry)
            return;

        this._geometry.x += dx;
        this._geometry.y += dy;

        if (this._visible)
            this._scheduleUpdate();
    }

    _setGeometry(x, y, w, h, relative) {
        if (w === 0 && h === 0)
            return;

        const rect = this._toStage(x, y, w, h, relative);
        if (!rect)
            return;

        const focusWindow = global.display.focus_window;
        if (!focusWindow) {
            if (DEBUG)
                log('[LangIndicator] caret: нет окна фокуса, skip');
            return;
        }

        // Санити-чек: каретка должна быть в пределах окна фокуса. Опираемся на
        // rect window actor (на него же опирается конвертация); отсекает
        // «запоздалые» события от предыдущего окна.
        const winActor = focusWindow.get_compositor_private();
        const fr = focusWindow.get_frame_rect();
        const bx = winActor ? winActor.x : fr.x;
        const by = winActor ? winActor.y : fr.y;
        const bw = winActor ? winActor.width : fr.width;
        const bh = winActor ? winActor.height : fr.height;
        if (rect.x < bx - 16 || rect.x > bx + bw + 16 ||
            rect.y < by - 16 || rect.y > by + bh + 16) {
            if (DEBUG)
                log(`[LangIndicator] caret ${rect.x},${rect.y} вне окна ${bx},${by} ${bw}x${bh}, skip`);
            return;
        }

        this._geometry = rect;
        this._visible = true;
        if (DEBUG)
            log(`[LangIndicator] caret ${relative ? 'rel' : 'abs'} raw=${x},${y} -> ${rect.x},${rect.y}`);
        this._scheduleUpdate();
    }

    // Перевод координат IBus в stage. Повторяет ui/ibusCandidatePopup.js.
    _toStage(x, y, w, h, relative) {
        const focusWindow = global.display.focus_window;
        if (!focusWindow) {
            if (DEBUG)
                log('[LangIndicator] _toStage: нет окна фокуса');
            return null;
        }

        let rect = new Mtk.Rectangle({x, y, width: w, height: h});

        if (relative) {
            rect = focusWindow.protocol_to_stage_rect(rect);
            const windowActor = focusWindow.get_compositor_private();
            if (!windowActor) {
                if (DEBUG)
                    log('[LangIndicator] _toStage: нет window actor (relative)');
                return null;
            }
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

    // --- AT-SPI fallback (включён под флагом ENABLE_ATSPI_FALLBACK) ---
    _initAtspiFallback() {
        this._atspiListener = null;
        try {
            const initRet = Atspi.init();
            if (initRet !== 0 && initRet !== 1) {
                log(`[LangIndicator] AT-SPI недоступен (init=${initRet})`);
                return;
            }
            Atspi.set_timeout(250, 250);
            this._atspiListener =
                Atspi.EventListener.new(this._onAtspiCaretMoved.bind(this));
            this._atspiListener.register(CARET_MOVED);
            this._atspiListener.register('object:state-changed:focused');
            log('[LangIndicator] AT-SPI listener registered');
        } catch (e) {
            log(`[LangIndicator] AT-SPI fallback выключен: ${e.message}`);
            this._atspiListener = null;
        }
    }

    _onAtspiCaretMoved(event) {
        if (!this._indicator || !this._inputSourceManager)
            return;
        try {
            const type = event?.type ?? '';
            const isCaret = type === 'object:text-caret-moved';
            const isFocus = type === 'object:state-changed:focused' &&
                event.detail1 === 1;
            if (!isCaret && !isFocus)
                return;

            const accessible = event.source;
            const text = accessible?.get_text_iface();
            if (!text) {
                if (DEBUG)
                    log('[LangIndicator] atspi: нет text iface, skip');
                return;
            }
            // Для caret-moved берём offset из события (detail1) — запрос
            // get_caret_offset() может вернуть устаревший (на шаг позади).
            const caretOffset = isCaret ? event.detail1 : text.get_caret_offset();
            if (caretOffset < 0) {
                if (DEBUG)
                    log('[LangIndicator] atspi: caret offset < 0, skip');
                return;
            }
            const extents = text.get_character_extents(
                caretOffset, Atspi.CoordType.WINDOW);
            if (!extents || (extents.width === 0 && extents.height === 0)) {
                if (DEBUG)
                    log('[LangIndicator] atspi: пустые extents, skip');
                return;
            }
            const rect = this._convertExtentsToScreenSpace(accessible, extents, isFocus);
            if (!rect)
                return;
            this._geometry = rect;
            this._visible = true;
            if (DEBUG)
                log(`[LangIndicator] atspi ${isFocus ? 'focus' : 'caret'} -> ${rect.x},${rect.y}`);
            this._scheduleUpdate();
        } catch (e) {
            if (DEBUG)
                log(`[LangIndicator] atspi error: ${e.message}`);
        }
    }

    _convertExtentsToScreenSpace(accessible, extents, isFocus) {
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

            if (app && app.get_name() === 'gnome-shell') {
                // Свои (shell) extents уже в stage-координатах — возвращаем как есть,
                // чтобы индикатор работал в поиске приложений и диалогах GNOME.
                return {
                    x: extents.x,
                    y: extents.y,
                    width: extents.width,
                    height: extents.height,
                };
            }

            // PID — статичная идентичность, не «отстаёт»; проверяем всегда,
            // чтобы отсечь запоздалые focus-события от другого приложения.
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
                    if (appPid > 0 && appPid !== focusPid) {
                        if (DEBUG)
                            log(`[LangIndicator] atspi: pid не совпал (app=${appPid}, focus=${focusPid}), skip`);
                        return null;
                    }
                }
            }

            // ACTIVE/FOCUSED в a11y-кеше отстают от реального фокуса — для
            // focus-события доверяем самому событию; для caret-moved — строго.
            if (!isFocus) {
                const windowActive = parentWindow &&
                    parentWindow.get_state_set().contains(Atspi.StateType.ACTIVE);
                const accessibleFocused =
                    accessible.get_state_set().contains(Atspi.StateType.FOCUSED);
                if (!windowActive || !accessibleFocused) {
                    if (DEBUG)
                        log(`[LangIndicator] atspi: не в фокусе (windowActive=${!!windowActive}, accessibleFocused=${!!accessibleFocused}), skip`);
                    return null;
                }
            }
        } catch (e) {
            if (DEBUG)
                log(`[LangIndicator] atspi: convert error ${e.message}`);
            return null;
        }

        const focusWindow = global.display.focus_window;
        if (!focusWindow)
            return null;

        // По контракту mutter AT-SPI window-координаты отсчитываются от
        // get_client_content_rect() (см. meta_window_get_client_content_rect и
        // magnifier.js). Берём этот origin.
        const windowRect = focusWindow.get_client_content_rect();
        const scaleFactor =
            St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const x = windowRect.x + (scaleFactor * extents.x);
        const y = windowRect.y + (scaleFactor * extents.y);

        if (x < windowRect.x - 16 || x > windowRect.x + windowRect.width + 16 ||
            y < windowRect.y - 16 || y > windowRect.y + windowRect.height + 16) {
            if (DEBUG)
                log(`[LangIndicator] atspi: ${x},${y} вне окна ${windowRect.x},${windowRect.y} ${windowRect.width}x${windowRect.height}, skip`);
            return null;
        }

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
        return (src.shortName || '?').toUpperCase();
    }

    _scheduleUpdate() {
        if (this._updateScheduled)
            return;
        this._updateScheduled = true;
        this._updateTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 16, () => {
                this._updateScheduled = false;
                this._updateTimeoutId = 0;
                this._updateIndicator();
                return GLib.SOURCE_REMOVE;
            });
    }

    _updateIndicator() {
        if (!this._indicator || !this._inputSourceManager)
            return;
        if (!this._geometry || !this._visible)
            return;
        const label = this._currentLayoutLabel();
        if (!label) {
            if (DEBUG)
                log('[LangIndicator] update: пустой label, skip');
            return;
        }
        this._indicator.update(label, this._geometry);
    }

    _hideIndicator(reason = '') {
        this._visible = false;
        if (this._indicator)
            this._indicator.close(BoxPointer.PopupAnimation.NONE);
        if (DEBUG)
            log(`[LangIndicator] hide${reason ? ` (${reason})` : ''}`);
    }

    disable() {
        log('[LangIndicator] disable');
        this._inputSourceManager?.disconnectObject(this);
        this._ibusManager?.disconnectObject(this);
        this._panelService?.disconnectObject(this);
        global.display?.disconnectObject(this);
        this._windowActor?.disconnectObject(this);
        this._windowActor = null;

        if (this._atspiListener) {
            try {
                this._atspiListener.deregister(CARET_MOVED);
                this._atspiListener.deregister('object:state-changed:focused');
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
        if (this._updateTimeoutId) {
            GLib.source_remove(this._updateTimeoutId);
            this._updateTimeoutId = 0;
        }

        this._geometry = null;
        this._visible = false;
        this._updateScheduled = false;
    }
}
