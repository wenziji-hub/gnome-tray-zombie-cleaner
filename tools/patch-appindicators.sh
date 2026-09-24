#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="/usr/share/gnome-shell/extensions/ubuntu-appindicators@ubuntu.com/statusNotifierWatcher.js"
PATCH_FILE="${ROOT_DIR}/patches/ubuntu-appindicators-statusNotifierWatcher.patch"
BACKUP="${TARGET}.tray-zombie-cleaner.orig"

usage() {
    printf '用法: %s [apply|restore|status]\n' "$0"
}

status() {
    if sudo test -f "${TARGET}" && sudo grep -q 'this\._isDestroyed = false' "${TARGET}"; then
        echo "AppIndicators 生命周期补丁：已应用"
    else
        echo "AppIndicators 生命周期补丁：未应用"
    fi
}

apply_patch_file() {
    if sudo grep -q 'this\._isDestroyed = false' "${TARGET}"; then
        echo "补丁已经应用，无需重复操作。"
        return
    fi

    if ! sudo test -f "${BACKUP}"; then
        sudo cp -a "${TARGET}" "${BACKUP}"
        echo "已保存原文件：${BACKUP}"
    fi

    sudo patch --batch --forward -d / -p0 < "${PATCH_FILE}"
    echo "已应用 AppIndicators 锁屏生命周期补丁。"
    echo "需要重启 GNOME Shell 或注销登录后才会加载。"
}

restore() {
    if ! sudo test -f "${BACKUP}"; then
        echo "找不到备份：${BACKUP}" >&2
        exit 1
    fi
    sudo cp -a "${BACKUP}" "${TARGET}"
    echo "已恢复原始 AppIndicators 文件。"
    echo "需要重启 GNOME Shell 或注销登录后才会生效。"
}

case "${1:-status}" in
    apply) apply_patch_file ;;
    restore) restore ;;
    status) status ;;
    *) usage; exit 2 ;;
esac
