/* Read x values (first column) from stdin, print (x, candidate_log(x)) -- to compare a
 * candidate implementation against a native corpus. */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include "apple_log_impl.h"



int main (void)
{
	char line[512];
	while (fgets (line, sizeof line, stdin))
		{
			double x = strtod (line, NULL);
			if (!(x > 0.0)) continue;
			printf ("%.17g %.17g\n", x, apple_log (x));
		}
	return 0;
}
