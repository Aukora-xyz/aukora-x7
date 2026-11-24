/* The whole of the C in the backup checker's Wasm file: a byte buffer and one call into the Lean-generated code. */
#include <lean/lean.h>
#include <string.h>
#include "exports.h"
void __wasm_call_ctors(void);
static bool started, bad;
static uint8_t buf[4 * 1024 * 1024];
static uint32_t len;
uint32_t input(uint32_t byte) {
    if (byte > 255 || len == sizeof(buf)) bad = true;
    if (bad) return 0;
    buf[len++] = (uint8_t)byte;
    return 1;
}
uint32_t verdict(void) {
    uint32_t size = len; bool ok = !bad;
    len = 0; bad = false;
    if (!ok) return 0xFFFFFFFFu;
    if (!started) { __wasm_call_ctors(); r6_constants(); started = true; }
    lean_object *bytes = lean_alloc_sarray(1, size, size);
    memcpy(lean_sarray_cptr(bytes), buf, size);
    return backup_verdict(bytes);
}
