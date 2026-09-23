# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-09-23

首个版本。

### 新增
- 每 8 秒对照托盘注册表（`org.kde.StatusNotifierWatcher.RegisteredStatusNotifierItems`），
  自动清理「注册表里已不存在」的托盘图标（僵尸图标）
- 连续 2 次确认（约 16 秒）才动手，避免误判注册过程中的瞬时状态
- 三道安全保险丝：
  1. 注册表为空但面板仍有图标 → 不动手
  2. 面板图标数比注册表项数多出 2 个以上 → 停手 + 报错
  3. 一轮发现 2 个以上疑似僵尸 → 只报告、不动手
- 显式排除老式 XEmbed 托盘图标（`legacy:` 前缀），它们不登记在 SNI 注册表里

### 已知问题
- 依赖 `appindicator-<id>` 面板键名与注册表 id 拼法这两个非公开约定，上游改动后可能失效
- GNOME 45+ 需要改写为 ESM 语法，暂不支持
