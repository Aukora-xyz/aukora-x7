#include <lean/lean.h>
#include <string.h>
#include "exports.h"
#include "pinned.h"

void __wasm_call_ctors(void);
void r6_kernel_cpp_start(void);
static bool started, tried[2];
static lean_object *contexts[2];

static lean_object *byte_array(const uint8_t *data, size_t size) {
    lean_object *bytes = lean_alloc_sarray(1, size, size);
    memcpy(lean_sarray_cptr(bytes), data, size);
    return bytes;
}

lean_object *r7_context(unsigned slot) {
    if (slot > 1) return NULL;
    if (!started) {
        started = true;
        __wasm_call_ctors();
        r6_constants();
        r6_kernel_cpp_start();
    }
    if (!tried[slot]) {
        tried[slot] = true;
        lean_object *goal = slot ? byte_array(r7_alternate, sizeof(r7_alternate))
                                 : byte_array(r7_primary, sizeof(r7_primary));
        lean_object *result = r6_kernel_init(byte_array(r7_environment, sizeof(r7_environment)), goal);
        if (!lean_is_scalar(result)) {
            contexts[slot] = lean_ctor_get(result, 0);
            lean_inc(contexts[slot]);
            lean_dec(result);
        }
    }
    return contexts[slot];
}
