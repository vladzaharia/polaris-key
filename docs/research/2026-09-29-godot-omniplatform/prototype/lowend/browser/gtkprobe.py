#!/usr/bin/env python3
# Loads a URL in the distro's WebKitGTK (WebKit 6.0 GIR, the engine Tauri uses on Linux) under Xvfb and
# prints document.title whenever it changes; the probe page reports through the title.
# usage: xvfb-run python3 gtkprobe.py <url> <timeout_s>
import sys, gi
gi.require_version("Gtk", "4.0")
gi.require_version("WebKit", "6.0")
from gi.repository import Gtk, WebKit, GLib
url, timeout = sys.argv[1], int(sys.argv[2])
print("webkitgtk", WebKit.get_major_version(), WebKit.get_minor_version(), WebKit.get_micro_version(), flush=True)
app = Gtk.Application(application_id="org.polariskey.s04probe")
def on_activate(a):
    win = Gtk.ApplicationWindow(application=a)
    wv = WebKit.WebView()
    win.set_child(wv)
    def title(w, _):
        t = w.get_title() or ""
        print("TITLE", t, flush=True)
        if t.startswith("DONE"):
            a.quit()
    wv.connect("notify::title", title)
    wv.connect("web-process-terminated", lambda w, r: (print("WEB PROCESS TERMINATED", r, flush=True), a.quit()))
    wv.load_uri(url)
    win.present()
    GLib.timeout_add_seconds(timeout, lambda: (print("TIMEOUT", flush=True), a.quit()))
app.connect("activate", on_activate)
app.run([])
