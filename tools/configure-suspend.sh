#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DROPIN="/etc/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf"
SOURCE="${ROOT_DIR}/config/unattended-upgrades-logind-maxdelay.conf"

usage() {
    printf '用法: %s [apply|restore|status]\n' "$0"
}

status() {
    printf '指纹认证: '
    gsettings get org.gnome.login-screen enable-fingerprint-authentication 2>/dev/null || echo unknown
    printf '锁屏延迟覆盖: '
    if sudo test -f "${DROPIN}"; then
        echo "${DROPIN}"
        sudo sed -n '1,20p' "${DROPIN}"
    else
        echo 未安装
    fi
    printf '当前睡眠模式: '
    cat /sys/power/mem_sleep
}

apply_config() {
    gsettings set org.gnome.login-screen enable-fingerprint-authentication false
    sudo rm -f /etc/systemd/logind.conf.d/00-gnome-short-lock-delay.conf
    sudo rm -f /etc/systemd/logind.conf.d/99-gnome-short-lock-delay.conf
    sudo install -D -m 0644 "${SOURCE}" "${DROPIN}"
    sudo systemctl restart systemd-logind
    echo "已关闭无指纹设备上的指纹探测。"
    echo "已将 logind 锁屏延迟上限设为 5 秒并重新加载。"
    echo "此脚本没有修改 s2idle/deep；请单独验证 i915 恢复问题。"
}

restore() {
    sudo rm -f "${DROPIN}"
    sudo rm -f /etc/systemd/logind.conf.d/00-gnome-short-lock-delay.conf
    sudo rm -f /etc/systemd/logind.conf.d/99-gnome-short-lock-delay.conf
    sudo systemctl restart systemd-logind
    echo "已移除本项目的 logind 覆盖；指纹设置保持当前值不变。"
}

case "${1:-status}" in
    apply) apply_config ;;
    restore) restore ;;
    status) status ;;
    *) usage; exit 2 ;;
esac
