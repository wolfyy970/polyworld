Welcome to the modern version of Polyworld, an Artificial Life
system designed as an approach to Artificial Intelligence.

Documentation is hosted on our wiki: https://github.com/polyworld/polyworld/wiki

For installation instructions, please refer to the wiki page for your OS:

* [Linux Installation](https://github.com/polyworld/polyworld/wiki/Installing-on-Linux)
* [Mac Installation](https://github.com/polyworld/polyworld/wiki/Installing-on-Mac)

## Building on macOS (Apple Silicon or Intel)

The sources build against Qt 6 with Apple's clang. Using Homebrew:

```
brew install qt gsl libomp     # libomp is optional: enables OpenMP
./configure                    # finds qt/gsl/libomp, writes Makefile.conf
make
./Polyworld worldfiles/hello.wf         # GUI
./Polyworld --ui term worldfiles/hello.wf   # terminal UI
./Polyworld --StepsPerSecond 10 worldfiles/hello.wf   # cap the pace to 10 steps/s
```

Regression worldfiles for a quick check live in `worldfiles/tests/low-spec-pc/`.
See `docs/MODERNIZATION.md` for what changed to bring the tree to Qt 6 / macOS
arm64 and how it was verified.

Note that the Github repository at https://github.com/polyworld/polyworld is the official
home of the Polyworld project, which was formerly hosted at
[http://sourceforge.net/projects/polyworld](http://sourceforge.net/projects/polyworld).