// Second engine (JavaScriptCore, Safari's). Same say-only envelopes as the Node test; prints the final head.
const bytes = readFile('core/Core3.wasm', 'binary')
const mod = new WebAssembly.Module(bytes)
const i = new WebAssembly.Instance(mod, {}).exports
i.init()
const head = () => { let s = ''; for (let k = 0; k < 32; k++) s += i.head(k).toString(16).padStart(2, '0'); return s }
const utf8 = t => Array.from(unescape(encodeURIComponent(t)), c => c.charCodeAt(0))
const say = (parentHex, seq, text) => { const p = []; for (let k = 0; k < 64; k += 2) p.push(parseInt(parentHex.slice(k, k + 2), 16)); const t = utf8(text); return p.concat([seq & 255, seq >> 8, 0, t.length & 255, t.length >> 8], t) }
const feed = f => { for (const b of f) i.input(b); return i.step() }
const h0 = head(); const v1 = feed(say(h0, 1, 'hello from mythos')); const h1 = head()
const again = feed(say(h0, 1, 'hello from mythos')); const v2 = feed(say(h1, 2, 'second line'))
print('jsc verdicts ' + [v1, again, v2].join(',') + ' final head ' + head().slice(0, 16))
