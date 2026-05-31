"""Diagnose the MICDROP_APP_USER login failure.

Connects as your admin user (browser SSO) and reports whether the service user
exists, whether it has a password set, whether it's disabled, and whether an
authentication policy is restricting password sign-in. Run:

    cd backend && .venv/bin/python data/schema/diag_snowflake.py
"""
import snowflake.connector as sf

ACCOUNT, USER, ROLE = "DSCHNEF-SC01129", "JUSTIN", "ACCOUNTADMIN"


def main() -> None:
    conn = sf.connect(account=ACCOUNT, user=USER, authenticator="externalbrowser", role=ROLE)
    cur = conn.cursor()
    try:
        print("=== SHOW USERS LIKE 'MICDROP_APP_USER' ===")
        cur.execute("SHOW USERS LIKE 'MICDROP_APP_USER'")
        cols = [c[0] for c in cur.description]
        rows = cur.fetchall()
        if not rows:
            print("  ❌ user does NOT exist — bootstrap.sql did not run/create it.")
        for r in rows:
            d = dict(zip(cols, r))
            for k in ("name", "disabled", "has_password", "has_rsa_public_key",
                      "default_role", "default_warehouse", "owner"):
                if k in d:
                    print(f"  {k} = {d[k]}")

        print("\n=== objects present ===")
        for obj, q in [
            ("warehouse MICDROP_WH", "SHOW WAREHOUSES LIKE 'MICDROP_WH'"),
            ("database MICDROP", "SHOW DATABASES LIKE 'MICDROP'"),
            ("role MICDROP_APP", "SHOW ROLES LIKE 'MICDROP_APP'"),
            ("table MICDROP.PUBLIC.SONGS", "SHOW TABLES LIKE 'SONGS' IN SCHEMA MICDROP.PUBLIC"),
            ("table MICDROP.PUBLIC.MATCHES", "SHOW TABLES LIKE 'MATCHES' IN SCHEMA MICDROP.PUBLIC"),
        ]:
            try:
                cur.execute(q)
                print(f"  {obj}: {'present' if cur.fetchall() else 'MISSING'}")
            except Exception as e:
                print(f"  {obj}: error {str(e)[:80]}")

        print("\n=== authentication policies (password auth may be blocked here) ===")
        try:
            cur.execute("SHOW AUTHENTICATION POLICIES IN ACCOUNT")
            pol = cur.fetchall()
            print(f"  account authentication policies: {len(pol)}")
            for r in pol:
                print(f"    - {r[1] if len(r) > 1 else r}")
        except Exception as e:
            print(f"  (could not list policies: {str(e)[:80]})")
    finally:
        cur.close(); conn.close()


if __name__ == "__main__":
    main()
