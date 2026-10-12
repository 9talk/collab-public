#!/bin/bash
# Ensures the local dev code-signing identity exists and is trusted.
#
# Why: ad-hoc signed apps (electron-builder `identity=null`) are pinned to
# their CDHash in macOS TCC. Every rebuild changes the CDHash, so macOS treats
# the reinstalled app as brand new and re-prompts for permissions (screen
# recording, etc.). Signing with a stable certificate changes the TCC
# designated requirement to "bundle id + certificate leaf hash", which does
# not change across rebuilds — permissions then survive reinstalls.
#
# Idempotent: exits 0 immediately if the identity is already usable.
set -euo pipefail

IDENTITY="Collaborator Local Dev"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "Dev signing identity '$IDENTITY' already available."
  exit 0
fi

if ! command -v security >/dev/null 2>&1; then
  echo "ERROR: 'security' not found — this script is macOS only." >&2
  exit 1
fi

echo "Creating self-signed code-signing identity '$IDENTITY'..."
CERT_DIR="$(mktemp -d /tmp/collab-dev-cert.XXXXXX)"
trap 'rm -rf "$CERT_DIR"' EXIT

cat > "$CERT_DIR/openssl.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext

[dn]
CN = Collaborator Local Dev

[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

# /usr/bin/openssl (LibreSSL): its PKCS#12/PEM output is importable by macOS
# `security`, unlike some Homebrew OpenSSL 3 builds.
/usr/bin/openssl req -x509 -newkey rsa:2048 -sha256 -days 7300 -nodes \
  -config "$CERT_DIR/openssl.cnf" \
  -keyout "$CERT_DIR/dev.key" -out "$CERT_DIR/dev.crt"

security import "$CERT_DIR/dev.key" -k "$KEYCHAIN" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security import "$CERT_DIR/dev.crt" -k "$KEYCHAIN" >/dev/null
security add-trusted-cert -r trustRoot -k "$KEYCHAIN" "$CERT_DIR/dev.crt"

if ! security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "ERROR: identity '$IDENTITY' is still not usable after import." >&2
  exit 1
fi

echo "Dev signing identity '$IDENTITY' created and trusted."
