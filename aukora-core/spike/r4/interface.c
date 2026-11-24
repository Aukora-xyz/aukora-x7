#include <lean/lean.h>
#include <string.h>
#include "exports.h"

void __wasm_call_ctors(void);
void r4_constants(void);

static lean_object *current;
static uint8_t frame[65535];
static uint32_t length;
static bool invalid_frame, invalid_candidate;

uint32_t init(void) {
    if (!current) {
        __wasm_call_ctors();
        r4_constants();
        current = r4_genesis(0);
    }
    return 1;
}

uint32_t input(uint32_t byte) {
    if (!current || invalid_candidate) return 0;
    if (byte > 255 || length == sizeof(frame)) invalid_frame = true;
    if (invalid_frame) return 0;
    frame[length++] = (uint8_t)byte;
    return 1;
}

// Consume exactly one frame or candidate chunk, including any input error.
static lean_object *take_bytes(void) {
    uint32_t size = length;
    bool ok = current && !invalid_frame && !invalid_candidate;
    length = 0;
    invalid_frame = false;
    if (!ok) return NULL;
    lean_object *bytes = lean_alloc_sarray(1, size, size);
    memcpy(lean_sarray_cptr(bytes), frame, size);
    return bytes;
}

uint32_t reset(void) {
    if (!current) return 0;
    length = 0;
    invalid_frame = invalid_candidate = false;
    current = r4_reset(current);
    return 1;
}

uint32_t feed(void) {
    lean_object *chunk = take_bytes();
    if (!chunk) {
        if (current) invalid_candidate = true;
        return 0;
    }
    current = r4_feed(chunk, current);
    return 1;
}

uint32_t step(void) {
    lean_object *bytes = take_bytes();
    if (!bytes) return 0;
    lean_inc(current);  // Retain the previous state if Lean returns none.
    lean_object *result = r4_step(bytes, current);
    if (lean_is_scalar(result)) return 0;
    lean_object *next = lean_ctor_get(result, 0);
    lean_inc(next);
    lean_dec(result);
    lean_dec(current);
    current = next;
    return 1;
}

uint32_t head(uint32_t index) {
    if (!current || index >= 32) return 256;
    lean_inc(current);
    return lean_unbox(r4_head_byte(current, index));
}

uint32_t core(uint32_t index) {
    if (!current || index >= 32) return 256;
    lean_inc(current);
    return lean_unbox(r4_core_byte(current, index));
}
