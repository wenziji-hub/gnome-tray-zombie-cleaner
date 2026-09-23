// 托盘僵尸图标自动清理 v3
//
// ── 背景（均已从 ubuntu-appindicators 源码核实）──
//  * 面板托盘图标的键名 = 'appindicator-' + uniqueId          （indicatorStatusIcon.js:80）
//    且只有在图标"就绪"时才会建立这个键。
//  * uniqueId 有两种：
//      SNI 图标   ":1.722/org/ayatana/NotificationItem/xxx"
//      老式 XEmbed "legacy:<窗口类>:<pid>"                      （indicatorStatusIcon.js:342）
//  * 上游自己留了 FIXME：
//      "_itemVanished: this is useless if the path name disappears while the bus stays alive"
//    → 程序换了对象路径/撤掉对象而连接还在时，注册表条目和面板图标都不会被清掉 = 僵尸图标。
//  * 注册表服务 org.kde.StatusNotifierWatcher 由 ubuntu-appindicators **在 gnome-shell 进程内**提供。
//
// ── 前两版为什么没用 ──
//  v1：只读 Gio.DBusProxy 的缓存属性。代理是在 enable() 那一刻建的，而注册表服务由
//      另一个扩展在稍后才抢占名字 —— 服务不存在时建立的代理缓存永远是 null，
//      于是每一轮都在 `if (!reg) return;` 静默跳过，从不清理。
//  v2：改成同步 call_sync 实时查询 —— 更糟：目标是**本进程内**的服务，
//      同步调用把主循环堵住，回复永远发不出来，每次都是超时。
//
// ── v3 的判定（全程非阻塞）──
//  1) 注册表：优先用 Gio.DBusProxy 缓存（它随 PropertiesChanged 自动更新，信号已实测有效）；
//     缓存为空说明代理建得太早 → 重建代理；再不行 → 发一次异步刷新。
//  2) 图标对象是否还在：异步对条目的 Id 属性发一次读取。
//     明确回答"没这个对象/没这个服务" → 僵尸；超时等不确定情况 → 当活的。
//  3) 老式图标：uid 里带 pid，直接看 /proc/<pid>。
//  4) 连续 2 轮（≈16 秒）确认才销毁；三道保险丝；任何异常都不影响 Shell。

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;

const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';
const WATCHER_IFACE = 'org.kde.StatusNotifierWatcher';
const ITEM_PROP = 'RegisteredStatusNotifierItems';
const ITEM_IFACE = 'org.kde.StatusNotifierItem';
const KEY_PREFIX = 'appindicator-';
const LEGACY_PREFIX = 'legacy:';

const CHECK_MS = 8000;            // 检查间隔
const STRIKES = 2;                // 连续确认几次才动手（2 次 ≈ 16 秒）
const MAX_ORPHANS_PER_CYCLE = 3;  // 一轮超过这个数量 → 视为可疑，只报告不动手
const HEARTBEAT_MS = 600000;      // 状态没变化时，至少每 10 分钟证明自己还活着
const PROBE_TTL_MS = 60000;       // 探测结果的有效期
const MAX_LOG = 60;

let _timerId = 0;
let _proxy = null;
let _asyncItems = null;
let _asyncAt = 0;
let _probe = new Map();           // uid -> { alive: bool, at: ms }
let _strikes = new Map();
let _noticed = new Set();
let _cleaned = 0;
let _logCount = 0;
let _lastState = '';
let _lastBeat = 0;
let _firstRun = true;
let _warnedEmpty = false;
let _warnedMismatch = false;
let _warnedNoRegistry = false;

function _now() {
    return GLib.get_monotonic_time() / 1000;
}

function _log(msg) {
    if (_logCount < MAX_LOG) {
        _logCount++;
        log('[tray-cleaner] ' + msg);
    }
}

// ── 注册表 ──────────────────────────────────────────────

function _createProxy() {
    try {
        _proxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
            WATCHER_NAME, WATCHER_PATH, WATCHER_IFACE, null);
    } catch (e) {
        _proxy = null;
    }
}

function _fromProxy() {
    try {
        const v = _proxy && _proxy.get_cached_property(ITEM_PROP);
        if (!v)
            return null;
        return new Set(v.deep_unpack().map(String));
    } catch (e) {
        return null;
    }
}

// 异步刷新（绝不用同步调用：注册表服务在本进程内，同步会自锁）
function _refreshAsync() {
    try {
        Gio.DBus.session.call(
            WATCHER_NAME, WATCHER_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [WATCHER_IFACE, ITEM_PROP]),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 3000, null,
            (conn, res) => {
                try {
                    const r = conn.call_finish(res);
                    let v = r.deep_unpack()[0];
                    if (v && typeof v.deep_unpack === 'function')
                        v = v.deep_unpack();
                    _asyncItems = new Set((v || []).map(String));
                    _asyncAt = _now();
                } catch (e) { /* 忽略：下一轮再刷 */ }
            });
    } catch (e) { /* 忽略 */ }
}

function _registry() {
    let set = _fromProxy();
    let source = '缓存';

    if (!set) {
        // 代理可能是注册表服务还没起来时建的 → 重建一次
        _createProxy();
        set = _fromProxy();
        source = '重建缓存';
    }

    if (!set && _asyncItems) {
        set = _asyncItems;
        source = '异步';
    }

    if (!set) {
        _refreshAsync();
        if (!_warnedNoRegistry) {
            _warnedNoRegistry = true;
            _log('暂时读不到托盘注册表（注册表服务可能还没起来，会自动重试）');
        }
        return null;
    }

    // 周期性做一次异步校准，防止信号丢失导致缓存过期
    if (!_asyncAt || _now() - _asyncAt > 4 * CHECK_MS)
        _refreshAsync();

    return { set: set, source: source };
}

// ── 单个图标是否还活着 ──────────────────────────────────

// 异步探测：这个 SNI 条目的对象还在吗？结果写入 _probe，供后续轮次判定
function _probeItem(uid) {
    const slash = uid.indexOf('/');
    const bus = slash > 0 ? uid.slice(0, slash) : uid;
    const path = slash > 0 ? uid.slice(slash) : '/StatusNotifierItem';

    // 自己进程里的条目不能同步查，也别去探测（会自锁），直接当活的
    try {
        if (bus === Gio.DBus.session.get_unique_name()) {
            _probe.set(uid, { alive: true, at: _now() });
            return;
        }
    } catch (e) { /* 忽略 */ }

    try {
        Gio.DBus.session.call(
            bus, path, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [ITEM_IFACE, 'Id']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 3000, null,
            (conn, res) => {
                let alive = true;
                try {
                    conn.call_finish(res);
                } catch (e) {
                    // 只有明确回答"没这个对象/没这个服务"才算死
                    if (/UnknownObject|UnknownMethod|UnknownInterface|UnknownProperty|ServiceUnknown|NameHasNoOwner|NoSuchObject/i.test(String(e)))
                        alive = false;
                }
                _probe.set(uid, { alive: alive, at: _now() });
            });
    } catch (e) { /* 忽略 */ }
}

function _legacyPid(uid) {
    const parts = uid.split(':');
    const pid = parseInt(parts[parts.length - 1], 10);
    return pid > 0 ? pid : 0;
}

function _pidAlive(pid) {
    try {
        return Gio.File.new_for_path('/proc/' + pid).query_exists(null);
    } catch (e) {
        return true;   // 查不了就当活的（保守）
    }
}

// 返回 null 表示健康；否则返回不健康的原因
function _whyNotHealthy(uid, reg) {
    if (uid.startsWith(LEGACY_PREFIX)) {
        const pid = _legacyPid(uid);
        if (!pid)
            return null;                        // 解析不出 pid → 不动
        if (_pidAlive(pid))
            return null;
        return '老式图标，进程 ' + pid + ' 已不存在';
    }

    if (!reg.set.has(uid))
        return '不在注册表里';

    const st = _probe.get(uid);
    if (st && st.alive === false)
        return '注册表里还在，但图标对象已不存在（上游 FIXME 的漏洞）';

    return null;   // 探测结果还没回来 → 先当活的，下一轮再说
}

// ── 主循环 ──────────────────────────────────────────────

function _check() {
    const reg = _registry();
    if (!reg)
        return;

    const area = Main.panel.statusArea;
    const keys = Object.keys(area).filter(k => k.startsWith(KEY_PREFIX));
    const snKeys = keys.filter(k => !k.slice(KEY_PREFIX.length).startsWith(LEGACY_PREFIX));

    // 首轮把家底全部打印出来，方便排查
    if (_firstRun) {
        _firstRun = false;
        _log('首轮盘点：statusArea 里托盘键 ' + keys.length + ' 个');
        for (const k of keys)
            _log('  · ' + k.slice(KEY_PREFIX.length));
        _log('  注册表 ' + reg.set.size + ' 项(' + reg.source + ')');
    }

    // ── 保险丝 1：注册表为空却还有 SNI 图标 → 注册表不可信，一律不动手 ──
    if (reg.set.size === 0 && snKeys.length > 0) {
        if (!_warnedEmpty) {
            _warnedEmpty = true;
            _log('注册表为空但面板上还有 ' + snKeys.length + ' 个 SNI 图标 → 判定为异常，暂停清理');
        }
        return;
    }
    _warnedEmpty = false;

    // ── 保险丝 2：SNI 图标数比注册表项数多出一大截 → 匹配规则可能失效 ──
    if (snKeys.length - reg.set.size > 2) {
        if (!_warnedMismatch) {
            _warnedMismatch = true;
            _log('SNI 图标数(' + snKeys.length + ')比注册表项数(' + reg.set.size +
                 ')多出 3 个以上 → 判定为规则失效，暂停清理');
        }
        return;
    }
    _warnedMismatch = false;

    const alive = new Set();
    const orphans = [];

    for (const key of keys) {
        const uid = key.slice(KEY_PREFIX.length);
        alive.add(uid);

        // SNI 图标：发起（或复用）一次异步存活探测
        if (!uid.startsWith(LEGACY_PREFIX)) {
            const st = _probe.get(uid);
            if (reg.set.has(uid) && (!st || _now() - st.at > PROBE_TTL_MS))
                _probeItem(uid);
        }

        const why = _whyNotHealthy(uid, reg);
        if (why === null) {
            _strikes.delete(uid);
            continue;
        }

        const n = (_strikes.get(uid) || 0) + 1;
        _strikes.set(uid, n);
        if (n === 1 && !_noticed.has(uid)) {
            _noticed.add(uid);
            _log('疑似僵尸（第 1 次确认：' + why + '）: ' + uid);
        }
        if (n >= STRIKES)
            orphans.push([key, uid, why]);
    }

    // 心跳：状态变了就打印，或每 10 分钟证明存活
    const state = reg.set.size + '|' + snKeys.length + '|' + orphans.length;
    if (state !== _lastState || _now() - _lastBeat > HEARTBEAT_MS) {
        _lastState = state;
        _lastBeat = _now();
        _log('心跳：注册表 ' + reg.set.size + ' 项(' + reg.source + ')，SNI 图标 ' + snKeys.length +
             ' 个，老式图标 ' + (keys.length - snKeys.length) + ' 个，僵尸候选 ' + orphans.length + ' 个' +
             (orphans.length ? ' [' + orphans.map(o => o[1]).join(', ') + ']' : ''));
    }

    // ── 保险丝 3：一轮要清太多 → 视为可疑，只报警不动手 ──
    if (orphans.length > MAX_ORPHANS_PER_CYCLE) {
        _log('一轮内发现 ' + orphans.length + ' 个疑似僵尸图标 → 判定为可疑，本轮不清理（只报告）: ' +
             orphans.map(o => o[1]).join(', '));
        return;
    }

    for (const [key, uid, why] of orphans) {
        _strikes.delete(uid);
        const icon = area[key];
        try {
            _log('清理僵尸托盘图标: ' + uid + '（' + why + '）');
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
    for (const uid of Array.from(_probe.keys())) {
        if (!alive.has(uid))
            _probe.delete(uid);
    }
}

function init() {
    return {
        enable() {
            _strikes = new Map();
            _probe = new Map();
            _noticed = new Set();
            _cleaned = 0;
            _logCount = 0;
            _lastState = '';
            _lastBeat = 0;
            _firstRun = true;
            _warnedEmpty = false;
            _warnedMismatch = false;
            _warnedNoRegistry = false;
            _asyncItems = null;
            _asyncAt = 0;

            _createProxy();

            _log('已启用：每 ' + (CHECK_MS / 1000) + ' 秒检查一次（连续 ' + STRIKES + ' 次确认才清理）');

            try {
                _check();   // 首轮立刻盘点
            } catch (e) {
                log('[tray-cleaner] 首轮检查异常: ' + e);
            }

            _timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHECK_MS, () => {
                try {
                    _check();
                } catch (e) {
                    log('[tray-cleaner] 检查异常: ' + e);
                }
                return GLib.SOURCE_CONTINUE;
            });
        },

        disable() {
            if (_timerId) {
                GLib.source_remove(_timerId);
                _timerId = 0;
            }
            _proxy = null;
            _strikes = new Map();
            _probe = new Map();
            log('[tray-cleaner] 已停用（共清理 ' + _cleaned + ' 个僵尸图标）');
        },
    };
}
