# What each PART of the figure determines of a polynomial field on the sphere, in EXACT arithmetic (no decimals).
# Numbers are a + b*phi with a, b fractions (phi^2 = phi + 1). A field of degree <= L splits into an even and an odd
# part. Each part is a homogeneous polynomial (use x^2 + y^2 + z^2 = 1 to lift every term to one degree), and a
# homogeneous polynomial at an unnormalised point is a nonzero multiple of its value in that direction. So rank can be
# computed at the unnormalised cell points themselves (coordinates in Z[phi]), one point per opposite pair. A part "determines degree L"
# when both ranks are full: (d+1)(d+2)/2 for d the largest even and the largest odd degree <= L.
from fractions import Fraction as F
from itertools import combinations, product
Z = (F(0), F(0)); ONE = (F(1), F(0))
add = lambda x, y: (x[0] + y[0], x[1] + y[1]); sub = lambda x, y: (x[0] - y[0], x[1] - y[1])
mul = lambda x, y: (x[0]*y[0] + x[1]*y[1], x[0]*y[1] + x[1]*y[0] + x[1]*y[1])
def inv(x): n = x[0]*x[0] + x[0]*x[1] - x[1]*x[1]; return ((x[0] + x[1]) / n, -x[1] / n)
neg = lambda x: (-x[0], -x[1])
def powr(x, k):
    r = ONE
    for _ in range(k): r = mul(r, x)
    return r
PHI, INV = (F(0), F(1)), (F(-1), F(1))
V = [tuple(ONE if s > 0 else neg(ONE) for s in sg) for sg in product((1, -1), repeat=3)]
for s1, s2 in product((1, -1), repeat=2):
    a = INV if s1 > 0 else neg(INV); b = PHI if s2 > 0 else neg(PHI); V += [(Z, a, b), (b, Z, a), (a, b, Z)]
cubes = [[0,1,2,3,4,5,6,7],[0,7,11,12,13,14,15,16],[1,6,8,9,13,16,17,18],[2,5,8,10,12,15,17,19],[3,4,9,10,11,14,18,19]]
d2 = lambda p, q: tuple(map(sum, zip(*[mul(sub(p[i], q[i]), sub(p[i], q[i])) for i in range(3)])))
cells = {}
for ci, c in enumerate(cubes):
    for v in c: cells.setdefault(tuple(mul((F(2), F(0)), x) for x in V[v]), {'kind': 'corner', 'owners': set()})['owners'].add(ci)
    for a, b in combinations(c, 2):
        d = d2(V[a], V[b])
        if d in ((4, 0), (8, 0)):
            cells.setdefault(tuple(add(V[a][i], V[b][i]) for i in range(3)), {'kind': 'edge' if d == (4, 0) else 'face', 'owners': set()})['owners'].add(ci)
assert len(cells) == 110
def rank(points, d):
    mons = [(a, b, d - a - b) for a in range(d + 1) for b in range(d + 1 - a)]
    M = [[mul(mul(powr(p[0], a), powr(p[1], b)), powr(p[2], c)) for (a, b, c) in mons] for p in points]
    r = 0
    for col in range(len(mons)):
        piv = next((i for i in range(r, len(M)) if M[i][col] != Z), None)
        if piv is None: continue
        M[r], M[piv] = M[piv], M[r]; iv = inv(M[r][col]); M[r] = [mul(x, iv) for x in M[r]]
        for i in range(len(M)):
            if i != r and M[i][col] != Z: f = M[i][col]; M[i] = [sub(x, mul(f, y)) for x, y in zip(M[i], M[r])]
        r += 1
        if r == len(M): break
    return r
def reps(keys):
    out, seen = [], set()
    for k in keys:
        if k in seen: continue
        nk = tuple(neg(x) for x in k); assert nk in keys, 'the part is not closed under opposite points'
        seen.add(k); seen.add(nk); out.append(k)
    return out
def full(keys, L):
    R = reps(set(keys))
    for d in {L - (L % 2), L - 1 + (L % 2)}:
        if d < 0: continue
        if rank(R, d) != (d + 1) * (d + 2) // 2: return False
    return True
def best(keys):
    L = -1
    while full(keys, L + 1): L += 1
    return L
sel = lambda f: [k for k, v in cells.items() if f(v)]
def row(name, keys): L = best(keys); print(f"{name:46s} cells {len(keys):3d}  determines degree <= {L:2d} = {(L+1)**2:3d} numbers; degree {L+1} is NOT determined")
row('all five organs', sel(lambda v: True))
for k in (4, 3, 2, 1):
    res = sorted({best(sel(lambda v, S=set(S): v['owners'] & S)) for S in combinations(range(5), k)})
    n = len(sel(lambda v, S=set(range(k)): v['owners'] & S))
    print(f"any {k} organs (every one of the {len(list(combinations(range(5), k)))} choices)".ljust(46), f"cells {n:3d}  determines degree <= {res} = {[(L+1)**2 for L in res]} numbers")
row('the 20 corners only', sel(lambda v: v['kind'] == 'corner'))
row('the 30 face centres only', sel(lambda v: v['kind'] == 'face'))
row('the 60 edge middles only', sel(lambda v: v['kind'] == 'edge'))
row('corners + edge middles (80), no face centres', sel(lambda v: v['kind'] != 'face'))
row('corners + face centres (50)', sel(lambda v: v['kind'] != 'edge'))
row('edge middles + face centres (90)', sel(lambda v: v['kind'] != 'corner'))
row('one organ without its face centres (20)', sel(lambda v: 0 in v['owners'] and v['kind'] != 'face'))
