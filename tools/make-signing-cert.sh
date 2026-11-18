#!/bin/bash
# Creates Headroom's own code-signing certificate, once, so every release is signed by the same key:
#  - macOS keeps Screen Recording, Accessibility (and Little Snitch rules) across updates only when each new build
#    is signed by the same certificate (ad-hoc signatures change with every build);
#  - the apps install an update only when its checksum list is signed by this certificate.
#
#   tools/make-signing-cert.sh            run in the repository, with `gh` signed in as its owner
#   tools/make-signing-cert.sh --dry-run --out <dir>   make the files only (testing): no secrets, no backup
#
# It makes a self-signed certificate (free; it isn't an Apple Developer ID, so Gatekeeper still calls the apps
# "unidentified"), then:
#   1. saves the certificate and its key as two GitHub Actions secrets: MACOS_SIGN_P12 and MACOS_SIGN_PASSWORD
#      (the release workflow signs with them);
#   2. writes the public certificate to assets/headroom-signing.cer (commit it: the apps check updates with it);
#   3. keeps a backup in ~/Library/Application Support/Headroom/signing (losing it means one more permission
#      prompt and a manual install, nothing worse).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CER="$ROOT/assets/headroom-signing.cer"
DRY=0
OUT=""
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --out) OUT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
if [ "$DRY" = 0 ]; then
  command -v gh >/dev/null || { echo "The GitHub CLI is required: brew install gh, then gh auth login" >&2; exit 1; }
  if [ -f "$CER" ] && [ "$FORCE" = 0 ]; then
    echo "assets/headroom-signing.cer already exists: Headroom already has its certificate." >&2
    echo "A new one means one more permission prompt on every Mac and a manual install. Use --force if you mean it." >&2
    exit 1
  fi
  REPO="$(cd "$ROOT" && gh repo view --json nameWithOwner -q .nameWithOwner)"
  echo "Repository: $REPO"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
chmod 700 "$tmp"
cat > "$tmp/ext.cnf" <<'CNF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = Headroom
O = Headroom (self-signed)
[codesign]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF

# RSA 3072, valid 20 years. The key never leaves this temporary folder except inside the password-protected .p12.
openssl req -x509 -newkey rsa:3072 -sha256 -days 7300 -nodes -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
  -config "$tmp/ext.cnf" -extensions codesign 2>/dev/null
PASS="$(openssl rand -base64 33 | tr -d '/+=\n' | cut -c1-32)"
export PASS
# 3DES + SHA-1 MAC: the one .p12 flavour both macOS's keychain and OpenSSL 3 read without extra options.
openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "Headroom" -out "$tmp/signing.p12" \
  -passout env:PASS -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1
openssl x509 -in "$tmp/cert.pem" -outform DER -out "$tmp/headroom-signing.cer"
FP="$(openssl x509 -in "$tmp/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)"

if [ "$DRY" = 1 ]; then
  [ -n "$OUT" ] || { echo "--dry-run needs --out <dir>" >&2; exit 1; }
  mkdir -p "$OUT"
  cp "$tmp/signing.p12" "$tmp/headroom-signing.cer" "$tmp/key.pem" "$OUT/"
  printf '%s' "$PASS" > "$OUT/password.txt"
  chmod 600 "$OUT"/*
  echo "Dry run: wrote signing.p12, password.txt, key.pem and headroom-signing.cer to $OUT (SHA-256 $FP)"
  exit 0
fi

echo "Saving the certificate as GitHub secrets for $REPO…"
base64 < "$tmp/signing.p12" | tr -d '\n' | gh secret set MACOS_SIGN_P12 --repo "$REPO"
printf '%s' "$PASS" | gh secret set MACOS_SIGN_PASSWORD --repo "$REPO"

cp "$tmp/headroom-signing.cer" "$CER"

BACKUP="$HOME/Library/Application Support/Headroom/signing"
mkdir -p "$BACKUP" && chmod 700 "$BACKUP"
stamp="$(date +%Y%m%d-%H%M%S)"
cp "$tmp/signing.p12" "$BACKUP/headroom-signing-$stamp.p12"
printf '%s\n' "$PASS" > "$BACKUP/headroom-signing-$stamp.password.txt"
chmod 600 "$BACKUP"/*

cat <<EOF

Done. Headroom's signing certificate (SHA-256 $FP):
  - GitHub secrets MACOS_SIGN_P12 and MACOS_SIGN_PASSWORD are set on $REPO.
  - The public certificate is assets/headroom-signing.cer: commit and push it.
  - A backup is in $BACKUP (keep it, or move it to your password manager).

The next release is signed with it. Install that one by hand, allow Screen Recording and Accessibility one last
time, and from then on Headroom updates itself and keeps them.
EOF
