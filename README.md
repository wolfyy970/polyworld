<div align="center">

# Polyworld — now in your browser, byte-for-byte

**The artificial-life system, modernized for current macOS and re-implemented in TypeScript + Three.js — graded file-for-file against the original C++ build.**

[▶ Watch the 30-second tour](https://github.com/wolfyy970/polyworld/blob/master/web/docs/media/polyworld-ports.mp4) · [The port →](web/README.md) · [What changed on macOS →](docs/MODERNIZATION.md)

![The original C++ build (left) and the browser port (right) — same world, matched camera](web/docs/media/visual-parity-minitest_voff.png)

*Left: native C++ build. Right: browser port. Same scenario, same camera — and the run trees are byte-identical.*

![The 30-second tour, playing](web/docs/media/teaser.gif)

*The tour, in motion — native build → browser build → the parity result (the full video is linked above and lives in [`web/docs/media/`](web/docs/media/)).*

</div>

> **This fork** (`wolfyy970/polyworld`) adds:
> - a **modern macOS build** — Qt 6, Apple Silicon, Homebrew toolchain (`docs/MODERNIZATION.md`)
> - a **byte-exact browser port** — the full simulation in TypeScript + Three.js, in [`web/`](web/README.md)
>
> *The original README follows.*

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