#!/usr/bin/env bash
set -euo pipefail
umask 027

if [[ ${EUID} -ne 0 ]]; then
  echo 'Futtatás: sudo bash install.sh sajat-szerver.duckdns.org' >&2
  exit 1
fi
domain=${1:-}
if [[ ! $domain =~ ^[a-z0-9][a-z0-9-]*\.duckdns\.org$ ]]; then
  echo 'Adj meg egy DuckDNS címet, például sajat-szerver.duckdns.org.' >&2
  exit 1
fi
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd -- "$script_directory"
if [[ ! -f SHA256SUMS || ! -f main.py ]]; then
  echo 'A GitHub Release DeckPriceServer csomagjából futtasd a telepítőt.' >&2
  exit 1
fi
sha256sum --check SHA256SUMS
apt-get update
apt-get install -y python3 ca-certificates caddy
if ! id deckpriceserver >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/deck-price-server --shell /usr/sbin/nologin deckpriceserver
fi
install -d -o root -g deckpriceserver -m 0750 /etc/deck-price-server
install -d -o deckpriceserver -g deckpriceserver -m 0750 /var/lib/deck-price-server
install -d -o root -g root -m 0755 /opt/deck-price-server
python3 configure.py "$domain"
chown root:deckpriceserver /etc/deck-price-server/config.json
chmod 0640 /etc/deck-price-server/config.json
systemctl stop deck-price-server.service 2>/dev/null || true
install -o root -g root -m 0644 server.py main.py package.json /opt/deck-price-server/

cat >/etc/systemd/system/deck-price-server.service <<'UNIT'
[Unit]
Description=Deck Play Badges private price cache
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=deckpriceserver
Group=deckpriceserver
WorkingDirectory=/opt/deck-price-server
ExecStart=/usr/bin/python3 /opt/deck-price-server/server.py
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/deck-price-server
UMask=0077
Environment=PYTHONDONTWRITEBYTECODE=1

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/deck-price-duckdns.service <<'UNIT'
[Unit]
Description=Deck price server DuckDNS address update
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=deckpriceserver
Group=deckpriceserver
ExecStart=/usr/bin/python3 /opt/deck-price-server/server.py --update-dns
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
Environment=PYTHONDONTWRITEBYTECODE=1
UNIT

cat >/etc/systemd/system/deck-price-duckdns.timer <<'UNIT'
[Unit]
Description=Refresh DuckDNS every five minutes

[Timer]
OnBootSec=30
OnUnitActiveSec=5min
RandomizedDelaySec=15

[Install]
WantedBy=timers.target
UNIT

if [[ ! -d /etc/caddy ]]; then
  install -d -o root -g root -m 0755 /etc/caddy
fi
backup_stamp=$(date +%Y%m%d%H%M%S)
if [[ -f /etc/caddy/deck-price-server.caddy ]]; then
  cp -- /etc/caddy/deck-price-server.caddy "/etc/caddy/deck-price-server.caddy.backup-${backup_stamp}"
fi
cat >/etc/caddy/deck-price-server.caddy <<CADDY
$domain {
    request_body {
        max_size 2KB
    }
    reverse_proxy 127.0.0.1:8765
}
CADDY
chmod 0644 /etc/caddy/deck-price-server.caddy
if [[ ! -f /etc/caddy/Caddyfile ]]; then
  install -o root -g root -m 0644 /dev/null /etc/caddy/Caddyfile
fi
cp -p -- /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup-${backup_stamp}"
if ! grep -Fxq 'import /etc/caddy/deck-price-server.caddy' /etc/caddy/Caddyfile; then
  printf '\nimport /etc/caddy/deck-price-server.caddy\n' >>/etc/caddy/Caddyfile
fi
if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
  cp -- "/etc/caddy/Caddyfile.backup-${backup_stamp}" /etc/caddy/Caddyfile
  if [[ -f "/etc/caddy/deck-price-server.caddy.backup-${backup_stamp}" ]]; then
    cp -- "/etc/caddy/deck-price-server.caddy.backup-${backup_stamp}" /etc/caddy/deck-price-server.caddy
  else
    rm -f -- /etc/caddy/deck-price-server.caddy
  fi
  echo 'A Caddy-konfiguráció ellenőrzése sikertelen; a korábbi konfigurációt visszaállítottam.' >&2
  exit 1
fi
systemctl daemon-reload
systemctl enable --now deck-price-server.service deck-price-duckdns.timer
if ! systemctl start deck-price-duckdns.service; then
  echo 'A DuckDNS-frissítés nem sikerült. Ellenőrizd a tokent és a hálózatot.' >&2
fi
systemctl enable caddy
if systemctl is-active --quiet caddy; then
  systemctl reload caddy
else
  systemctl start caddy
fi
systemctl is-active deck-price-server.service
echo
echo "Telepítve. Külső ellenőrzés: https://${domain}/health"
echo 'Router: TCP 80 → Ubuntu 80 és TCP 443 → Ubuntu 443. A 8765-öt ne továbbítsd.'
echo 'Aktív UFW esetén engedélyezd a 80/tcp és 443/tcp portokat. A telepítő nem módosítja a tűzfalat.'
echo 'A helyi szolgáltatás indulása még nem igazolja a külső HTTPS-elérést; próbáld ki mobilnetről is.'
