#include <lean/lean.h>
#include <string.h>
#include "exports.h"
#include "pinned.h"

void __wasm_call_ctors(void);
void r6_constants(void);
void r6_kernel_cpp_start(void);
static lean_object *pinned;
static bool started;

static lean_object *byte_array(const uint8_t *data, size_t size) {
    lean_object *bytes = lean_alloc_sarray(1, size, size);
    memcpy(lean_sarray_cptr(bytes), data, size);
    return bytes;
}

// This is private to the cell. The ABI has no environment or goal setter.
lean_object *r6_context(void) {
    if (!started) {
        started = true;
        __wasm_call_ctors();
        r6_constants();
        r6_kernel_cpp_start();
        lean_object *result = r6_kernel_init(byte_array(r6_environment, sizeof(r6_environment)),
                                             byte_array(r6_goal, sizeof(r6_goal)));
        if (!lean_is_scalar(result)) {
            pinned = lean_ctor_get(result, 0);
            lean_inc(pinned);
            lean_dec(result);
        }
    }
    return pinned;
}
