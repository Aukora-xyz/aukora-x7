// Lean compiler output
// Module: spike.Add
// Imports: Init
#include <lean/lean.h>
#if defined(__clang__)
#pragma clang diagnostic ignored "-Wunused-parameter"
#pragma clang diagnostic ignored "-Wunused-label"
#elif defined(__GNUC__) && !defined(__CLANG__)
#pragma GCC diagnostic ignored "-Wunused-parameter"
#pragma GCC diagnostic ignored "-Wunused-label"
#pragma GCC diagnostic ignored "-Wunused-but-set-variable"
#endif
#ifdef __cplusplus
extern "C" {
#endif
LEAN_EXPORT lean_object* l_acceptLength___boxed(lean_object*, lean_object*, lean_object*);
uint8_t lean_uint32_dec_eq(uint32_t, uint32_t);
LEAN_EXPORT uint32_t accept_length(uint32_t, uint32_t, uint32_t);
LEAN_EXPORT uint32_t accept_length(uint32_t x_1, uint32_t x_2, uint32_t x_3) {
_start:
{
uint8_t x_4; 
x_4 = lean_uint32_dec_eq(x_1, x_2);
if (x_4 == 0)
{
uint32_t x_5; 
x_5 = 0;
return x_5;
}
else
{
uint32_t x_6; uint8_t x_7; 
x_6 = 0;
x_7 = lean_uint32_dec_eq(x_3, x_6);
if (x_7 == 0)
{
uint32_t x_8; 
x_8 = 1;
return x_8;
}
else
{
return x_6;
}
}
}
}
LEAN_EXPORT lean_object* l_acceptLength___boxed(lean_object* x_1, lean_object* x_2, lean_object* x_3) {
_start:
{
uint32_t x_4; uint32_t x_5; uint32_t x_6; uint32_t x_7; lean_object* x_8; 
x_4 = lean_unbox_uint32(x_1);
lean_dec(x_1);
x_5 = lean_unbox_uint32(x_2);
lean_dec(x_2);
x_6 = lean_unbox_uint32(x_3);
lean_dec(x_3);
x_7 = accept_length(x_4, x_5, x_6);
x_8 = lean_box_uint32(x_7);
return x_8;
}
}
lean_object* initialize_Init(uint8_t builtin, lean_object*);
static bool _G_initialized = false;
LEAN_EXPORT lean_object* initialize_spike_Add(uint8_t builtin, lean_object* w) {
lean_object * res;
if (_G_initialized) return lean_io_result_mk_ok(lean_box(0));
_G_initialized = true;
res = initialize_Init(builtin, lean_io_mk_world());
if (lean_io_result_is_error(res)) return res;
lean_dec_ref(res);
return lean_io_result_mk_ok(lean_box(0));
}
#ifdef __cplusplus
}
#endif
