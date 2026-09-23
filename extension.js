// Tray Zombie Cleaner — 自动清理 GNOME 托盘里的僵尸图标
// https://github.com/wenziji-hub/gnome-tray-zombie-cleaner
// 许可: MIT
//
// 适用于 Ubuntu 22.04 LTS / GNOME Shell 42。
// 原理与排查过程见 docs/how-it-works.md。
//

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;

const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';
const WATCHER_IFACE = 'org.kde.StatusNotifierWatcher';
const KEY_PREFIX = 'appindicator-';

const CHECK_MS = 8000;   // 检查间隔
const STRIKES = 2;       // 连续命中几次才动手（2 次 ≈ 8 秒）
const MAX_LOG = 30;

let _proxy = null;
let _timerId = 0;
let _strikes = new Map();
let _cleaned = 0;
let _logCount = 0;
let _warnedEmpty = false;
let _warnedMismatch = false;

function _registeredIds() {
    try {
        if (!_proxy)
            return null;
        const v = _proxy.get_cached_property('RegisteredStatusNotifierItems');
        if (!v)
            return null;
        return new Set(v.deep_unpack().map(String));
    } catch (e) {
        return null;
    }
}

function _check() {
    const reg = _registeredIds();
    if (!reg)
        return;   // 注册表读不到就什么都不做（绝不冒险乱杀）

    const area = Main.panel.statusArea;
    const keys = Object.keys(area).filter(k => k.startsWith(KEY_PREFIX));

    // ── 保险丝 1：注册表为空却还有图标 → 认为注册表不可信，一律不动手 ──
    if (reg.size === 0 && keys.length > 0) {
        if (!_warnedEmpty) {
            _warnedEmpty = true;
            log('[tray-cleaner] 注册表为空但面板上还有 ' + keys.length +
                ' 个图标 → 判定为异常，暂停清理（保护性跳过）');
        }
        return;
    }
    _warnedEmpty = false;

    // ── 保险丝 2：面板图标数比注册表项数多出一大截 → 匹配规则可能失效，不动手 ──
    const snIcons = keys.filter(k => !k.slice(KEY_PREFIX.length).startsWith('legacy:'));
    if (snIcons.length - reg.size > 2) {
        if (!_warnedMismatch) {
            _warnedMismatch = true;
            logError(new Error('[tray-cleaner] 图标数(' + snIcons.length + ')与注册表项数(' +
                reg.size + ')差距过大 → 判定为规则失效，暂停清理'));
        }
        return;
    }
    _warnedMismatch = false;

    const alive = new Set();
    const orphans = [];   // 本轮确认的孤儿（先收集，再决定动不动手）

    for (const key of keys) {
        const uid = key.slice(KEY_PREFIX.length);
        alive.add(uid);

        // 老式 XEmbed 托盘图标（uniqueId 形如 legacy:xxx:pid）本来就不登记在
        // SNI 注册表里，由 TrayIconsManager 自己管增删 —— 必须跳过，否则会误杀。
        if (uid.startsWith('legacy:')) {
            _strikes.delete(uid);
            continue;
        }

        if (reg.has(uid)) {
            _strikes.delete(uid);      // 注册表里有 → 正常图标，重置计数
            continue;
        }

        const n = (_strikes.get(uid) || 0) + 1;
        _strikes.set(uid, n);
        if (n >= STRIKES)
            orphans.push([key, uid]);
    }

    // ── 保险丝 3：一轮要清 2 个以上 → 视为可疑，只报警不动手 ──
    if (orphans.length > 1) {
        logError(new Error('[tray-cleaner] 一轮内发现 ' + orphans.length +
            ' 个疑似僵尸图标 → 判定为可疑，本轮不清理（只报告）: ' +
            orphans.map(o => o[1]).join(', ')));
        return;
    }

    for (const [key, uid] of orphans) {
        _strikes.delete(uid);
        const icon = area[key];
        try {
            if (_logCount < MAX_LOG) {
                _logCount++;
                log('[tray-cleaner] 清理僵尸托盘图标: ' + uid);
            }
            if (icon && typeof icon.destroy === 'function')
                icon.destroy();
            delete area[key];
            _cleaned++;
        } catch (e) {
            log('[tray-cleaner] 清理失败(' + uid + '): ' + e);
        }
    }

    for (const uid of Array.from(_strikes.keys())) {
        if (!alive.has(uid))
            _strikes.delete(uid);
    }
}

function init() {
    return {
        enable() {
            _strikes = new Map();
            _cleaned = 0;
            _logCount = 0;
            _warnedEmpty = false;
            _warnedMismatch = false;

            try {
                _proxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                    WATCHER_NAME, WATCHER_PATH, WATCHER_IFACE, null);
            } catch (e) {
                log('[tray-cleaner] 无法连接托盘注册表: ' + e);
                _proxy = null;
            }

            if (_proxy) {
                _timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHECK_MS, () => {
                    try {
                        _check();
                    } catch (e) {
                        log('[tray-cleaner] 检查异常: ' + e);
                    }
                    return GLib.SOURCE_CONTINUE;
                });
                log('[tray-cleaner] 已启用：每 ' + (CHECK_MS / 1000) + ' 秒检查一次僵尸托盘图标' +
                    '（连续 ' + STRIKES + ' 次确认才清理）');
            }
        },

        disable() {
            if (_timerId) {
                GLib.source_remove(_timerId);
                _timerId = 0;
            }
            _proxy = null;
            _strikes = new Map();
            log('[tray-cleaner] 已停用（共清理 ' + _cleaned + ' 个僵尸图标）');
        },
    };
}
