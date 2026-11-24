# Exact construction of the five cubes in a dodecahedron, arithmetic in Z[phi] (a + b*phi, phi^2 = phi + 1). No floats.
from itertools import combinations, product
def add(x, y): return (x[0]+y[0], x[1]+y[1])
def sub(x, y): return (x[0]-y[0], x[1]-y[1])
def mul(x, y): return (x[0]*y[0] + x[1]*y[1], x[0]*y[1] + x[1]*y[0] + x[1]*y[1])
ONE, ZERO, PHI, INV = (1, 0), (0, 0), (0, 1), (-1, 1)          # 1/phi = phi - 1
neg = lambda x: (-x[0], -x[1])
V = [tuple(ONE if s > 0 else neg(ONE) for s in sg) for sg in product((1, -1), repeat=3)]
for s1, s2 in product((1, -1), repeat=2):
    a = INV if s1 > 0 else neg(INV); b = PHI if s2 > 0 else neg(PHI)
    V += [(ZERO, a, b), (b, ZERO, a), (a, b, ZERO)]
assert len(set(V)) == 20
d2 = lambda p, q: tuple(map(sum, zip(*[mul(sub(p[i], q[i]), sub(p[i], q[i])) for i in range(3)])))
E, F, B = (4, 0), (8, 0), (12, 0)
nb = {i: [j for j in range(20) if d2(V[i], V[j]) == E] for i in range(20)}
cubes = set()
for i in range(20):
    for trio in combinations(nb[i], 3):
        if all(d2(V[a], V[b]) == F for a, b in combinations(trio, 2)):
            S = {i, *trio}
            grow = True
            while grow:
                grow = False
                for j in range(20):
                    if j not in S and sum(1 for k in S if d2(V[j], V[k]) == E) >= 2 and all(d2(V[j], V[k]) in (E, F, B) for k in S):
                        S.add(j); grow = True
            if len(S) == 8: cubes.add(tuple(sorted(S)))
cubes = sorted(cubes); assert len(cubes) == 5, len(cubes)
for c in cubes:
    for v in c:
        ds = sorted(d2(V[v], V[w]) for w in c if w != v); assert ds == [E]*3 + [F]*3 + [B], ds
assert all(sum(v in c for c in cubes) == 2 for v in range(20))
assert all(len(set(a) & set(b)) == 2 for a, b in combinations(cubes, 2))
home = {v: [(ci, c.index(v)) for ci, c in enumerate(cubes) if v in c] for v in range(20)}
pts = set()
for c in cubes:
    for v in c: pts.add(('corner', tuple(mul((4, 0), x) for x in V[v])))
    for a, b in combinations(c, 2):
        m = tuple(mul((2, 0), add(V[a][i], V[b][i])) for i in range(3)); d = d2(V[a], V[b])
        pts.add((('edge' if d == E else 'face' if d == F else 'centre'), m))
kinds = {k: sum(1 for p in pts if p[0] == k) for k in ('corner', 'edge', 'face', 'centre')}
assert kinds == {'corner': 20, 'edge': 60, 'face': 30, 'centre': 1}, kinds
assert len({p[1] for p in pts}) == 111
print('cubes', cubes); print('kinds', kinds)
z = lambda x: f"⟨{x[0]}, {x[1]}⟩"
with open('tables.lean.txt', 'w') as f:
    f.write("def vertices : List (Zphi × Zphi × Zphi) := [\n  " + ",\n  ".join(f"({z(v[0])}, {z(v[1])}, {z(v[2])})" for v in V) + "]\n\n")
    f.write("def cubeTable : List (List Nat) := [" + ", ".join("[" + ", ".join(map(str, c)) + "]" for c in cubes) + "]\n\n")
    f.write("def home1Table : List (Nat × Nat) := [" + ", ".join(f"({home[v][0][0]}, {home[v][0][1]})" for v in range(20)) + "]\n")
    f.write("def home2Table : List (Nat × Nat) := [" + ", ".join(f"({home[v][1][0]}, {home[v][1][1]})" for v in range(20)) + "]\n")
import json; json.dump({'cubes': cubes, 'home': {str(v): home[v] for v in home}}, open('tables.json', 'w'))
