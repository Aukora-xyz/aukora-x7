/* Handwritten shim with 12 exported functions. Call reset(), then input(byte) 130 times in organ order.
   Each of the five reports contains 18 private trits followed by eight corners (0 failed, 1 unknown, 2 passed). */
#include <lean/lean.h>
#include <string.h>
#include "exports.h"
void __wasm_call_ctors(void);
static bool started, bad;
static uint8_t buf[130];
static uint32_t len;
static void start(void) { if (!started) { __wasm_call_ctors(); r6_constants(); started = true; } }
uint32_t reset(void) { len = 0; bad = false; return 1; }
uint32_t input(uint32_t byte) {
    if (byte > 255 || len == sizeof(buf)) bad = true;
    if (bad) return 0;
    buf[len++] = (uint8_t)byte;
    return 1;
}
static lean_object *take(void) {
    if (bad) return NULL;
    start();
    lean_object *bytes = lean_alloc_sarray(1, len, len);
    memcpy(lean_sarray_cptr(bytes), buf, len);
    return bytes;
}
uint32_t judge(void) { lean_object *b = take(); return b ? pentora_judge(b) : 0xFFFFFFFFu; }
uint32_t seams(void) { lean_object *b = take(); return b ? pentora_seams(b) : 0xFFFFFFFFu; }
/* A valid packet with no seams has mask zero. With seams, a suspect must own every disputed corner. */
uint32_t suspects(void) { lean_object *b = take(); return b ? pentora_suspects(b) : 0xFFFFFFFFu; }
uint32_t addressByte(uint32_t i) { lean_object *b = take(); return b ? pentora_address_byte(b, i) : 0xFFFFFFFFu; }
uint32_t tally(uint32_t c, uint32_t t) { lean_object *b = take(); return b ? pentora_tally(b, c, t) : 0xFFFFFFFFu; }
/* For a valid corner, zero selects its first owner and any nonzero w selects its second. */
uint32_t owner(uint32_t v, uint32_t w) { start(); return pentora_owner(v, w); }
uint32_t vertex(uint32_t c, uint32_t j) { start(); return pentora_vertex(c, j); }
/* Any caller with an agreeing buffer can read the corner sum modulo three.
   Do not use this trit as a key or put secrets in it. */
uint32_t seal(void) { lean_object *b = take(); return b ? pentora_seal(b) : 0xFFFFFFFFu; }
uint32_t centre(void) { lean_object *b = take(); return b ? pentora_centre(b) : 0xFFFFFFFFu; }
uint32_t heal(uint32_t x, uint32_t v) { lean_object *b = take(); return b ? pentora_heal(b, x, v) : 0xFFFFFFFFu; }
