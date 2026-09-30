#!/usr/bin/env python3
"""Generate unrolled GF(2^255-19) mul/sq in GDScript, radix 2^25.5 (ref10 layout).

limb i has weight 2^ceil(25.5*i); f_i*g_j lands in h_{i+j} (x2 if i,j both odd),
wrapping i+j>=10 to h_{i+j-10} with a x19 factor. Every term is ONE multiply: the
constant factor is folded into precomputed operands (f_i*2, f_i*4, g_j*19), as ref10 does.
"""


def terms(square: bool):
    h = [[] for _ in range(10)]
    for i in range(10):
        for j in range(10):
            if square and j < i:
                continue
            k = i + j
            m = 1
            if i % 2 == 1 and j % 2 == 1:
                m *= 2
            if k >= 10:
                k -= 10
                m *= 19
            if square and i != j:
                m *= 2
            h[k].append((i, j, m))
    return h


def split(m: int):
    """m = a*b with a in {1,2,4} (left operand), b in {1,19} (right operand)."""
    for b in (19, 1):
        if m % b == 0 and (m // b) in (1, 2, 4):
            return m // b, b
    raise ValueError(m)


def gen(name: str, square: bool) -> str:
    rhs = "f" if square else "g"
    hs = terms(square)
    left_needed, right_needed = set(), set()
    body = []
    for k, lst in enumerate(hs):
        parts = []
        for (i, j, m) in lst:
            a, b = split(m)
            lv = f"f{i}" if a == 1 else f"f{i}_{a}"
            rv = f"{rhs}{j}" if b == 1 else f"{rhs}{j}_{b}"
            if a != 1:
                left_needed.add((i, a))
            if b != 1:
                right_needed.add((j, b))
            parts.append(f"{lv}*{rv}")
        body.append(f"\tvar h{k}: int = " + " + ".join(parts))
    out = []
    if square:
        out.append(f"static func {name}(f: PackedInt64Array) -> PackedInt64Array:")
    else:
        out.append(f"static func {name}(f: PackedInt64Array, g: PackedInt64Array) -> PackedInt64Array:")
    for i in range(10):
        out.append(f"\tvar f{i}: int = f[{i}]")
    if not square:
        for i in range(10):
            out.append(f"\tvar g{i}: int = g[{i}]")
    for (i, a) in sorted(left_needed):
        out.append(f"\tvar f{i}_{a}: int = f{i} * {a}")
    for (j, b) in sorted(right_needed):
        out.append(f"\tvar {rhs}{j}_{b}: int = {rhs}{j} * {b}")
    out += body
    out.append("\treturn _carry(h0, h1, h2, h3, h4, h5, h6, h7, h8, h9)")
    return "\n".join(out)


if __name__ == "__main__":
    print(gen("fe_mul", False))
    print()
    print()
    print(gen("fe_sq", True))
