#!/usr/bin/env python3
"""Live board viewer for the polyworld-web Kanban board.

Serves tools/board.html plus /board.json, which mirrors the output of
`hermes kanban --board polyworld-web ls`. Poll-based, no dependencies,
no schema coupling to kanban.db (it shells the supported CLI verb).

Usage: python3 tools/board_server.py [--board SLUG] [--port N]
"""
import argparse
import json
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAGE = HERE / "board.html"
CACHE = {"at": 0.0, "rows": [], "raw": ""}


def parse_rows(text):
    rows = []
    for line in text.splitlines():
        line = line.rstrip()
        if not line.strip() or line.startswith("Board:"):
            continue
        parts = line.split(None, 4)
        if len(parts) >= 5 and parts[1].startswith("t_"):
            rows.append({"mark": parts[0], "id": parts[1], "status": parts[2],
                         "assignee": parts[3], "title": parts[4]})
        elif len(parts) >= 4 and parts[0].startswith("t_"):
            rows.append({"mark": "·", "id": parts[0], "status": parts[1],
                         "assignee": parts[2], "title": " ".join(parts[3:])})
    return rows


def snapshot(board, max_age=3.0):
    if time.time() - CACHE["at"] < max_age:
        return CACHE
    out = subprocess.run(["hermes", "kanban", "--board", board, "ls"],
                         capture_output=True, text=True, timeout=30)
    text = out.stdout + out.stderr
    CACHE.update({"at": time.time(), "rows": parse_rows(text), "raw": text})
    return CACHE


class Handler(BaseHTTPRequestHandler):
    board = "polyworld-web"

    def _send(self, code, body, ctype):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/board.json"):
            snap = snapshot(self.board)
            self._send(200, json.dumps({"rows": snap["rows"], "raw": snap["raw"],
                                        "at": snap["at"]}), "application/json")
        elif self.path in ("/", "/index.html"):
            self._send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
        else:
            self._send(404, "not found", "text/plain")

    def log_message(self, *args):  # keep the console quiet
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--board", default="polyworld-web")
    ap.add_argument("--port", type=int, default=8791)
    a = ap.parse_args()
    Handler.board = a.board
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print("board viewer on http://127.0.0.1:%d  (board=%s)" % (a.port, a.board), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
