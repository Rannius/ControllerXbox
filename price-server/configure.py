"""Interactive, local-only configuration. Secrets never enter command arguments."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("domain")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*\.duckdns\.org", args.domain):
        raise SystemExit("Érvénytelen DuckDNS cím.")
    target = Path("/etc/deck-price-server/config.json")
    previous = json.loads(target.read_text()) if target.exists() else {}
    print("A kulcsokat csak ezen a gépen tároljuk. Üres mező: korábbi érték megtartása.")
    duck = getpass.getpass("DuckDNS-token (ha a router frissíti a címet, üresen hagyható): ").strip()
    gg = getpass.getpass("GG.deals API-kulcs (AllKeyShophoz nem szükséges): ").strip()
    if duck and not re.fullmatch(r"[A-Za-z0-9_-]{10,200}", duck):
        raise SystemExit("Érvénytelen DuckDNS-token.")
    if gg and not re.fullmatch(r"[A-Za-z0-9_-]{16,200}", gg):
        raise SystemExit("Érvénytelen GG.deals-kulcs.")
    value = {"domain": args.domain, "api_token": previous.get("api_token") or secrets.token_urlsafe(32),
             "gg_api_key": gg or previous.get("gg_api_key", ""),
             "duckdns_token": duck or previous.get("duckdns_token", ""),
             "data_directory": "/var/lib/deck-price-server"}
    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix="config-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("\nDecky szervercím: https://" + args.domain)
    print("Decky szervertoken: " + value["api_token"])
    print("Ezt a szervertokent másold a Deckybe, ne a DuckDNS-tokenedet.")


if __name__ == "__main__":
    main()
