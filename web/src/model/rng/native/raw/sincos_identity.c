/* Which entry point does the shipped libSystem actually have at `sinf + 0x1ac`?
 *
 *   clang -O2 sincos_identity.c -o /tmp/sincos_identity && /tmp/sincos_identity
 */
#include <dlfcn.h>
#include <math.h>
#include <stdio.h>

int main (void)
{
	const char *names[] = {"sinf", "cosf", "sincosf", "__sincosf_stret", "__sincos", "sincos", "sin", "cos"};
	for (unsigned i = 0; i < sizeof names / sizeof *names; i++) {
		void *p = dlsym (RTLD_DEFAULT, names[i]);
		printf ("%-18s %p   (sinf%+ld)\n", names[i], p,
			p ? (long) ((const char *) p - (const char *) (void *) sinf) : 0L);
	}
	printf ("sinf               %p\n", (void *) sinf);
	printf ("cosf               %p   (sinf%+ld)\n", (void *) cosf,
		(long) ((const char *) (void *) cosf - (const char *) (void *) sinf));
	return 0;
}
