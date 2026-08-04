#!/bin/sh
set -eu

# Provider receipts, quota ledgers and media task state may contain private
# operational metadata.  The host data directories are already 0700; keep every
# SQLite database, WAL, SHM and temporary file created by the unprivileged
# service process owner-only as a second boundary.
umask 077
exec "$@"
