"""One-time Snowflake bootstrap for Pitch Battle.

Connects as your admin user via browser SSO (externalbrowser) and runs the three
schema files (bootstrap → songs → matches) in order, creating the warehouse,
database, schema, the MICDROP_APP role + MICDROP_APP_USER service account, and the
songs/matches tables + views.

Run it ONCE (a browser window opens for you to approve the SSO login):

    cd backend && .venv/bin/python data/schema/setup_snowflake.py

After it succeeds, the backend connects as MICDROP_APP_USER (password auth, no
browser) using the SNOWFLAKE_* vars in .env.
"""
import sys
from pathlib import Path

import snowflake.connector as sf

# Matches the connection you pasted (JUSTIN / externalbrowser / ACCOUNTADMIN).
ACCOUNT = "DSCHNEF-SC01129"
USER = "JUSTIN"
ROLE = "ACCOUNTADMIN"

HERE = Path(__file__).resolve().parent
FILES = ["bootstrap.sql", "songs.sql", "matches.sql"]


def main() -> None:
    print(f"Connecting to {ACCOUNT} as {USER} (browser SSO will open)…")
    conn = sf.connect(
        account=ACCOUNT,
        user=USER,
        authenticator="externalbrowser",
        role=ROLE,
        client_session_keep_alive=True,
    )
    try:
        for name in FILES:
            sql = (HERE / name).read_text()
            print(f"\n=== running {name} ===")
            for cur in conn.execute_string(sql):
                # Drain results so each statement actually executes.
                try:
                    cur.fetchall()
                except Exception:
                    pass
            print(f"  ✓ {name} applied")
        print("\n✅ Snowflake objects created. "
              "Set SNOWFLAKE_* in .env (user=MICDROP_APP_USER) and upload songs.")
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"\n❌ setup failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
