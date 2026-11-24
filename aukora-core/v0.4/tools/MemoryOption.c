/* Lean 4.19's CLI sets its native limit with -M but its front end rejects
   the unregistered Nat option. Register the same name and type, without
   changing the CLI, allocator, elaborator, kernel, or any theorem. */
#include <lean/lean.h>
extern lean_object *l_Lean_Name_str___override(lean_object *, lean_object *);
extern lean_object *lean_register_option(lean_object *, lean_object *, lean_object *);

LEAN_EXPORT lean_object *initialize_MemoryOption(uint8_t builtin, lean_object *world) {
    (void)builtin;
    lean_object *name = l_Lean_Name_str___override(lean_box(0), lean_mk_string("max_memory"));
    lean_object *value = lean_alloc_ctor(3, 1, 0); /* DataValue.ofNat */
    lean_ctor_set(value, 0, lean_unsigned_to_nat(4096));
    lean_object *decl = lean_alloc_ctor(0, 4, 0); /* Lean.OptionDecl */
    lean_inc(name);
    lean_ctor_set(decl, 0, name);
    lean_ctor_set(decl, 1, value);
    lean_ctor_set(decl, 2, lean_mk_string(""));
    lean_ctor_set(decl, 3, lean_mk_string("Native -M memory limit in megabytes"));
    return lean_register_option(name, decl, world);
}
