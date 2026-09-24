#!/usr/bin/env python3
"""聚焦测试：制造一个"注册表里还在、对象已消失、连接仍存活"的僵尸，等清理器销毁它"""
import glob
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FAKE_SNI = ROOT / 'tools' / 'fake-sni.js'

ENV = dict(os.environ)
ENV.update({'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/1000/bus',
            'XDG_RUNTIME_DIR': '/run/user/1000', 'DISPLAY': ':0'})


def procs(pat):
    out, me = [], os.getpid()
    for d in glob.glob('/proc/[0-9]*'):
        p = int(d.rsplit('/', 1)[-1])
        if p == me:
            continue
        try:
            c = open(d + '/cmdline', 'rb').read().replace(b'\0', b' ').decode(errors='replace')
        except Exception:
            continue
        if pat in c and 'python3' not in c:
            out.append(p)
    return out


def cleaner_since(tag):
    out = subprocess.run(['journalctl', '--since', tag, '--no-pager', '-o', 'cat'],
                         capture_output=True, text=True, env=ENV).stdout
    return [l.replace('[tray-cleaner] ', '  ') for l in out.splitlines() if 'tray-cleaner' in l]


def registry():
    out = subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.kde.StatusNotifierWatcher',
                          '--object-path', '/StatusNotifierWatcher', '--method',
                          'org.freedesktop.DBus.Properties.Get', 'org.kde.StatusNotifierWatcher',
                          'RegisteredStatusNotifierItems'],
                         capture_output=True, text=True, env=ENV).stdout
    return re.findall(r"'([^']*)'", out)


def main():
    for p in procs('fake-sni'):
        os.kill(p, 9)
    time.sleep(1)

    tag = time.strftime('%H:%M:%S')
    log = open('/tmp/f9.log', 'w')
    subprocess.Popen(['setsid', 'gjs', str(FAKE_SNI), '--unexport'],
                     env=ENV, stdout=log, stderr=log, start_new_session=True)
    print('启动假 SNI（t=0 注册，t=6s 撤掉对象）时间戳 %s' % tag)

    seen = 0
    for i in range(20):          # 最多 100 秒
        time.sleep(5)
        t = (i + 1) * 5
        alive = procs('fake-sni')
        reg = registry()
        fake = [r for r in reg if 'fake_test' in r]
        lines = cleaner_since(tag)
        new = lines[seen:]
        seen = len(lines)
        print('[%3ds] 假进程=%s 注册表=%d项 假条目=%s' %
              (t, '存活' if alive else '已退出', len(reg), '在' if fake else '已消失'))
        for l in new:
            print('        ' + l)
        if any('清理僵尸托盘图标' in l for l in lines):
            print('\n✅ 清理器已自动销毁僵尸图标')
            return 0
    print('\n❌ 未看到清理动作')
    return 1


if __name__ == '__main__':
    sys.exit(main())
