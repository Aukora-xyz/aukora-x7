/* A NATIVE twin of the small core, for differential testing. The same C that the Lean compiler emitted for the
 * small core (reachable.c) and the same shim (Interface.c, RELEASE_LITE) are compiled for the host CPU (64-bit
 * arm64) against Lean's own native runtime, instead of for 32-bit WebAssembly against the lab's WASI runtime port.
 * It reads an input stream on stdin and prints, for every input, the verdict and every exported value, in exactly
 * the format drt/drt.mjs uses, so the two can be compared line by line.
 * Input lines:  NEW                       start a fresh instance (a new record)
 *               <op> <hex or ->           op is init, initBound, step, feed, reset, stamp, seal, continueRecord
 * Output lines: <verdict> <view>          view = head|core|recordId|law|journal|seal|halted,threshold,ceiling,stamps
 * One process holds one instance at a time; NEW re-executes this program (the shim keeps static state). */
#include <lean/lean.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

void __wasm_call_ctors(void) {}
uint32_t input(uint32_t), init(void), initBound(void), reset(void), feed(void), step(void), stamp(void), seal(void),
  continueRecord(void), head(uint32_t), core(uint32_t), recordIdByte(uint32_t), lawByte(uint32_t),
  journalByte(uint32_t), sealByte(uint32_t), halted(void), threshold(void), guessCeiling(void), stampCount(void);
extern void lean_initialize_runtime_module(void);

static void b32(uint32_t (*f)(uint32_t)) {
  char out[65]; for (int i = 0; i < 32; i++) { uint32_t v = f(i); if (v > 255) { fputs("none", stdout); return; } sprintf(out + 2 * i, "%02x", v); }
  fputs(out, stdout);
}
static int hexval(int c) { return c <= '9' ? c - '0' : (c | 32) - 'a' + 10; }

int main(int argc, char **argv) {
  lean_initialize_runtime_module();
  lean_set_panic_messages(false);
  static char line[1 << 24];
  long skip = argc > 1 ? atol(argv[1]) : 0;   /* after a NEW, the program re-executes itself with the line count to skip */
  long n = 0;
  while (fgets(line, sizeof line, stdin)) {
    if (n++ < skip) continue;
    line[strcspn(line, "\n")] = 0;
    if (strcmp(line, "NEW") == 0) {
      if (n == skip + 1) continue;           /* the NEW that started this instance */
      fflush(stdout);
      char arg[32]; snprintf(arg, sizeof arg, "%ld", n - 1);
      /* re-exec with the rest of stdin: rewind is not possible on a pipe, so the caller passes a FILE as stdin */
      if (fseek(stdin, 0, SEEK_SET) != 0) { fputs("ERR stdin must be a file\n", stdout); return 2; }
      execv(argv[0], (char *[]){argv[0], arg, NULL});
      return 3;
    }
    char *sp = strchr(line, ' '); if (!sp) { puts("ERR bad line"); return 2; }
    *sp = 0; const char *op = line, *hex = sp + 1;
    if (strcmp(hex, "-") != 0) for (size_t i = 0; hex[i] && hex[i + 1]; i += 2) input((uint32_t)(hexval(hex[i]) * 16 + hexval(hex[i + 1])));
    uint32_t v;
    if (!strcmp(op, "init")) v = init(); else if (!strcmp(op, "initBound")) v = initBound(); else if (!strcmp(op, "step")) v = step();
    else if (!strcmp(op, "feed")) v = feed(); else if (!strcmp(op, "reset")) v = reset(); else if (!strcmp(op, "stamp")) v = stamp();
    else if (!strcmp(op, "seal")) v = seal(); else if (!strcmp(op, "continueRecord")) v = continueRecord();
    else { puts("ERR unknown op"); return 2; }
    printf("%u ", v);
    b32(head); putchar('|'); b32(core); putchar('|'); b32(recordIdByte); putchar('|'); b32(lawByte); putchar('|');
    b32(journalByte); putchar('|'); b32(sealByte);
    printf("|%u,%u,%u,%u\n", halted(), threshold(), guessCeiling(), stampCount());
  }
  return 0;
}
