# Install Dependencies

Polyworld builds with Apple's clang against Qt 6, GSL, and (optionally) the
OpenMP runtime. The simplest way to get the libraries is
[Homebrew](https://brew.sh/).

## Install XCode command-line tools
If you already have XCode command-line tools installed, then typing `clang++` at the terminal should produce output like the following:
```
clang: error: no input files
```
If they aren't installed, then the `clang++` command should automagically initiate the installation for you.

## Install Qt 6
Polyworld renders through Qt 6 (`QOpenGLWidget`). Install it with Homebrew:
```
brew install qt
```
If you installed Qt via the Qt installer instead, make sure the Qt 6 `bin`
directory containing `qmake` is on your `PATH` — the build uses `qmake` to
generate the application's makefiles.

Then open a terminal and verify that typing `qmake --version` produces output like the following:
```
QMake version 3.1
Using Qt version 6.11.2 in /opt/homebrew/lib
```
(Any Qt 6.x version works; Qt 5 is no longer supported by the sources.)

## Install GSL
Install the GNU Scientific Library:
```
brew install gsl
```
The `configure` script locates it with `gsl-config` (or Homebrew's prefix) and
will tell you if it can't find it.

## Install the OpenMP runtime (optional)
On macOS, clang needs an out-of-tree OpenMP runtime:
```
brew install libomp
```
`configure` probes OpenMP support by building and running a small test. If
`libomp` is missing the build continues with OpenMP disabled (a message says
so) — everything still runs, just single-threaded.

## Python
The property/expression scripts in the worldfiles are evaluated by
`src/library/proplib/interpreter.py`, which Polyworld runs with `python3`.
macOS provides `python3` with the XCode command-line tools; no extra install
is needed.

# Perform POSIX Install Procedure

The OSX-specific install is now complete, so proceed to the
[POSIX installation procedure](./Installing-on-POSIX).
