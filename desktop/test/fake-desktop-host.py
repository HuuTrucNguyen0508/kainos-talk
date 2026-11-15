"""Stand-in desktop services for the smoke test, on its private D-Bus session.

- org.kde.StatusNotifierWatcher: Electron's tray registers over D-Bus as it would on a real
  desktop, instead of falling back to GTK (which crashes without a display). The test can
  call SetHostRegistered(false) to play a desktop with no tray host.
- org.freedesktop.Notifications: native notifications land here instead of on a real
  notification daemon, and the test reads them from stdout.

Prints one line per event: "registered <sender> <item>", "notify <json>", "close <id>",
and "ready" once it owns both names.

Reads commands on stdin, one per line, to play the server's side of a notification:
"closed <id> <reason>" sends NotificationClosed (1 = expired, 2 = dismissed, 3 = closed by
the app) and "action <id> <key>" sends ActionInvoked (a click is the "default" action).
"""
import json
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

XML = """
<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem"><arg name="service" type="s" direction="in"/></method>
    <method name="RegisterStatusNotifierHost"><arg name="service" type="s" direction="in"/></method>
    <method name="SetHostRegistered"><arg name="registered" type="b" direction="in"/></method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
  </interface>
  <interface name="org.freedesktop.Notifications">
    <method name="GetCapabilities"><arg type="as" direction="out"/></method>
    <method name="GetServerInformation">
      <arg type="s" direction="out"/><arg type="s" direction="out"/>
      <arg type="s" direction="out"/><arg type="s" direction="out"/>
    </method>
    <method name="Notify">
      <arg name="app_name" type="s" direction="in"/>
      <arg name="replaces_id" type="u" direction="in"/>
      <arg name="app_icon" type="s" direction="in"/>
      <arg name="summary" type="s" direction="in"/>
      <arg name="body" type="s" direction="in"/>
      <arg name="actions" type="as" direction="in"/>
      <arg name="hints" type="a{sv}" direction="in"/>
      <arg name="expire_timeout" type="i" direction="in"/>
      <arg name="id" type="u" direction="out"/>
    </method>
    <method name="CloseNotification"><arg name="id" type="u" direction="in"/></method>
    <signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
    <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
  </interface>
</node>
"""
NAMES = ("org.kde.StatusNotifierWatcher", "org.freedesktop.Notifications")
state = {"items": [], "host": True, "next_id": 0, "owned": set()}


def say(line):
    print(line, flush=True)


def on_watcher_call(_conn, sender, _path, _iface, method, params, invocation):
    if method == "RegisterStatusNotifierItem":
        state["items"].append(params.unpack()[0])
        say(f"registered {sender} {params.unpack()[0]}")
    elif method == "SetHostRegistered":
        state["host"] = params.unpack()[0]
        say(f"host {state['host']}")
    invocation.return_value(None)


def on_watcher_get(_conn, _sender, _path, _iface, prop):
    return {
        "RegisteredStatusNotifierItems": GLib.Variant("as", state["items"]),
        "IsStatusNotifierHostRegistered": GLib.Variant("b", state["host"]),
        "ProtocolVersion": GLib.Variant("i", 0),
    }[prop]


def on_notifications_call(conn, _sender, path, iface, method, params, invocation):
    if method == "GetCapabilities":
        invocation.return_value(GLib.Variant("(as)", (["body", "actions"],)))
    elif method == "GetServerInformation":
        invocation.return_value(GLib.Variant("(ssss)", ("kainos-fake", "kainos", "1", "1.2")))
    elif method == "Notify":
        app_name, replaces_id, _icon, summary, body, actions, _hints, _timeout = params.unpack()
        state["next_id"] += 1
        record = {"id": state["next_id"], "app": app_name, "replaces": replaces_id, "summary": summary, "body": body, "actions": actions}
        say("notify " + json.dumps(record))
        invocation.return_value(GLib.Variant("(u)", (state["next_id"],)))
    elif method == "CloseNotification":
        (nid,) = params.unpack()
        say(f"close {nid}")
        conn.emit_signal(None, path, iface, "NotificationClosed", GLib.Variant("(uu)", (nid, 3)))
        invocation.return_value(None)


def acquired(_conn, name):
    state["owned"].add(name)
    if len(state["owned"]) == len(NAMES):
        say("ready")


conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def on_command(_source, _condition):
    line = sys.stdin.readline()
    if not line:
        return False
    parts = line.split()
    if len(parts) == 3 and parts[0] == "closed":
        conn.emit_signal(None, "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "NotificationClosed", GLib.Variant("(uu)", (int(parts[1]), int(parts[2]))))
    elif len(parts) == 3 and parts[0] == "action":
        conn.emit_signal(None, "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "ActionInvoked", GLib.Variant("(us)", (int(parts[1]), parts[2])))
    return True


GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN, on_command)
node = Gio.DBusNodeInfo.new_for_xml(XML)
conn.register_object("/StatusNotifierWatcher", node.interfaces[0], on_watcher_call, on_watcher_get, None)
conn.register_object("/org/freedesktop/Notifications", node.interfaces[1], on_notifications_call, None, None)
for bus_name in NAMES:
    Gio.bus_own_name_on_connection(
        conn,
        bus_name,
        Gio.BusNameOwnerFlags.NONE,
        acquired,
        lambda _c, name: sys.exit(f"could not own {name}"),
    )
GLib.MainLoop().run()
