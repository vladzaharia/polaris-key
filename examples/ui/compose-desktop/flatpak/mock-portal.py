#!/usr/bin/env python3
"""UK-10.13: a mock xdg-desktop-portal for the Flatpak check. Owns org.freedesktop.portal.Desktop on the
session bus, answers Settings.ReadOne with a dark, orange, high-contrast desktop and OpenURI.OpenURI with a
request handle, and appends one line per call to the log file (argv[1]). It writes `ready` once it owns the name."""
import sys
import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

LOG = sys.argv[1]
XML = """<node>
  <interface name="org.freedesktop.portal.Settings">
    <method name="ReadOne"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
    <property name="version" type="u" access="read"/>
  </interface>
  <interface name="org.freedesktop.portal.OpenURI">
    <method name="OpenURI"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
    <property name="version" type="u" access="read"/>
  </interface>
</node>"""
ANSWERS = {
    "color-scheme": GLib.Variant("u", 1),
    "accent-color": GLib.Variant("(ddd)", (1.0, 0.42, 0.24)),
    "contrast": GLib.Variant("u", 1),
}


def log(line):
    with open(LOG, "a") as f:
        f.write(line + "\n")


def on_call(conn, sender, path, iface, method, params, invocation):
    if method == "ReadOne":
        ns, key = params.unpack()
        log(f"ReadOne {ns} {key}")
        answer = ANSWERS.get(key)
        if answer is None:
            invocation.return_dbus_error("org.freedesktop.portal.Error.NotFound", "no such setting")
        else:
            invocation.return_value(GLib.Variant("(v)", (GLib.Variant("v", answer),)))
    elif method == "OpenURI":
        _, uri, _ = params.unpack()
        log(f"OpenURI {uri}")
        invocation.return_value(GLib.Variant("(o)", ("/org/freedesktop/portal/desktop/request/mock/1",)))
    else:
        invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)


def on_prop(conn, sender, path, iface, name):
    return GLib.Variant("u", 1)


def on_bus(conn, name):
    for info in Gio.DBusNodeInfo.new_for_xml(XML).interfaces:
        conn.register_object("/org/freedesktop/portal/desktop", info, on_call, on_prop, None)


def on_name(conn, name):
    log("ready")


Gio.bus_own_name(Gio.BusType.SESSION, "org.freedesktop.portal.Desktop", Gio.BusNameOwnerFlags.NONE, on_bus, on_name, None)
GLib.MainLoop().run()
