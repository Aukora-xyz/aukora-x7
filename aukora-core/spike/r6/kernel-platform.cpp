// Single-threaded Wasm supplies its own stack bounds and has no diagnostic stream.
// Only error presentation changes. All type operations use the upstream implementations.
#include <lean/lean.h>
#include <stdint.h>

extern "C" char __stack_low;
namespace lean {
size_t get_available_stack_size() {
    uintptr_t frame = reinterpret_cast<uintptr_t>(__builtin_frame_address(0));
    uintptr_t floor = reinterpret_cast<uintptr_t>(&__stack_low);
    if (frame < floor + 4096) __builtin_trap();
    return frame - floor - 2048;
}
}

extern "C" lean_obj_res __wrap_lean_expr_dbg_to_string(b_lean_obj_arg) {
    return lean_mk_string("<expr>");
}
extern "C" lean_obj_res __wrap_lean_io_eprintln(lean_obj_arg message, lean_obj_arg) {
    lean_dec(message);
    return lean_io_result_mk_ok(lean_box(0));
}

// The constructor order follows Lean's util/kernel module startup for these units.
namespace lean {
void initialize_name();
void initialize_level();
void initialize_expr();
}
extern "C" void r6_kernel_cpp_start() {
    lean::initialize_name();
    lean::initialize_level();
    lean::initialize_expr();
}

// The R5 runtime traps on C++ throw. Trap directly on these two fatal paths
// so a proof cell never initializes a terminal or process environment.
extern "C" lean_obj_res __wrap_lean_panic_fn(lean_obj_arg, lean_obj_arg) {
    __builtin_trap();
}
// The wasm32 C++ constructor ABI returns the object pointer.
extern "C" void *__wrap__ZN4lean21stack_space_exceptionC1EPKc(void *, const char *) {
    __builtin_trap();
}
