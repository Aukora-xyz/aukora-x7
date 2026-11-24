#include <lean/lean.h>
#include <string.h>

void __wasm_call_ctors(void);
void r3_constants(void);
lean_obj_res r3_genesis(uint8_t unit);
lean_obj_res r3_step(lean_obj_arg bytes, lean_obj_arg old);
lean_obj_res r3_head_byte(lean_obj_arg state, uint32_t index);

static lean_object *current;
static uint8_t frame[65535];
static uint32_t length;
static bool invalid;

uint32_t init(void) {
    if (!current) {
        __wasm_call_ctors();
        r3_constants();
        current = r3_genesis(0);
    }
    return 1;
}

// A bad byte or oversized frame poisons this frame until step consumes it.
uint32_t input(uint32_t byte) {
    if (!current) return 0;
    if (byte > 255 || length == sizeof(frame)) invalid = true;
    if (invalid) return 0;
    frame[length++] = (uint8_t)byte;
    return 1;
}

uint32_t step(void) {
    uint32_t size = length;
    bool ok = current && !invalid;
    invalid = false;
    length = 0;
    if (!ok) return 0;
    lean_object *bytes = lean_alloc_sarray(1, size, size);
    memcpy(lean_sarray_cptr(bytes), frame, size);
    lean_inc(current);  // Generated r3_step consumes both arguments.
    lean_object *result = r3_step(bytes, current);
    if (lean_is_scalar(result)) return 0;  // Option.none
    lean_object *next = lean_ctor_get(result, 0);  // Option.some State
    lean_inc(next);
    lean_dec(result);
    lean_dec(current);
    current = next;
    return 1;
}

uint32_t head(uint32_t index) {
    if (!current || index >= 32) return 256;
    lean_inc(current);  // Generated r3_head_byte consumes the state.
    return lean_unbox(r3_head_byte(current, index));
}
