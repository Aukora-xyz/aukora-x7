#include <lean/lean.h>
#include <string.h>
#include "exports.h"

lean_object *r7_context(unsigned slot);
static uint8_t input_bytes[1024 * 1024];
static size_t length;
static bool invalid;

uint32_t ready(unsigned slot) { return r7_context(slot) != NULL; }

uint32_t input(uint32_t value) {
    if (value > 255 || length == sizeof(input_bytes)) invalid = true;
    if (invalid) return 0;
    input_bytes[length++] = (uint8_t)value;
    return 1;
}

uint32_t check(unsigned slot) {
    size_t size = length;
    bool valid = !invalid;
    length = 0;
    invalid = false;
    lean_object *context = r7_context(slot);
    if (!context || !valid) return 0;
    lean_object *proof = lean_alloc_sarray(1, size, size);
    memcpy(lean_sarray_cptr(proof), input_bytes, size);
    lean_inc(context);
    return r6_kernel_check(context, proof);
}
