#!/bin/bash
# Package a fixture executable and exercise failures without touching the real product builds.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
root="$tmp/project"
app="$root/dist/Headroom Viewer.app"
mkdir -p "$root"/{tools,assets/macos,web} "$app" "$tmp/bin" "$tmp/products"
cp "$repo/tools/build-macos.sh" "$root/tools/"
cp "$repo/assets/macos/AppIcon.icns" "$root/assets/macos/"
cp /usr/bin/true "$tmp/products/HeadroomViewer"
echo 'viewer fixture' > "$root/web/index.html"
echo old > "$app/version"
export PATH="$tmp/bin:$PATH" PRODUCTS="$tmp/products" HEADROOM_BUILD=1 HEADROOM_SIGN_IDENTITY=-
cat > "$tmp/bin/swift" <<'STUB'
#!/bin/bash
case " $* " in
  *' --show-bin-path '*) echo "$PRODUCTS" ;;
  *) [[ "${FAIL_AT:-}" != compile ]] ;;
esac
STUB
cat > "$tmp/bin/codesign" <<'STUB'
#!/bin/bash
if [[ "${FAIL_AT:-}" == sign ]]; then exit 1; fi
exec /usr/bin/codesign "$@"
STUB
chmod +x "$tmp/bin/"*
for phase in compile sign; do
  if FAIL_AT="$phase" bash "$root/tools/build-macos.sh" --only viewer; then exit 1; fi
  [[ "$(cat "$app/version")" == old ]]
  [[ "$(ls -A "$root/dist")" == 'Headroom Viewer.app' ]]
done
bash "$root/tools/build-macos.sh" --only viewer
/usr/bin/codesign --verify --strict "$app"
cmp "$root/web/index.html" "$app/Contents/Resources/client/index.html"
[[ ! -e "$app/version" && "$(ls -A "$root/dist")" == 'Headroom Viewer.app' ]]
