#!/bin/sh
# BUILD time, as root: dependencies only (no env, no database here).
set -eu
npm install --omit=dev --no-audit --no-fund
