#!/bin/sh
set -e

# If the DB already has tables but no alembic_version table, it was
# bootstrapped by SQLAlchemy's create_all (pre-Alembic). Stamp it at the
# BASELINE revision (the create_all-equivalent initial migration), NOT head —
# stamping head would skip every later migration. After stamping the baseline,
# `alembic upgrade head` below applies 0002+ (e.g. creates work_logs).
python -c "
import os, subprocess
from sqlalchemy import inspect, create_engine
from alembic.config import Config
from alembic.script import ScriptDirectory
engine = create_engine(os.environ['DATABASE_URL'])
tables = inspect(engine).get_table_names()
if tables and 'alembic_version' not in tables:
    base = ScriptDirectory.from_config(Config('alembic.ini')).get_bases()[0]
    print(f'Pre-Alembic DB detected — stamping baseline {base}.', flush=True)
    subprocess.run(['alembic', 'stamp', base], check=True)
"

alembic upgrade head

# Run whatever server command was passed (prod CMD = uvicorn --workers 2;
# dev compose overrides with uvicorn --reload). Both get migrations first.
exec "$@"
