#!/bin/sh
# Recria o banco local de testes e aplica as migrations.
set -e
PSQL="psql -h /tmp -p 54329 -U postgres -v ON_ERROR_STOP=1 -q"
DIR=$(dirname "$0")/..
$PSQL -d postgres -c "drop database if exists financas" -c "create database financas"
$PSQL -d financas -f $DIR/dev/supabase_shim.sql
for f in $DIR/supabase/migrations/*.sql; do $PSQL -d financas -f "$f"; done
echo "banco pronto"
