// No alternate signal stack or overflow reporting in the WASI build.
#include "runtime/stack_overflow.h"
namespace lean {
void initialize_stack_overflow() {}
void finalize_stack_overflow() {}
}
