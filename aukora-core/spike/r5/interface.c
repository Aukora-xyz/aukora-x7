#include <lean/lean.h>
#include <string.h>
#include "exports.h"

void __wasm_call_ctors(void);
void r5_constants(void);
static bool started, invalid_frame, invalid_candidate;
static lean_object *current;
static uint8_t frame[65535];
static uint32_t length;

static void start(void) {
    if (started) return;
    __wasm_call_ctors();
    r5_constants();
    started = true;
}

uint32_t input(uint32_t byte) {
    if (byte > 255 || length == sizeof(frame)) invalid_frame = true;
    if (invalid_frame || invalid_candidate) return 0;
    frame[length++] = (uint8_t)byte;
    return 1;
}

// Every consumer discards its complete input, including a malformed frame.
static lean_object *take_bytes(void) {
    uint32_t size = length;
    bool ok = !invalid_frame && !invalid_candidate;
    length = 0;
    invalid_frame = false;
    if (!ok) return NULL;
    start();
    lean_object *bytes = lean_alloc_sarray(1, size, size);
    memcpy(lean_sarray_cptr(bytes), frame, size);
    return bytes;
}

// Lean owns both the new Option and the state it contains. Keep the latter.
static uint32_t accept(lean_object *result) {
    if (lean_is_scalar(result)) return 0;
    lean_object *next = lean_ctor_get(result, 0);
    lean_inc(next);
    lean_dec(result);
    if (current) lean_dec(current);
    current = next;
    return 1;
}

uint32_t init(void) {
    lean_object *key = take_bytes();
    if (!key) return 0;
    if (current || lean_sarray_size(key) != 32) {
        lean_dec(key);
        return 0;
    }
    return accept(r5_genesis(key));
}

uint32_t reset(void) {
    length = 0;
    invalid_frame = invalid_candidate = false;
    if (!current) return 0;
    current = r5_reset(current);
    return 1;
}

uint32_t feed(void) {
    lean_object *chunk = take_bytes();
    if (!chunk) {
        if (current) invalid_candidate = true;
        return 0;
    }
    if (!current) { lean_dec(chunk); return 0; }
    current = r5_feed(chunk, current);
    return 1;
}

uint32_t step(void) {
    lean_object *wire = take_bytes();
    if (!wire) return 0;
    if (!current) { lean_dec(wire); return 0; }
    lean_inc(current);  // A refusal leaves the current machine intact.
    return accept(r5_step(wire, current));
}

uint32_t verify(void) {
    lean_object *packed = take_bytes();
    return packed ? r5_verify_packed(packed) : 0;
}

uint32_t head(uint32_t index) {
    if (!current || index >= 32) return 256;
    lean_inc(current);
    return lean_unbox(r5_head_byte(current, index));
}

uint32_t core(uint32_t index) {
    if (!current || index >= 32) return 256;
    lean_inc(current);
    return lean_unbox(r5_core_byte(current, index));
}
