#pragma once
namespace lean {
struct stack_guard {};
void initialize_stack_overflow();
void finalize_stack_overflow();
}
