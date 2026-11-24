# The 12 faces, the golden flip (phi -> 1 - phi) and the twin figure, in exact arithmetic (whole numbers a + b*phi).
# A second computation of what Twin.lean proves. Usage: python3 twin.py (run gen.py first; it writes tables.json).
from itertools import combinations, product
import json
def add(x, y): return (x[0]+y[0], x[1]+y[1])
def sub(x, y): return (x[0]-y[0], x[1]-y[1])
def mul(x, y): return (x[0]*y[0] + x[1]*y[1], x[0]*y[1] + x[1]*y[0] + x[1]*y[1])
ONE, ZERO, PHI, INV = (1, 0), (0, 0), (0, 1), (-1, 1); neg = lambda x: (-x[0], -x[1])
V = [tuple(ONE if s > 0 else neg(ONE) for s in sg) for sg in product((1, -1), repeat=3)]
for s1, s2 in product((1, -1), repeat=2):
    a = INV if s1 > 0 else neg(INV); b = PHI if s2 > 0 else neg(PHI)
    V += [(ZERO, a, b), (b, ZERO, a), (a, b, ZERO)]
d2 = lambda p, q: tuple(map(sum, zip(*[mul(sub(p[i], q[i]), sub(p[i], q[i])) for i in range(3)])))
cubes = json.load(open('tables.json'))['cubes']
EDGE = (8, -4)   # dodecahedron edge squared = (2/phi)^2 = 8 - 4 phi
nb = {i: [j for j in range(20) if d2(V[i], V[j]) == EDGE] for i in range(20)}
assert all(len(nb[i]) == 3 for i in range(20)), [len(nb[i]) for i in range(20)]
faces = set()
for i in range(20):
    for a, b in combinations(nb[i], 2):          # two edges at i span a face; walk around it
        cyc = [a, i, b]
        while True:
            nxt = [k for k in nb[cyc[-1]] if k != cyc[-2] and d2(V[k], V[cyc[-3]]) == (4, 0)]
            if not nxt: break
            if nxt[0] == cyc[0]: break
            cyc.append(nxt[0])
            if len(cyc) > 5: break
        if len(cyc) == 5 and d2(V[cyc[-1]], V[cyc[0]]) == EDGE: faces.add(tuple(sorted(cyc)))
faces = sorted(faces); print('faces', len(faces))
for f in faces:
    for v in f:
        ds = sorted(d2(V[v], V[w]) for w in f if w != v); assert ds == sorted([EDGE, EDGE, (4, 0), (4, 0)]), ds
    for c in cubes: assert len(set(f) & set(c)) == 2, (f, c)
    pairs = sorted(tuple(ci for ci, c in enumerate(cubes) if v in c) for v in f); assert len(set(pairs)) == 5
print('every face: regular pentagon pattern, every cube meets it in exactly 2 corners (one diagonal), 5 different owner pairs')
print('each corner in', {sum(v in f for f in faces) for v in range(20)}, 'faces')
conj = lambda x: (x[0] + x[1], -x[1]); cp = lambda p: tuple(conj(x) for x in p)
T = [cp(p) for p in V]; fixed = [i for i in range(20) if T[i] == V[i]]; print('fixed by the flip:', fixed, '| cube 0 =', cubes[0])
common = [i for i in range(20) if T[i] in V]; print('twin vertices that are also vertices:', common)
for c in cubes:
    for v in c:
        ds = sorted(d2(T[v], T[w]) for w in c if w != v); assert ds == [(4,0)]*3 + [(8,0)]*3 + [(12,0)]
print('the flipped figure has the same five cubes (same index lists)')
def cells(P):
    out = set()
    for c in cubes:
        for v in c: out.add(tuple(mul((4,0), x) for x in P[v]))
        for a, b in combinations(c, 2): out.add(tuple(mul((2,0), add(P[a][i], P[b][i])) for i in range(3)))
    return out
A, B = cells(V), cells(T); c0 = set()
for v in cubes[0]: c0.add(tuple(mul((4,0), x) for x in V[v]))
for a, b in combinations(cubes[0], 2): c0.add(tuple(mul((2,0), add(V[a][i], V[b][i])) for i in range(3)))
print('cells of figure', len(A), 'of twin', len(B), 'shared', len(A & B), 'cube 0 cells', len(c0), 'shared == cube 0:', (A & B) == c0, 'union', len(A | B))
rational = {p for p in A if all(x[1] == 0 for x in p)}; print('rational cells of the figure:', len(rational), '== cube 0:', rational == c0)
# owners of each rational corner among the 9 cubes of the pair (cube 0 shared, four of A, four of B)
own = [1 + sum(v in c for c in cubes[1:]) * 2 for v in cubes[0]]; print('owners of each rational corner in the pair:', own)
