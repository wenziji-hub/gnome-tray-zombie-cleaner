// 假 StatusNotifierItem：用来复现"程序没了但托盘图标残留"的僵尸现象
//   用法:
//     gjs fake-sni.js            注册 1 个图标后常驻
//     gjs fake-sni.js --double   同一连接注册 2 个图标（模拟程序重新注册托盘）
//   测试: 启动后杀进程(kill -9) → 托盘上的图标会残留成僵尸
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

// 必须持有导出对象的引用，否则会被 GC 回收、对象从总线上消失
const KEEP_ALIVE = [];

const IFACE_XML = `
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <method name="Activate">
      <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    </method>
    <method name="SecondaryActivate">
      <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    </method>
    <method name="ContextMenu">
      <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    </method>
    <method name="Scroll">
      <arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/>
    </method>
    <signal name="NewIcon"/>
    <signal name="NewStatus"><arg name="status" type="s"/></signal>
    <signal name="NewTitle"/>
  </interface>
</node>`;

// 16x16 纯色 ARGB 像素图（预乘 alpha）
function pixmap(r, g, b) {
    const size = 16;
    const bytes = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        bytes[i * 4 + 0] = b;
        bytes[i * 4 + 1] = g;
        bytes[i * 4 + 2] = r;
        bytes[i * 4 + 3] = 255;
    }
    return [[size, size, bytes]];
}

function makeItem(id) {
    return {
        IconPixmap: pixmap(230, 60, 60),
        AttentionIconName: '',
        AttentionIconPixmap: [],
        ToolTip: ['', [], 'Fake Test ' + id, ''],
        Category: 'ApplicationStatus',
        Id: id,
        Title: 'Fake Test ' + id,
        Status: 'Active',
        IconName: 'face-smile',
        IconThemePath: '',
        Menu: '/MenuBar',
        ItemIsMenu: false,
        Activate() {},
        SecondaryActivate() {},
        ContextMenu() {},
        Scroll() {},
    };
}

function main() {
    const double = ARGV.indexOf('--double') >= 0;
    const unexport = ARGV.indexOf('--unexport') >= 0;
    const conn = Gio.bus_get_sync(Gio.BusType.SESSION, null);

    // 占一个 well-known 名字（杀掉进程后这个名字会消失）
    const name = 'org.kde.StatusNotifierItem.faketest' + (double ? '2' : '1');
    conn.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
        'RequestName', new GLib.Variant('(su)', [name, 0]),
        null, Gio.DBusCallFlags.NONE, -1, null);

    const paths = ['/org/ayatana/NotificationItem/fake_test_1'];
    if (double)
        paths.push('/org/ayatana/NotificationItem/fake_test_2');

    paths.forEach((p, i) => {
        const exported = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, makeItem('fake' + (i + 1)));
        exported.export(conn, p);
        KEEP_ALIVE.push(exported);
        conn.call_sync('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher',
            'org.kde.StatusNotifierWatcher', 'RegisterStatusNotifierItem',
            new GLib.Variant('(s)', [p]), null, Gio.DBusCallFlags.NONE, -1, null);
        log('fake-sni: 已注册 ' + p);
    });

    print('fake-sni ready: ' + paths.join(', '));

    if (unexport) {
        // 复现上游 FIXME：把对象撤掉，但连接继续活着 → 注册表条目还在，图标却成了僵尸
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 6000, () => {
            KEEP_ALIVE.forEach(o => { try { o.unexport(); } catch (e) {} });
            print('fake-sni: 已撤掉对象（连接保持存活）→ 僵尸制造完成');
            return GLib.SOURCE_REMOVE;
        });
    }

    GLib.MainLoop.new(null, false).run();
}

main();
