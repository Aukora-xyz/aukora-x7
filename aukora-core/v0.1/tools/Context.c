#include <lean/lean.h>
#include <string.h>
#include "exports.h"
#include "pinned.h"

void __wasm_call_ctors(void);
void r6_kernel_cpp_start(void);
static bool tried;
static lean_object *context;

lean_object *r9_context(void) {
    if (tried) return context;
    tried = true;
    __wasm_call_ctors();
    r6_constants();
    r6_kernel_cpp_start();
    lean_object *bytes = lean_alloc_sarray(1, sizeof(r9_environment), sizeof(r9_environment));
    memcpy(lean_sarray_cptr(bytes), r9_environment, sizeof(r9_environment));
    lean_object *result = r9_kernel_init(bytes);
    if (!lean_is_scalar(result)) {
        context = lean_ctor_get(result, 0);
        lean_inc(context);
        lean_dec(result);
    }
    return context;
}
