#!/usr/bin/env bash
# Serves Appa Music at http://127.0.0.1:8888/ (the address your API key restriction should allow).
cd "$(dirname "$0")"
echo "Open http://127.0.0.1:8888/"
exec python3 -m http.server 8888 --bind 127.0.0.1
