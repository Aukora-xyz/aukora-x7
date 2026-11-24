#include <lean/lean.h>
extern lean_object *append_marker(lean_object *);
uint32_t round3_marker_probe(void) {
    lean_object *a = append_marker(lean_alloc_sarray(1, 0, 0));
    uint32_t result = lean_sarray_size(a) == 1 ? lean_sarray_cptr(a)[0] : 0;
    lean_dec_ref(a);
    return result;
}
