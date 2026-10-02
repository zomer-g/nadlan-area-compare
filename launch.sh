#!/bin/sh
# BOOT, as the non-root app user. The schema is created by server.js on start.
set -eu
exec node server.js
