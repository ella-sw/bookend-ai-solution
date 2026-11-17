"""Make a test login token for trying the API by hand on http://localhost:8000/docs.

It does what the browser does: Supabase anonymous sign-in. Each run makes a NEW
anonymous user (shown in Supabase → Authentication → Users) and prints its token,
which works for 1 hour.

Needs in .env:  SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (the browser key, not service_role)
Run:            uv run python scripts/dev_token.py
"""

import sys
from pathlib import Path

import httpx


def read_env() -> dict[str, str]:
    env = {}
    for line in (Path(__file__).resolve().parent.parent / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def main() -> None:
    env = read_env()
    url, key = env.get("SUPABASE_URL"), env.get("SUPABASE_PUBLISHABLE_KEY")
    if not url or not key:
        sys.exit("Put SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env first.")
    if "service_role" in key or key.startswith("sb_secret_"):
        sys.exit("That is a secret key. Use the publishable (browser) key.")

    r = httpx.post(f"{url.rstrip('/')}/auth/v1/signup", json={},
                   headers={"apikey": key, "Content-Type": "application/json"})
    if r.status_code != 200:
        sys.exit(f"Sign-in failed ({r.status_code}): {r.text}\n"
                 "Check Supabase → Authentication → Sign In / Providers → "
                 "'Allow anonymous sign-ins' is on.")
    data = r.json()
    print(f"user id : {data['user']['id']}")
    print("token   : (copy the line below into [Authorize] on /docs)\n")
    print(data["access_token"])


if __name__ == "__main__":
    main()
