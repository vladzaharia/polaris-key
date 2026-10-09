"""A real terminal for the responsive tests: pyte, behind the kit's stream, with the three things a
person's terminal does that pyte leaves out.

* **ONLCR.** A pty's line discipline turns ``\\n`` into ``\\r\\n`` on the way to the terminal.
* **Soft wraps.** A line wider than the terminal wraps onto the next row; that row is marked as a
  continuation (xterm's ``isWrapped``), so a test can say "no line was wider than the terminal".
* **Reflow.** Resizing re-wraps every line to the new width (xterm.js, iTerm2, Terminal.app, VTE
  and Windows Terminal all do), keeping the cursor on its character, and pushes what no longer fits
  into the scrollback. A live region that erases by the rows it drew before the reflow leaves a
  duplicated header or a stack of progress bars here, as it would for a person.

The Node kit's ``test/cli/xterm.ts`` puts @xterm/headless behind the same checks.
"""

from __future__ import annotations

from typing import Any, List, Optional, Tuple

import pyte
from pyte import modes as mo
from pyte.screens import StaticDefaultDict
from wcwidth import wcwidth


class _Screen(pyte.HistoryScreen):
    def __init__(self, columns: int, lines: int) -> None:
        super().__init__(columns, lines, history=5000, ratio=0.5)

    def draw(self, data: str) -> None:
        for ch in data:
            wraps = self.cursor.x >= self.columns and mo.DECAWM in self.mode and (wcwidth(ch) or 0) > 0
            super().draw(ch)
            if wraps:
                self.buffer[self.cursor.y].wrapped = True  # type: ignore[attr-defined]

    def erase_in_display(self, how: int = 0, *args: Any, **kwargs: Any) -> None:
        # Below the cursor (and the cursor's row when erased from its start) no longer continues.
        if how == 0:
            first = self.cursor.y if self.cursor.x == 0 else self.cursor.y + 1
        else:
            first = 0
        super().erase_in_display(how, *args, **kwargs)
        for y in range(first, self.lines):
            self.buffer[y].wrapped = False  # type: ignore[attr-defined]

    def erase_in_line(self, how: int = 0, private: bool = False) -> None:
        super().erase_in_line(how, private)
        if how == 2 or (how == 0 and self.cursor.x == 0):
            self.buffer[self.cursor.y].wrapped = False  # type: ignore[attr-defined]

    def _row(self, chars: List[Any], wrapped: bool) -> StaticDefaultDict:
        row = StaticDefaultDict(self.default_char)
        for x, ch in enumerate(chars):
            row[x] = ch
        row.wrapped = wrapped  # type: ignore[attr-defined]
        return row

    def reflow(self, columns: int, lines: int) -> None:
        """Resize the way a person's terminal does: re-wrap every line to ``columns``."""
        rows = list(self.history.top) + [self.buffer[y] for y in range(self.lines)]
        at = len(self.history.top) + self.cursor.y
        logical: List[Tuple[List[Any], Optional[int]]] = []
        for i, row in enumerate(rows):
            chars = [row[x] for x in range(self.columns)]
            if getattr(row, "wrapped", False) and logical:
                prev, cur = logical[-1]
                offset = len(prev)
                logical[-1] = (prev + chars, cur if i != at else offset + self.cursor.x)
            else:
                logical.append((chars, self.cursor.x if i == at else None))
        # Nothing below the cursor's line is kept (a live region's terminal is blank there).
        last = max(i for i, (_, cur) in enumerate(logical) if cur is not None)
        out: List[StaticDefaultDict] = []
        cursor = (0, 0)
        for chars, cur in logical[: last + 1]:
            while chars and chars[-1].data == " " and chars[-1] == self.default_char:
                chars = chars[:-1]
            n = max(1, -(-len(chars) // columns))
            if cur is not None:
                cy, cx = divmod(cur, columns)
                if cx == 0 and cur > 0 and cur >= len(chars):
                    cy, cx = cy - 1, columns  # the pending wrap at the end of a full row
                n = max(n, cy + 1)
                cursor = (len(out) + cy, cx)
            for k in range(n):
                out.append(self._row(chars[k * columns : (k + 1) * columns], k > 0))
        super().resize(lines, columns)
        self.history.top.clear()
        above = max(0, len(out) - lines)
        self.history.top.extend(out[:above])
        self.buffer.clear()
        for y, row in enumerate(out[above:]):
            self.buffer[y] = row
        self.cursor.y = cursor[0] - above
        self.cursor.x = cursor[1]


class Term:
    """The terminal as the kit's stdout sees it: ``write``, ``flush``, ``isatty``."""

    def __init__(self, columns: int, rows: int) -> None:
        self.screen = _Screen(columns, rows)
        self.stream = pyte.Stream(self.screen)
        self.raw = ""

    @property
    def columns(self) -> int:
        return self.screen.columns

    @property
    def rows(self) -> int:
        return self.screen.lines

    def size(self) -> Tuple[int, int]:
        return self.columns, self.rows

    def write(self, data: str) -> int:
        self.raw += data
        self.stream.feed(data.replace("\n", "\r\n"))
        return len(data)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return True

    def resize(self, columns: int, rows: int) -> None:
        self.screen.reflow(columns, rows)

    def _text(self, row: Any) -> str:
        return "".join(row[x].data for x in range(self.screen.columns)).rstrip()

    def all(self) -> List[Tuple[str, bool]]:
        """Every row, scrollback first: its text and whether the terminal wrapped it there."""
        rows = list(self.screen.history.top) + [self.screen.buffer[y] for y in range(self.screen.lines)]
        out = [(self._text(r), bool(getattr(r, "wrapped", False))) for r in rows]
        while out and out[-1][0] == "":
            out.pop()
        return out

    def viewport(self) -> List[str]:
        return [self._text(self.screen.buffer[y]) for y in range(self.screen.lines)]
