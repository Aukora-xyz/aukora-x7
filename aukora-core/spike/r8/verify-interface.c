#include <lean/lean.h>
#include <string.h>
#include "exports.h"

void __wasm_call_ctors(void);
static struct {
    uint8_t bytes[65536];
    uint32_t length;
} fields[3];
static bool invalid, started;

/* This test ABI preserves independent field lengths, including malformed ones. */
void clear(void) {
    invalid = false;
    for (unsigned i = 0; i < 3; ++i) fields[i].length = 0;
}

uint32_t input(uint32_t field, uint32_t byte) {
    if (field >= 3 || byte > 255 || fields[field].length >= sizeof(fields[field].bytes))
        invalid = true;
    if (invalid) return 0;
    fields[field].bytes[fields[field].length++] = (uint8_t)byte;
    return 1;
}

static lean_object *copy_field(unsigned i) {
    uint32_t n = fields[i].length;
    lean_object *array = lean_alloc_sarray(1, n, n);
    memcpy(lean_sarray_cptr(array), fields[i].bytes, n);
    return array;
}

uint32_t verify(void) {
    if (invalid) return 0;
    if (!started) {
        __wasm_call_ctors();
        r6_constants();
        started = true;
    }
    return r8_mldsa_verify(copy_field(0), copy_field(1), copy_field(2));
}
