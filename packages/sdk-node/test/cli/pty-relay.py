#!/usr/bin/env python3
"""Runs a command on a real pseudo-terminal and relays it over JSON lines, so a Node test can put
@xterm/headless on the other end (there is no pty module in Node).

  stdin  (one JSON object per line)   {"w": base64}        bytes the terminal sends to the program
                                      {"r": [cols, rows]}  resize the window (the program gets SIGWINCH)
                                      {"k": 15}            send a signal to the program
  stdout (one JSON object per line)   {"o": base64}        bytes the program wrote
                                      {"x": status}        the program ended (exit status, or -signal)

usage: pty-relay.py COLS ROWS -- COMMAND [ARG...]
"""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    cmd = sys.argv[sys.argv.index("--") + 1 :]
    pid, master = pty.fork()
    if pid == 0:
        winsize(0, cols, rows)
        os.execvp(cmd[0], cmd)
    out = sys.stdout
    inp = sys.stdin.fileno()
    buf = b""
    status = None
    while True:
        r, _, _ = select.select([master, inp], [], [], 0.05)
        if master in r:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if data:
                out.write(json.dumps({"o": base64.b64encode(data).decode()}) + "\n")
                out.flush()
            else:
                break
        if inp in r:
            chunk = os.read(inp, 65536)
            if not chunk:
                os.kill(pid, signal.SIGHUP)
                inp = -1
                continue
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                msg = json.loads(line)
                if "w" in msg:
                    os.write(master, base64.b64decode(msg["w"]))
                elif "r" in msg:
                    winsize(master, msg["r"][0], msg["r"][1])
                    os.kill(pid, signal.SIGWINCH)
                elif "k" in msg:
                    os.kill(pid, msg["k"])
    _, st = os.waitpid(pid, 0)
    status = os.waitstatus_to_exitcode(st)
    out.write(json.dumps({"x": status}) + "\n")
    out.flush()


main()
