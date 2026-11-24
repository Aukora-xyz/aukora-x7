# Does a rule on six whole numbers give exactly the 110 outer cells? Exact, no tables used by the rule.
# A point is q = (q1, q2, q3), q_i = a_i + b_i*phi (twice the cell's position). phi*(a + b*phi) = b + (a + b)*phi.
from itertools import product, combinations
def inL(q):                                   # y = phi*x and z = phi*y, both modulo 2
    (ax, bx), (ay, by), (az, bz) = q
    return (ay - bx) % 2 == 0 and (by - ax - bx) % 2 == 0 and (az - by) % 2 == 0 and (bz - ay - by) % 2 == 0
def norm(q):                                  # q.q as (whole part, phi part)
    return (sum(a*a + b*b for a, b in q), sum(2*a*b + b*b for a, b in q))
def rule(q):
    n = norm(q)
    if n in ((4, 0), (8, 0)): return inL(q)
    if n == (12, 0):
        if any(a % 2 or b % 2 for a, b in q): return False
        return inL(tuple((a // 2 - 1, b // 2) for a, b in q))
    return False
by_rule = set()
for t in product(range(-3, 4), repeat=6):     # the whole part of q.q is a sum of squares <= 12, so every number is in -3..3
    q = ((t[0], t[1]), (t[2], t[3]), (t[4], t[5]))
    if rule(q): by_rule.add(q)
# the figure, built the long way (as in gen.py)
add = lambda x, y: (x[0]+y[0], x[1]+y[1]); sub = lambda x, y: (x[0]-y[0], x[1]-y[1])
mul = lambda x, y: (x[0]*y[0] + x[1]*y[1], x[0]*y[1] + x[1]*y[0] + x[1]*y[1]); neg = lambda x: (-x[0], -x[1])
ONE, ZERO, PHI, INV = (1, 0), (0, 0), (0, 1), (-1, 1)
V = [tuple(ONE if s > 0 else neg(ONE) for s in sg) for sg in product((1, -1), repeat=3)]
for s1, s2 in product((1, -1), repeat=2):
    a = INV if s1 > 0 else neg(INV); b = PHI if s2 > 0 else neg(PHI); V += [(ZERO, a, b), (b, ZERO, a), (a, b, ZERO)]
cubes = [[0,1,2,3,4,5,6,7],[0,7,11,12,13,14,15,16],[1,6,8,9,13,16,17,18],[2,5,8,10,12,15,17,19],[3,4,9,10,11,14,18,19]]
d2 = lambda p, q: tuple(map(sum, zip(*[mul(sub(p[i], q[i]), sub(p[i], q[i])) for i in range(3)])))
fig = set()
for c in cubes:
    for v in c: fig.add(tuple(mul((2, 0), x) for x in V[v]))                       # corner: q = 2 * position
    for a, b in combinations(c, 2):
        if d2(V[a], V[b]) in ((4, 0), (8, 0)): fig.add(tuple(add(V[a][i], V[b][i]) for i in range(3)))   # middle: q = v + w
shell = lambda S, n: sum(1 for q in S if norm(q) == (n, 0))
print('by the rule:', len(by_rule), '| shells 4/8/12:', shell(by_rule, 4), shell(by_rule, 8), shell(by_rule, 12))
print('the figure :', len(fig), '| shells 4/8/12:', shell(fig, 4), shell(fig, 8), shell(fig, 12))
print('same set:', by_rule == fig, '| rule only:', len(by_rule - fig), '| figure only:', len(fig - by_rule))
