#!/usr/bin/env bash
# Tray Zombie Cleaner —— 安装 / 更新脚本
#
#   ./install.sh              安装并启用（不重启 Shell）
#   ./install.sh --restart    安装后顺便重启 GNOME Shell（X11 专用，不丢窗口）
#   ./install.sh --check      只检查：磁盘上的代码是不是比正在运行的 Shell 更新
#
set -euo pipefail

UUID="tray-zombie-cleaner@local"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
SHELL_UNIT="org.gnome.Shell@x11.service"

shell_start_epoch() {
    # ExecMainStartTimestamp 在这个模板服务上可能保留旧值（Shell 自动重启后
    # 尤其明显）。以当前 MainPID 对应的进程启动时间为准，避免误报“仍在运行旧代码”。
    local pid started
    pid="$(systemctl --user show "${SHELL_UNIT}" -p MainPID --value 2>/dev/null || true)"
    [[ "${pid}" =~ ^[0-9]+$ && "${pid}" != "0" ]] || return 1
    started="$(ps -p "${pid}" -o lstart= 2>/dev/null || true)"
    [ -n "${started}" ] || return 1
    date -d "${started}" +%s 2>/dev/null
}

# 磁盘上的 extension.js 比 Shell 启动还新 → 说明正在运行的还是旧代码
check() {
    if [ ! -f "${DEST_DIR}/extension.js" ]; then
        echo "未安装到 ${DEST_DIR}"
        return 0
    fi

    local mtime start
    mtime="$(stat -c %Y "${DEST_DIR}/extension.js")"
    if ! start="$(shell_start_epoch)"; then
        echo "不是 X11 会话（找不到 ${SHELL_UNIT}）→ 请注销重新登录来加载代码。"
        return 0
    fi

    echo "磁盘上的 extension.js 修改于: $(date -d "@${mtime}" '+%F %T')"
    echo "当前 Shell 启动于:            $(date -d "@${start}" '+%F %T')"
    if [ "${mtime}" -gt "${start}" ]; then
        echo
        echo "⚠️  代码比 Shell 新 —— 正在跑的仍是旧版本。"
        echo "    注意：gnome-extensions disable/enable 不会重载 .js（GJS 有模块缓存），"
        echo "    必须重启 Shell 才会生效："
        echo "      kill -TERM \$(systemctl --user show ${SHELL_UNIT} -p MainPID --value)"
    else
        echo
        echo "✅ 正在运行的已是磁盘上的版本，无需重启。"
    fi
}

if [[ "${1:-}" == "--check" ]]; then
    check
    exit 0
fi

UPDATING=0
[ -f "${DEST_DIR}/extension.js" ] && UPDATING=1

echo "==> 安装到 ${DEST_DIR}"
mkdir -p "${DEST_DIR}"
install -m 0644 "${SRC_DIR}/extension.js" "${DEST_DIR}/extension.js"
install -m 0644 "${SRC_DIR}/metadata.json" "${DEST_DIR}/metadata.json"
install -m 0644 "${SRC_DIR}/LICENSE" "${DEST_DIR}/LICENSE" 2>/dev/null || true

echo "==> 加入启用列表"
CURRENT="$(gsettings get org.gnome.shell enabled-extensions)"
if [[ "${CURRENT}" == *"${UUID}"* ]]; then
    echo "    已经在启用列表里了"
else
    # 在末尾追加（保留原有列表）
    NEW="$(python3 - "$CURRENT" "$UUID" <<'PY'
import sys, ast
cur, uuid = sys.argv[1], sys.argv[2]
try:
    items = ast.literal_eval(cur)
except Exception:
    items = []
if uuid not in items:
    items.append(uuid)
print("[" + ", ".join("'%s'" % i for i in items) + "]")
PY
)"
    gsettings set org.gnome.shell enabled-extensions "${NEW}"
    echo "    已追加: ${UUID}"
fi

echo
if [[ "${UPDATING}" == "1" ]]; then
    echo "==> 这是覆盖更新 —— 请注意："
    echo "    GJS 会缓存扩展代码，'gnome-extensions disable/enable' **不会**重新加载新的 .js，"
    echo "    只复制文件也不会生效。必须重启 Shell（或注销重登）才会跑上新代码。"
    echo "    判断当前是否需要重启：  ./install.sh --check"
    echo
fi
echo "==> 接下来："
echo "    X11 会话下可以单独重启 Shell（不丢窗口）："
echo "      kill -TERM \$(systemctl --user show ${SHELL_UNIT} -p MainPID --value)"
echo "    Wayland 会话下需要注销重新登录。"
echo
echo "    验证是否在工作："
echo "      journalctl --user -f | grep tray-cleaner"

if [[ "${1:-}" == "--restart" ]]; then
    echo
    echo "==> 重启 GNOME Shell …"
    PID="$(systemctl --user show "${SHELL_UNIT}" -p MainPID --value 2>/dev/null || true)"
    if [[ -z "${PID}" ]]; then
        echo "    找不到 ${SHELL_UNIT} —— 你可能是 Wayland 会话，请注销重登。"
    else
        # systemd 的 stop/restart 会等待 Shell 的 D-Bus 清理钩子，某些扩展卡住时
        # 会让安装终端一直没有返回。发送 TERM 后只轮询 PID，超过上限就退出并给出
        # 可执行的后续命令；安装本身已经完成，不把终端锁死。
        kill -TERM "${PID}" 2>/dev/null || true
        new_pid=""
        for _ in {1..24}; do
            sleep 0.5
            candidate="$(systemctl --user show "${SHELL_UNIT}" -p MainPID --value 2>/dev/null || true)"
            comm="$(ps -p "${candidate}" -o comm= 2>/dev/null | tr -d '[:space:]' || true)"
            if [[ -n "${candidate}" && "${candidate}" != "${PID}" && "${candidate}" != "0" && "${comm}" == "gnome-shell" ]]; then
                new_pid="${candidate}"
                break
            fi
        done
        if [[ -n "${new_pid}" ]]; then
            echo "    新 Shell PID: ${new_pid}"
        else
            echo "    Shell 未在 12 秒内报告新 PID；当前代码已安装。"
            echo "    若仍未加载，请注销并重新登录，或稍后手动执行："
            echo "      kill -TERM \$(systemctl --user show ${SHELL_UNIT} -p MainPID --value)"
            exit 0
        fi
        echo
        check
    fi
fi
