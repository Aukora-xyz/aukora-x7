#include <lean/lean.h>
#include <string.h>
#include "exports.h"

void __wasm_call_ctors(void);
static uint8_t message[65536];
static uint32_t used;
static bool invalid, started;
static lean_object *result;

void clear(void) {
    used = 0;
    invalid = false;
    if (result) lean_dec(result);
    result = NULL;
}

uint32_t input(uint32_t byte) {
    if (byte > 255 || used == sizeof(message)) invalid = true;
    if (invalid) return 0;
    message[used++] = (uint8_t)byte;
    return 1;
}

// Keep the input across calls to allow repeat timings without host byte transfers.
uint32_t shake(uint32_t output_length) {
    if (result) lean_dec(result);
    result = NULL;
    if (invalid || output_length > 65536) return 0;
    if (!started) {
        __wasm_call_ctors();
        r6_constants();
        started = true;
    }
    lean_object *bytes = lean_alloc_sarray(1, used, used);
    memcpy(lean_sarray_cptr(bytes), message, used);
    result = r7_shake256(bytes, output_length);
    return lean_sarray_size(result) == output_length;
}

uint32_t output(uint32_t i) {
    if (!result || i >= lean_sarray_size(result)) return 256;
    return lean_sarray_cptr(result)[i];
}
