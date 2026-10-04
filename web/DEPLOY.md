# Deploying the browser build

The demo is a static Vite build: the contents of `dist/` served under a subpath (in the LAN
deployment this ran behind a TLS reverse proxy at `/polyworld/`).

**The one rule: build with the subpath baked in.**

```bash
npm run build:deploy      # = vite build --base=/polyworld/
```

A plain `npm run build` (default base `/`) overwrites `dist` with `/assets/…` references; served
under `/polyworld/` those 404, the page hangs on "booting worldfile…", and the site appears
broken until rebuilt with the flag above. After any rebuild, verify the served page loads and
that its asset URLs carry the subpath.

Local preview without a proxy — serve a parent directory containing a symlink named
`polyworld/` pointing at `dist/` (the app resolves its own `/polyworld/…` asset paths):

```bash
mkdir -p /tmp/serve && ln -sfn "$PWD/dist" /tmp/serve/polyworld
python3 -m http.server 8899 --directory /tmp/serve
# → http://localhost:8899/polyworld/
```
