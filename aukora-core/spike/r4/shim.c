// Lean's WASI trap policy also applies to libc++ fatal diagnostics.
#include "../runtime-r3/shim.c"
void __wrap__ZNSt3__222__libcpp_verbose_abortEPKcz(const char *format, ...) { __builtin_trap(); }
