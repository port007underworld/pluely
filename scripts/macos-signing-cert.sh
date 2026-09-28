#!/usr/bin/env bash
# Create a long-lived self-signed code-signing identity for macOS builds.
#
# macOS ties Screen Recording / Microphone / System Audio permission grants to the
# app's code signature. Unsigned (ad-hoc) builds get a new signature every build,
# so grants silently stop applying. Signing every build with the same certificate
# keeps them. No paid Apple Developer account is needed; builds are just not
# notarized (users confirm the first launch via right-click > Open).
#
# You normally don't run this yourself: `npm run tauri build` calls it on the
# first macOS build (see scripts/tauri.mjs) and signs every build afterwards.
#
# Usage:
#   scripts/macos-signing-cert.sh                  # create "Runningbord Dev" in the login keychain
#   scripts/macos-signing-cert.sh --export-ci DIR  # also keep DIR/signing.p12 + DIR/secrets.txt,
#                                                  # so CI can sign with the same certificate
#
# Env: CERT_NAME (default "Runningbord Dev"), KEYCHAIN (default login keychain).
set -euo pipefail

NAME="${CERT_NAME:-Runningbord Dev}"
KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
EXPORT_DIR=""
if [[ "${1:-}" == "--export-ci" ]]; then
  EXPORT_DIR="${2:?usage: --export-ci DIR}"
fi

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  if [[ -n "$EXPORT_DIR" && ! -f "$EXPORT_DIR/signing.p12" ]]; then
    # Creating a second certificate with the same name would make signing ambiguous.
    echo "\"$NAME\" already exists but wasn't exported when it was created." >&2
    echo "Delete it (security delete-certificate -c \"$NAME\") and rerun to create an exportable one;" >&2
    echo "your local builds will need permissions granted once more afterwards." >&2
    exit 1
  fi
  echo "Code-signing identity \"$NAME\" already exists; nothing to do."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cert.cnf" 2>/dev/null

PASSWORD="$(openssl rand -hex 16)"
LEGACY=""
# OpenSSL 3 defaults to PKCS#12 ciphers that macOS `security import` can't read.
if openssl version | grep -q "^OpenSSL 3"; then LEGACY="-legacy"; fi
openssl pkcs12 -export $LEGACY -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$NAME" -out "$TMP/signing.p12" -passout "pass:$PASSWORD"

# No trust settings needed: codesign accepts an untrusted self-signed identity,
# and the signature's designated requirement pins this exact certificate.
security import "$TMP/signing.p12" -k "$KEYCHAIN" -P "$PASSWORD" -T /usr/bin/codesign >/dev/null

echo "Created code-signing identity \"$NAME\" in $KEYCHAIN."

if [[ -n "$EXPORT_DIR" ]]; then
  mkdir -p "$EXPORT_DIR"
  cp "$TMP/signing.p12" "$EXPORT_DIR/signing.p12"
  {
    echo "Add these GitHub Actions secrets (Settings > Secrets and variables > Actions):"
    echo "APPLE_CERTIFICATE=$(base64 <"$TMP/signing.p12" | tr -d '\n')"
    echo "APPLE_CERTIFICATE_PASSWORD=$PASSWORD"
    echo "APPLE_SIGNING_IDENTITY=$NAME"
  } >"$EXPORT_DIR/secrets.txt"
  chmod 600 "$EXPORT_DIR/signing.p12" "$EXPORT_DIR/secrets.txt"
  echo "Wrote $EXPORT_DIR/signing.p12 and $EXPORT_DIR/secrets.txt. Keep them private and never rotate the"
  echo "certificate: a new one resets every user's macOS permissions once."
fi
