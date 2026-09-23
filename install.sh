#!/usr/bin/env bash
# Tray Zombie Cleaner —— 安装 / 更新脚本
#
#   ./install.sh              安装并启用（不重启 Shell）
#   ./install.sh --restart    安装后顺便重启 GNOME Shell（X11 专用，不丢窗口）
#
set -euo pipefail

UUID="tray-zombie-cleaner@local"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

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
echo "==> 完成。接下来："
echo "    X11 会话下可以单独重启 Shell（不丢窗口）："
echo "      kill -TERM \$(systemctl --user show org.gnome.Shell@x11.service -p MainPID --value)"
echo "    Wayland 会话下需要注销重新登录。"
echo
echo "    验证是否在工作："
echo "      journalctl --user -f | grep tray-cleaner"

if [[ "${1:-}" == "--restart" ]]; then
    echo
    echo "==> 重启 GNOME Shell …"
    PID="$(systemctl --user show org.gnome.Shell@x11.service -p MainPID --value 2>/dev/null || true)"
    if [[ -z "${PID}" ]]; then
        echo "    找不到 org.gnome.Shell@x11.service —— 你可能是 Wayland 会话，请注销重登。"
    else
        kill -TERM "${PID}"
        sleep 12
        echo "    新 Shell PID: $(systemctl --user show org.gnome.Shell@x11.service -p MainPID --value)"
    fi
fi
