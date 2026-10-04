/* Settle LLVM's FMA mnemonic naming by compiling the three spellings and reading the
 * encodings back. `objdump` is LLVM's own disassembler, so this is exactly the mapping
 * the W1d/W1d-followup transcriptions are read with.
 *
 *   clang -O2 -ffp-contract=fast -c fmaenc2.c -o /tmp/fmaenc2.o && objdump -d /tmp/fmaenc2.o
 */

double f_sub (double a, double b, double c) { return c - a * b; }        /* Da - Dn*Dm  */
double f_neg (double a, double b, double c) { return -(a * b) + c; }     /* -(Dn*Dm) + Da */
double f_add (double a, double b, double c) { return a * b - c; }        /* Dn*Dm - Da  */
double f_madd (double a, double b, double c) { return a * b + c; }       /* Dn*Dm + Da  */
