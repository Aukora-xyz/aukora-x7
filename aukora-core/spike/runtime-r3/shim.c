// Route 2. This single-threaded Wasm target has no host error or exception channel.
#include <stddef.h>
void __wrap_lean_internal_panic(const char *message) { __builtin_trap(); }
void *__cxa_allocate_exception(size_t bytes) { __builtin_trap(); }
void __cxa_throw(void *exception, void *type, void (*destroy)(void *)) { __builtin_trap(); }
void _ZN4lean15save_stack_infoEb(_Bool main_thread) { __builtin_trap(); }
void __wrap_abort_message(const char *format, ...) { __builtin_trap(); }
void *__wrap_lean_task_get(void *task) { __builtin_trap(); }
