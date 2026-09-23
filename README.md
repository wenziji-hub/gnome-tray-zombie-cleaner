# Tray Zombie Cleaner

> 自动清理 GNOME 托盘里的「僵尸图标」——**程序已经退出了，图标还挂在面板上**，于是同一个图标重复出现两次。
>
> Automatically removes *zombie* tray icons that Ubuntu's AppIndicator bridge leaves behind when an app exits without unregistering its icon.

![before / after](docs/before-after.png)

*上：修复前，托盘里同一个图标出现两次（两个橙猫）。下：清理后只剩一个。*

适用于 **Ubuntu 22.04 LTS / GNOME Shell 42**。

---

## 问题现象

- 托盘中**同一个程序的图标出现两次**（截图里的两只猫 = Clash Verge 的托盘图标）
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
  ① 读取托盘注册表（org.kde.StatusNotifierWatcher → RegisteredStatusNotifierItems）
  ② 遍历面板上的托盘图标（Main.panel.statusArea 里键名以 appindicator- 开头的项）
  ③ 找出「注册表里已经没有」的图标
  ④ 连续 2 次（约 16 秒）都判定为孤儿，才销毁它
```

正常图标（在注册表里的）**永远不动**；僵尸图标最多十几秒内被清掉。老式 XEmbed 图标（`legacy:` 前缀）不登记在 SNI 注册表里，已显式排除。

## 安全设计（三道保险丝）

这个扩展动的是「别的扩展管理的控件」，所以规则一旦失效就必须**宁可不动手**：

| 保险丝 | 触发条件 | 行为 |
|---|---|---|
| 1 | 注册表为空、但面板上还有图标 | 一律不动手（判定注册表不可信） |
| 2 | 面板图标数 − 注册表项数 **> 2** | 停手 + 报错（判定匹配规则失效） |
| 3 | 一轮发现 **≥ 2 个**疑似僵尸 | 只报告、不动手（真僵尸通常只有一个） |

另外：只读注册表（不写任何东西）、异常全部吞掉、30 秒内不会重复报同样的日志。

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

## 验证它在工作

```bash
journalctl --user -f | grep tray-cleaner
```

看到 `清理僵尸托盘图标: <id>` 就是抓到并清掉了一个。刚启用时会打印一行 `已启用：每 8 秒检查一次…`。

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

- 依赖两个**非公开内部约定**：面板键名格式 `appindicator-<id>`、以及注册表 id 的拼法。
  上游若改动，本扩展可能失效（保险丝会兜住，不会乱杀）。
- 它清理的是「图标控件」，不修复上游的注册表缺陷——**上游 bug 仍在**，本扩展只是把清理自动化了。
- 这也是「绕过上游问题」的方案，不是官方修复；如果你不接受这类扩展，用手动重载即可。

## 许可

[MIT](LICENSE)

## 致谢

- 问题定位参考了 `ubuntu-appindicators`（GNOME AppIndicator/KStatusNotifierItem 扩展）的源码与其自带的 `tryCleanupOldIndicators()`
- 上游项目：<https://gitlab.com/ubuntu/gnome-shell-extension-appindicator>
