#!/usr/bin/env bash
# Start (or reuse) the local Postgres used by pytest on port 54329.
set -euo pipefail
NAME=rowflow-test-db
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    docker start "$NAME" >/dev/null
  else
    docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:16 >/dev/null
  fi
fi
until docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
echo "test database ready on localhost:54329"
