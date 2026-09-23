# 原理详解

这份文档记录「僵尸托盘图标」的完整成因与本扩展的设计取舍，方便后来者（也包括未来的我）不用重新排查一遍。

---

## 1. GNOME 上「托盘图标」是怎么工作的

Linux 上其实有**两套**托盘协议，Ubuntu 两者都支持：

| 协议 | 说明 | 本扩展是否处理 |
|---|---|---|
| **StatusNotifierItem (SNI)** | 现代方案（KDE 提出，freedesktop 事实标准）。程序通过 D-Bus 注册一个「条目」，由 watcher 统一管理 | ✅ 处理 |
| **XEmbed（legacy）** | 老式方案：程序在面板里嵌一个小窗口。GNOME 用 `Shell.TrayManager` 兼容 | ❌ 不处理（另有增删机制） |

SNI 的角色分工：

```
应用程序  ──RegisterStatusNotifierItem──▶  StatusNotifierWatcher   （注册表，由扩展自己提供）
                                              │
                                              │ 新增/移除条目
                                              ▼
                                        IndicatorStatusIcon        （面板上的那个图标控件）
```

关键点：**「注册表里的条目」和「面板上的图标控件」是两份独立的状态**。
只有当两者同步时，你看到的托盘才是对的——而 bug 就出在它们会不同步。

相关代码（Ubuntu 22.04 自带）：

```
/usr/share/gnome-shell/extensions/ubuntu-appindicators@ubuntu.com/
├── extension.js              入口：enable/disable
├── statusNotifierWatcher.js  注册表（watcher）+ 条目增删
├── appIndicator.js           单个条目的代理与状态
├── indicatorStatusIcon.js    面板上的图标控件
├── trayIconsManager.js       XEmbed（legacy）托盘
└── util.js                   工具函数，含 tryCleanupOldIndicators()
```

---

## 2. bug 到底在哪

### 2.1 注册表移除条目的条件太窄

`statusNotifierWatcher.js`：

```js
_itemVanished(id) {
    // FIXME: this is useless if the path name disappears while the bus stays alive (not unheard of)
    if (this._items.has(id))
        this._remove(id);
}
```

作者的 FIXME 说得很直白：**如果 D-Bus 总线名还在、只是对象路径没了，这个函数什么也做不了**。

触发场景举例：

- 程序**重新注册**托盘图标（先注册新的、再移除旧的失败）
- 程序**异常退出**（`kill -9`、崩溃）—— 来不及调用 `UnregisterStatusNotifierItem`
- 程序换了 bus name 但旧条目没被正确清理

结果：注册表里的条目还在（或新旧并存），而**面板上的图标控件没被销毁** → 僵尸图标。

### 2.2 上游的补救「一刀切」，只能在启动时跑一次

`util.js`：

```js
function tryCleanupOldIndicators() {
    const indicatorType = IndicatorStatusIcon.BaseStatusIcon;
    const indicators = Object.values(Main.panel.statusArea).filter(i => i instanceof indicatorType);
    try {
        const panelBoxes = [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
        panelBoxes.forEach(box =>
            indicators.push(...box.get_children().filter(i => i instanceof indicatorType)));
    } catch (e) {
        logError(e);
    }
    new Set(indicators).forEach(i => i.destroy());   // ← 全销毁
}
```

它把面板上**所有** appindicator 图标都 `destroy()`，指望它们随后重新注册回来。
所以它**不可能**在运行期反复调用（那会让整个托盘反复清空），只能在 `extension.js` 的 `enable()` 里跑一次：

```js
function enable() {
    isEnabled = true;
    Util.tryCleanupOldIndicators();
    maybeEnableAfterNameAvailable();
    TrayIconsManager.TrayIconsManager.initialize();
}
```

**这解释了一个很典型的现象**：

> 手动「重载托盘扩展」或「重启 GNOME Shell」能修好 → 因为触发了那次一次性清理；
> 但过一阵又会出现 → 因为运行期的泄漏没人管。

---

## 3. 本扩展的做法

把「全销毁」改成「只销毁确认是孤儿的」，于是**可以安全地定期运行**。

### 3.1 数据来源

| 需要什么 | 从哪拿 |
|---|---|
| 注册表当前有哪些条目 | D-Bus 属性 `org.kde.StatusNotifierWatcher.RegisteredStatusNotifierItems`（`as`） |
| 面板上有哪些托盘图标 | `Main.panel.statusArea` 里键名以 `appindicator-` 开头的项 |
| 图标对应的条目 id | 就是键名去掉前缀（`indicatorStatusIcon.js` 里 `addToStatusArea('appindicator-' + this.uniqueId, ...)`） |
| 老式图标是否还活着 | id 形如 `legacy:<窗口类>:<pid>`，直接查 `/proc/<pid>` |
| SNI 图标对象是否还存在 | 异步读一次该条目的 `org.kde.StatusNotifierItem.Id` 属性 |

面板键名与注册表 id 用的是**同一个字符串**（busName + objectPath，例如
`:1.722/org/ayatana/NotificationItem/tray_icon_tray_app_clash_verge_rev_tray`），
所以可以直接集合比较。

### 3.1.1 两个必须绕开的坑

| 坑 | 后果 | 绕法 |
|---|---|---|
| 注册表服务由 `ubuntu-appindicators` **在 gnome-shell 进程内**提供 | 用同步 `call_sync` 查它会自锁（主循环被堵住，回复发不出来），每次都超时 | 全程异步 `call()`
 + `Gio.DBusProxy` 属性缓存（缓存随 `PropertiesChanged` 自动更新） |
| 本扩展的 `enable()` 早于注册表服务抢占 D-Bus 名字 | 此时建立的代理缓存永远是 `null`，每轮都静默跳过 = 从不清理 | 缓存为空 → 重建代理重试；再不行 → 发异步刷新，下一轮生效 |

### 3.2 判定流程

```
每 8 秒：
  reg   = 注册表 id 集合
  面板上所有托盘图标（appindicator- 前缀）

  对每个图标：
      legacy:<窗口类>:<pid>            → 看 /proc/<pid>；不存在 → 可疑计数 +1
      不在 reg 里                      → 可疑计数 +1
      在 reg 里，但异步探测回答
        "没这个对象/没这个服务"         → 可疑计数 +1（上游 FIXME 的场景）
      其余（含探测结果还没回来、
        超时等不确定情况）              → 当作活着，清除可疑计数

  可疑计数 ≥ 2（约 16 秒）             → 确认为僵尸，加入待清理列表

  待清理列表为空                       → 什么都不做（绝大多数时候如此）
  待清理列表 > 3 个                    → 只报告、不动手（保险丝 3）
  否则                                 → destroy() 掉它，并从 statusArea 里删键
```

### 3.3 为什么这样是安全的

- **只读**：本扩展不往注册表里写任何东西，不改变任何程序的注册状态
- **可逆**：销毁的是一个已经没人引用的控件；即使判断错了，用户重启那个程序即可恢复
- **失败安全**：三道保险丝让「规则失效」时的行为退化成「什么都不做」，而不是「乱杀」；
  任何探测结果不确定（超时、异常）都按"活着"处理

---

## 4. 排查用到的命令（留给后来者）

```bash
# 1. 看注册表里现在有哪些条目
gdbus call --session --dest org.kde.StatusNotifierWatcher --object-path /StatusNotifierWatcher \
  --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems

# 2. 看某个条目属于哪个进程（判断程序是否还活着）
gdbus call --session --dest org.kde.StatusNotifierWatcher --object-path /StatusNotifierWatcher \
  --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems \
  | grep -oE "'[^']+'" | tr -d "'" | while read i; do
      bus="${i%%/*}"; path="/${i#*/}"
      echo "--- $i"
      gdbus call --session --dest "$bus" --object-path "$path" \
        --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierItem Title
      gdbus call --session --dest "$bus" --object-path "$path" \
        --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierItem IconName
      busctl --user status "$bus" | grep -E 'PID|Comm'
    done

# 3. 看面板上实际挂着哪些图标控件（需要能执行 JS 的环境；或者看本扩展的日志）
journalctl --user -f | grep tray-cleaner

# 4. 上游一次性清理的手动触发方式
gnome-extensions disable ubuntu-appindicators@ubuntu.com && sleep 1 && \
gnome-extensions enable  ubuntu-appindicators@ubuntu.com

# 5. 更彻底：重启 GNOME Shell（X11 下不会丢窗口）
kill -TERM $(systemctl --user show org.gnome.Shell@x11.service -p MainPID --value)
```

---

## 5. 调试本扩展

扩展里的日志前缀是 `[tray-cleaner]`：

| 日志 | 含义 |
|---|---|
| `已启用：每 8 秒检查一次…` | 正常启动 |
| `清理僵尸托盘图标: <id>` | 抓到一个并清掉了（**正常工作中**） |
| `注册表为空但面板上还有 N 个图标 → 判定为异常，暂停清理` | 保险丝 1 生效（说明注册表读不到/为空） |
| `图标数(N)与注册表项数(M)差距过大 → 判定为规则失效，暂停清理` | 保险丝 2 生效（多半是上游改了键名格式） |
| `一轮内发现 N 个疑似僵尸图标 → 判定为可疑，本轮不清理（只报告）` | 保险丝 3 生效（一次性泄漏这么多不正常） |

如果看到保险丝 2 或 3 反复出现，说明**上游实现变了或出现了新 bug**，请开 issue 附上日志。
