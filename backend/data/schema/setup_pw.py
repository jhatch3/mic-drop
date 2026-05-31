"""One-time Snowflake bootstrap via PASSWORD auth (externalbrowser/SSO is broken
on this account — error 390190).

Runs the three schema files as ACCOUNTADMIN using your JUSTIN login password,
which is read from the SNOWFLAKE_ADMIN_PASSWORD env var so it's never written to
disk or pasted into chat. Run:

    cd backend
    SNOWFLAKE_ADMIN_PASSWORD='your-JUSTIN-password' .venv/bin/python data/schema/setup_pw.py

If JUSTIN is SSO-only (no password), this will also fail — in that case set a
password for JUSTIN in Snowsight first, or just run the SQL directly in Snowsight.
"""
import os
import sys
from pathlib import Path

import snowflake.connector as sf

ACCOUNT, USER, ROLE = "DSCHNEF-SC01129", "JUSTIN", "ACCOUNTADMIN"
HERE = Path(__file__).resolve().parent
FILES = ["bootstrap.sql", "songs.sql", "matches.sql"]


def main() -> None:
    pw = os.environ.get("SNOWFLAKE_ADMIN_PASSWORD")
    if not pw:
        print("Set SNOWFLAKE_ADMIN_PASSWORD env var with JUSTIN's password.", file=sys.stderr)
        sys.exit(2)
    print(f"Connecting to {ACCOUNT} as {USER} (password auth)…")
    conn = sf.connect(account=ACCOUNT, user=USER, password=pw, role=ROLE)
    try:
        for name in FILES:
            print(f"\n=== running {name} ===")
            for cur in conn.execute_string((HERE / name).read_text(), remove_comments=True):
                try:
                    cur.fetchall()
                except Exception:
                    pass
            print(f"  ✓ {name} applied")
        with conn.cursor() as cur:
            cur.execute("SHOW USERS LIKE 'MICDROP_APP_USER'")
            cols = [c[0] for c in cur.description]
            row = cur.fetchone()
            if row:
                d = dict(zip(cols, row))
                print(f"\nMICDROP_APP_USER: has_password={d.get('has_password')} "
                      f"disabled={d.get('disabled')} default_role={d.get('default_role')}")
        print("\n✅ Snowflake objects created. Tell Claude 'go' to upload songs + verify.")
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"\n❌ setup failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
