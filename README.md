# Tray Zombie Cleaner

> 自动清理 GNOME 托盘里的「僵尸图标」——**程序已经退出了，图标还挂在面板上**，于是同一个图标重复出现两次。
>
> Automatically removes *zombie* tray icons that Ubuntu's AppIndicator bridge leaves behind when an app exits without unregistering its icon.

### 典型现象

托盘里**同一个程序的图标并排出现两次**，而其中**一个所属的进程其实早就退出了**。
例如 Clash Verge 的猫头图标出现两个、其中一个点了没反应；或者某个程序明明已经退出，托盘里还留着它的图标。

清理扩展工作时的日志长这样：

```
$ journalctl --user -f | grep tray-cleaner
[tray-cleaner] 已启用：每 8 秒检查一次僵尸托盘图标（连续 2 次确认才清理）
[tray-cleaner] 清理僵尸托盘图标: :1.722/org/ayatana/NotificationItem/tray_icon_tray_app_clash_verge_rev_tray
```

> 本仓库不放实拍截图（避免暴露作者桌面内容）。现象与上面的描述一致：**图标重复、多出来的那个是僵尸**。

适用于 **Ubuntu 22.04 LTS / GNOME Shell 42**。

---

## 问题现象

- 托盘中**同一个程序的图标出现两次**（现实中常见的例子：Clash Verge 的猫头图标并排两个）
- 或者**程序明明已经退出**，托盘里还留着它的图标
- 手动「重启 GNOME Shell」或「重载托盘扩展」能修好，**但过一阵又会出现**

## 根因

问题不在你的主题、也不在那些程序，而在 **Ubuntu 自带的托盘桥扩展 `ubuntu-appindicators@ubuntu.com`**。

**证据一**：上游代码里自己留着 FIXME（`statusNotifierWatcher.js`）：

```js
_itemVanished(id) {
    // FIXME: this is useless if the path name disappears while the bus stays alive (not unheard of)
    if (this._items.has(id))
        this._remove(id);
}
```

**证据二**：上游确实写了一个清理函数（`util.js`），但它**一刀切**——把面板上**所有**托盘图标统统销毁，指望它们随后重新注册：

```js
function tryCleanupOldIndicators() {
    const indicators = Object.values(Main.panel.statusArea).filter(i => i instanceof indicatorType);
    ...
    new Set(indicators).forEach(i => i.destroy());
}
```

**证据三**：因为一刀切太粗暴，它**只能在扩展启动时调用一次**（`extension.js`）：

```js
function enable() {
    isEnabled = true;
    Util.tryCleanupOldIndicators();   // ← 只在启用时跑一次
    ...
}
```

**三条合起来就是完整解释**：运行期间泄漏的图标没人清理 → 只能靠手动重载扩展或重启 Shell → 于是「修好了，过一阵又出现」。

## 原理

本扩展把「一刀切」改成「精准清剿」，于是**可以安全地定期运行**：

```
每 8 秒：
  ① 取托盘注册表（org.kde.StatusNotifierWatcher → RegisteredStatusNotifierItems）
  ② 遍历面板上的托盘图标（Main.panel.statusArea 里键名以 appindicator- 开头的项）
  ③ 对每个图标判活：
       · 老式 XEmbed 图标（legacy:<窗口类>:<pid>） → 看 /proc/<pid> 还在不在
       · SNI 图标 → 先看它在不在注册表里
                    再看它的图标对象是否还真的存在（异步读一次 Id 属性）
  ④ 连续 2 次（约 16 秒）都判定为僵尸，才销毁它
```

正常图标**永远不动**；僵尸图标最多十几秒内被清掉。三类僵尸都能识别：

| 僵尸类型 | 判据 |
|---|---|
| 注册表里已经没有了 | 图标还在面板上，但注册表查无此项 |
| 注册表里还在、对象已经没了 | 程序撤掉/换掉了对象路径，但连接还活着（上游 FIXME 的场景） |
| 老式 XEmbed 图标、进程已死 | `legacy:` id 里的 pid 在 `/proc` 里不存在 |

## 美化桌面兼容模式：处理 SNI + XEmbed 双入口

Dash to Panel、主题和面板布局扩展会重新挂载 `statusArea`，因此更容易把一个程序
同时提供的两种托盘入口都显示出来：现代 StatusNotifierItem（SNI）和旧式 XEmbed。
这时两个图标都可能属于同一个仍在运行的进程，不能按“图标一样”、PID 或数量直接
删除，否则会误伤有意提供多个托盘入口的程序。

当前版本增加了一个独立的、可逆的去重阶段：

1. 用 D-Bus `GetConnectionUnixProcessID` 把 SNI 总线连接映射到进程 PID；
2. 异步读取 SNI 的 `Id`、`Title`、`IconName`；
3. 将它与 XEmbed 的 `legacy:<wm_class>:<pid>` 比较；
4. 只有 **同一 PID + 文本身份有重叠 + 连续两轮确认** 时，才暂时隐藏旧式图标；
5. 证据消失或扩展停用时恢复原来的可见状态。

去重只隐藏面板控件，不注销应用的 D-Bus 注册，也不杀进程。网络、权限、D-Bus
超时等不确定情况都会保持原状。要关闭这项行为，把 `extension.js` 中的
`DEDUPE_ENABLED` 改为 `false`，然后按“更新”章节重启 GNOME Shell。

这项兼容模式只能减少“同一程序双协议同时显示”的暴露，不能修复应用重复注册对象
路径，也不能替代 `ubuntu-appindicators` 的上游生命周期补丁。遇到两个图标时，先看
日志确认它们分别是 SNI 还是 XEmbed，再决定是否把问题修到应用端。

## 两个把作者坑了很久的细节

写这个扩展时踩到的坑，值得单独记下来：

1. **托盘注册表服务运行在 `gnome-shell` 自己进程里**（由 `ubuntu-appindicators` 提供）。
   因此**绝不能用同步的 `call_sync` 去查它**——同步调用会把主循环堵住，回复永远发不出来，
   每次都是超时；外部脚本里测试却是好的（不同进程），极具迷惑性。本扩展全程使用
   异步调用 + `Gio.DBusProxy` 的属性缓存（随 `PropertiesChanged` 自动更新）。
2. **本扩展的 `enable()` 跑得比注册表服务更早**（另一个扩展稍后才抢占 D-Bus 名字）。
   如果这时建立代理，它的属性缓存永远是空的 —— 老版本因此每一轮都在
   `if (!registry) return;` 静默跳过，看起来"启用成功"，实际从不清理。现在缓存为空会重建代理并重试。

## 安全设计（三道保险丝）

这个扩展动的是「别的扩展管理的控件」，所以规则一旦失效就必须**宁可不动手**：

| 保险丝 | 触发条件 | 行为 |
|---|---|---|
| 1 | 注册表为空、但面板上还有 SNI 图标 | 一律不动手（判定注册表不可信） |
| 2 | SNI 图标数 − 注册表项数 **> 2** | 停手 + 报错（判定匹配规则失效） |
| 3 | 一轮发现 **> 3 个**疑似僵尸 | 只报告、不动手（真僵尸通常只有一两个） |

另外：只读（D-Bus 只读 + 只查 `/proc`）、任何不确定的探测结果一律当"活着"、
异常全部吞掉、状态没变化时不重复打日志、心跳日志只在状态变化或每 10 分钟打一行。

**最坏情况**：某个程序的托盘图标被误清 → 重启该程序即可恢复。**不会崩溃、不影响系统稳定性。**

## 安装

```bash
git clone git@github.com:wenziji-hub/gnome-tray-zombie-cleaner.git
cd gnome-tray-zombie-cleaner
./install.sh
```

`install.sh` 会做三件事：复制到 `~/.local/share/gnome-shell/extensions/`、加入启用列表、提示你重启 Shell
（X11 下可以单独重启、不丢窗口）：

```bash
kill -TERM $(systemctl --user show org.gnome.Shell@x11.service -p MainPID --value)
```

## 更新

```bash
git pull
./install.sh           # 覆盖安装
./install.sh --check   # 只判断：正在跑的到底是不是磁盘上这一版
```

⚠️ **更新代码后必须重启 Shell**：GJS 会缓存扩展的 JS，`gnome-extensions disable/enable`
**不会**重新加载新的 `.js`，只复制文件同样不生效。

这个坑本项目作者亲自踩过：改完代码、disable/enable 之后，加的探针一行日志都没打出来 ——
因为跑的始终是旧代码。后来才确认必须重启 Shell。

```bash
# X11：单独重启 Shell，不丢窗口
kill -TERM $(systemctl --user show org.gnome.Shell@x11.service -p MainPID --value)

# 或者一步到位：装 + 重启 + 复查
./install.sh --restart
```

`./install.sh --check` 的原理很简单：比较 `extension.js` 的修改时间与 Shell 的启动时间 ——
文件比 Shell 新，就说明正在跑的是旧版本。

## 验证它在工作

```bash
journalctl --user -f | grep tray-cleaner
```

看到 `清理僵尸托盘图标: <id>` 就是抓到并清掉了一个。刚启用时会打印一行 `已启用：每 8 秒检查一次…`，
随后一行 `首轮盘点` 列出面板上所有托盘图标的 id 与注册表项数——排查时非常有用：

```
[tray-cleaner] 首轮盘点：statusArea 里托盘键 4 个
[tray-cleaner]   · legacy:Qq:9668
[tray-cleaner]   · :1.127/org/ayatana/NotificationItem/livepatch
[tray-cleaner]   注册表 3 项(缓存)
[tray-cleaner] 心跳：注册表 3 项(缓存)，SNI 图标 3 个，老式图标 1 个，僵尸候选 0 个
[tray-cleaner] 疑似僵尸（第 1 次确认：注册表里还在，但图标对象已不存在（上游 FIXME 的漏洞））: :1.10/…
[tray-cleaner] 清理僵尸托盘图标: :1.10/…（注册表里还在，但图标对象已不存在（上游 FIXME 的漏洞））
```

心跳只在**状态变化**或每 10 分钟打一行，所以日志不会刷屏。

## 卸载

```bash
gnome-extensions disable tray-zombie-cleaner@local
rm -rf ~/.local/share/gnome-shell/extensions/tray-zombie-cleaner@local
```

删掉后功能不会缺失——手动兜底方案依然有效：

```bash
# 重载托盘扩展（10 秒，图标会闪一下）
gnome-extensions disable ubuntu-appindicators@ubuntu.com && sleep 1 && gnome-extensions enable ubuntu-appindicators@ubuntu.com
```

## 兼容性

| 环境 | 状态 |
|---|---|
| Ubuntu 22.04 LTS / GNOME Shell 42 | ✅ 已验证 |
| GNOME 43 – 44 | ❓ 未测试（API 基本一致，可自行试用） |
| GNOME 45+ | ❌ 不适用（需要改写为 ESM 模块语法，欢迎 PR） |

## 已知限制

- 依赖两个**非公开内部约定**：面板键名格式 `appindicator-<id>`、以及注册表 id 的拼法
  （`<总线名><对象路径>`）；老式图标的 `legacy:<窗口类>:<pid>` 格式同样来自上游源码。
  上游若改动，本扩展可能失效（保险丝会兜住，不会乱杀）。
- 对"程序还活着、但自己不想显示图标了"这种情况无能为力——那需要上游按规范注销条目。
- 改本扩展的代码后必须**重启 Shell** 才会生效：`gnome-extensions disable/enable` 不会重新加载
  JS（GJS 的模块缓存），这一点同样坑过作者。
- 它清理的是「图标控件」，不修复上游的注册表缺陷——**上游 bug 仍在**，本扩展只是把清理自动化了。
- 这也是「绕过上游问题」的方案，不是官方修复；如果你不接受这类扩展，用手动重载即可。

## 许可

[MIT](LICENSE)

## 致谢

- 问题定位参考了 `ubuntu-appindicators`（GNOME AppIndicator/KStatusNotifierItem 扩展）的源码与其自带的 `tryCleanupOldIndicators()`
- 上游项目：<https://gitlab.com/ubuntu/gnome-shell-extension-appindicator>
