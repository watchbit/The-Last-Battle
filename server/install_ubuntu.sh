#!/bin/bash
# Run as root on the Ubuntu server:  bash install_ubuntu.sh
set -e
apt-get update && apt-get install -y nodejs curl unzip ufw openssl
id tlw >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin tlw
mkdir -p /opt/tlw && cp -r ./* /opt/tlw/ && mkdir -p /opt/tlw/data && chown -R tlw:tlw /opt/tlw && (cd /opt/tlw/data && [ -f cert.pem ] || openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 -subj /CN=tlw-server 2>/dev/null; chown tlw:tlw /opt/tlw/data/*; chmod 600 /opt/tlw/data/key.pem 2>/dev/null || true)
cp /opt/tlw/tlw.service /etc/systemd/system/tlw.service
systemctl daemon-reload && systemctl enable tlw && systemctl restart tlw
ufw allow 8080/tcp && ufw allow 8081/tcp && ufw allow 8082/tcp || true
echo "Done. Accounts (TLS): SERVER_IP:8082  Game gateway: SERVER_IP:8081"
node -v; systemctl --no-pager status tlw | head -5
