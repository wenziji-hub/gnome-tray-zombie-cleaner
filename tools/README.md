# 验证工具

清理僵尸图标这件事很难"随手试一试"——得先真的出现一个僵尸。这两个脚本让你随时造一个。

## fake-sni.js —— 假托盘程序

用 `gjs` 起一个最小可用的 StatusNotifierItem，向注册表注册后常驻：

```bash
gjs tools/fake-sni.js              # 注册 1 个图标后常驻
gjs tools/fake-sni.js --double     # 同一连接注册 2 个图标
gjs tools/fake-sni.js --unexport   # 注册 6 秒后撤掉对象，但连接保持存活
```

三种玩法对应三类僵尸：

| 用法 | 结果 |
|---|---|
| `kill -9 <pid>` | 进程消失 → 注册表条目被清掉，但面板图标可能残留（第一类僵尸） |
| `--unexport` | 注册表条目还在、连接还在，但图标对象已经没了（**上游 FIXME 的第二类僵尸**） |
| `--double` | 同一程序注册两个图标（模拟程序重新注册托盘） |

写完记得：`gjs` 里用 `Gio.DBusExportedObject.wrapJSObject()` 导出的对象**必须留一个 JS 引用**，
否则会被 GC 回收、对象从总线上悄悄消失（症状：注册成功但图标永远不出现）。

## zombie-focus-test.py —— 端到端验证

```bash
python3 tools/zombie-focus-test.py
```

它会：清掉旧进程 → 启动 `fake-sni.js --unexport` → 每 5 秒打印假进程/注册表/清理器日志 →
看到 `清理僵尸托盘图标` 即通过。预期 20 秒左右识别、25 秒左右销毁。

需要 `journalctl` 可读、`gdbus`、`xdotool`，以及扩展已安装启用。
