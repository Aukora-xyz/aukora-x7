/* The whole of the C in the organ's Wasm file: a byte buffer and five calls into the Lean-generated code. */
#include <lean/lean.h>
#include <string.h>
#include "exports.h"
void __wasm_call_ctors(void);
static bool started, bad;
static uint8_t buf[96 + 5 * 4096];
static uint32_t len;
uint32_t input(uint32_t byte) {
    if (byte > 255 || len == sizeof(buf)) bad = true;
    if (bad) return 0;
    buf[len++] = (uint8_t)byte;
    return 1;
}
static lean_object *take(void) {
    uint32_t size = len; bool ok = !bad;
    len = 0; bad = false;
    if (!ok) return NULL;
    if (!started) { __wasm_call_ctors(); r6_constants(); started = true; }
    lean_object *bytes = lean_alloc_sarray(1, size, size);
    memcpy(lean_sarray_cptr(bytes), buf, size);
    return bytes;
}
uint32_t decide(void) { lean_object *b = take(); return b ? radio_decide(b) : 0xFFFFFFFFu; }
uint32_t laws(void) { lean_object *b = take(); return b ? radio_laws(b) : 0xFFFFFFFFu; }
uint32_t energyFor(void) { lean_object *b = take(); return b ? radio_for(b) : 0xFFFFFFFFu; }
uint32_t energyAgainst(void) { lean_object *b = take(); return b ? radio_against(b) : 0xFFFFFFFFu; }
uint32_t honest(void) { lean_object *b = take(); return b ? radio_honest(b) : 0xFFFFFFFFu; }
