#!/usr/bin/env bash

set -euo pipefail

input_archive="${1:?missing GoodBuddy input archive}"
electron_archive="${2:?missing Electron loong64 archive}"
output_root="${3:-/preview-output}"

electron_version="42.3.0"
electron_sha256="92b0ca0c9c18ed90166918a4ac1970266c4fa967aee9277031b3b250b905526e"
koffi_version="3.1.4"
node_gyp_version="11.4.2"
preview_iteration="1"
application_directory="GoodBuddy-LoongArch-Preview"
executable_name="goodbuddy-loongarch-preview"

assert_file() {
  if ! test -f "$1"; then
    echo "missing required file: $1" >&2
    exit 1
  fi
}

assert_loongarch_elf() {
  local file_path="$1"
  assert_file "${file_path}"
  file "${file_path}"
  readelf -h "${file_path}" | grep -Eq \
    'Machine:[[:space:]]+(LoongArch|Loongson Loongarch)'
}

assert_file "${input_archive}"
assert_file "${electron_archive}"
mkdir -p "${output_root}"

actual_electron_sha256="$(
  sha256sum "${electron_archive}" | cut -d ' ' -f 1
)"
if test "${actual_electron_sha256}" != "${electron_sha256}"; then
  echo "Electron loong64 archive digest mismatch" >&2
  exit 1
fi

run_id="$(date -u +%Y%m%dT%H%M%SZ)"
work_root="${output_root}/.work-${run_id}"
input_root="${work_root}/input"
package_root="${work_root}/package"
application_root="${package_root}/opt/${application_directory}"
resources_root="${application_root}/resources"
app_root="${resources_root}/app"
artifact_root="${output_root}/${run_id}"

if test -e "${work_root}" || test -e "${artifact_root}"; then
  echo "refusing to reuse preview build directory" >&2
  exit 1
fi

cleanup() {
  rm -rf "${work_root}"
}
trap cleanup EXIT

mkdir -p "${input_root}" "${app_root}" "${artifact_root}"
tar -xzf "${input_archive}" -C "${input_root}"

project_version="$(
  node -p \
    "require('${input_root}/package.json').version"
)"
node_pty_version="$(
  node -p \
    "require('${input_root}/package-lock.json').packages['node_modules/node-pty'].version"
)"
preview_version="${project_version}-loong64-preview.${preview_iteration}"
deb_version="${project_version}~loong64preview${preview_iteration}"
artifact_name="GoodBuddy-${project_version}-linux-loong64-preview.deb"

echo "== extract verified Electron shell =="
python3 -m zipfile -e "${electron_archive}" "${application_root}"
assert_loongarch_elf "${application_root}/electron"
mv "${application_root}/electron" \
  "${application_root}/${executable_name}"
chmod 0755 "${application_root}/${executable_name}"
rm -f "${resources_root}/default_app.asar"
if test -f "${application_root}/chrome-sandbox"; then
  chmod 4755 "${application_root}/chrome-sandbox"
fi

echo "== install production JavaScript dependencies =="
cp "${input_root}/package.json" "${app_root}/package.json"
cp "${input_root}/package-lock.json" "${app_root}/package-lock.json"
(
  cd "${app_root}"
  npm ci \
    --ignore-scripts \
    --omit=dev \
    --cpu=loong64 \
    --os=linux
)

rm -rf \
  "${app_root}/node_modules/@esbuild" \
  "${app_root}/node_modules/@img" \
  "${app_root}/node_modules/@rollup"
find "${app_root}/node_modules/@koromix" \
  -mindepth 1 \
  -maxdepth 1 \
  -type d \
  -exec rm -rf -- {} + 2>/dev/null || true
find "${app_root}/node_modules/@napi-rs" \
  -mindepth 1 \
  -maxdepth 1 \
  -type d \
  -name 'canvas-*' \
  -exec rm -rf -- {} + 2>/dev/null || true

node - "${input_root}" "${app_root}/package.json" \
  "${preview_version}" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const [inputRoot, outputPath, version] = process.argv.slice(2)
const metadata = JSON.parse(
  readFileSync(`${inputRoot}/package.json`, 'utf8')
)
metadata.name = 'goodbuddy-loongarch-preview'
metadata.productName = 'GoodBuddy LoongArch Preview'
metadata.desktopName = 'GoodBuddy LoongArch Preview'
metadata.version = version
metadata.main = './out/main/index.js'
delete metadata.build
delete metadata.devDependencies
delete metadata.optionalDependencies
writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`)
NODE
rm -f "${app_root}/package-lock.json"

echo "== stage target Koffi binding =="
koffi_stage="${work_root}/koffi"
mkdir -p "${koffi_stage}"
koffi_pack_json="$(
  npm pack \
    "@koromix/koffi-linux-loong64@${koffi_version}" \
    --ignore-scripts \
    --json \
    --pack-destination "${koffi_stage}"
)"
koffi_archive="$(
  node -e \
    'const value=JSON.parse(process.argv[1]); process.stdout.write(value[0].filename)' \
    "${koffi_pack_json}"
)"
koffi_integrity="$(
  node -p \
    "require('${input_root}/package-lock.json').packages['node_modules/@koromix/koffi-linux-loong64'].integrity"
)"
node - "${koffi_stage}/${koffi_archive}" \
  "${koffi_integrity}" <<'NODE'
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const [filePath, integrity] = process.argv.slice(2)
const [algorithm, expected] = integrity.split('-', 2)
const actual = createHash(algorithm)
  .update(readFileSync(filePath))
  .digest('base64')
if (actual !== expected) {
  throw new Error('Koffi archive integrity mismatch')
}
NODE
koffi_target="${app_root}/node_modules/@koromix/koffi-linux-loong64"
mkdir -p "${koffi_target}"
tar \
  -xzf "${koffi_stage}/${koffi_archive}" \
  -C "${koffi_target}" \
  --strip-components 1
koffi_binding="${koffi_target}/linux_loong64/koffi.node"
assert_loongarch_elf "${koffi_binding}"

echo "== cross-build node-pty ${node_pty_version} for Electron ${electron_version} =="
node_gyp_root="${work_root}/node-gyp"
npm install \
  --ignore-scripts \
  --prefix "${node_gyp_root}" \
  "node-gyp@${node_gyp_version}"
node_pty_root="${app_root}/node_modules/node-pty"
test "$(
  node -p "require('${node_pty_root}/package.json').version"
)" = "${node_pty_version}"
rm -rf "${node_pty_root}/build" "${node_pty_root}/prebuilds"
(
  cd "${node_pty_root}"
  CC=loongarch64-linux-gnu-gcc \
  CXX=loongarch64-linux-gnu-g++ \
  npm_config_arch=loong64 \
  npm_config_target_arch=loong64 \
  npm_config_runtime=electron \
  npm_config_target="${electron_version}" \
  npm_config_disturl=https://electronjs.org/headers \
  "${node_gyp_root}/node_modules/.bin/node-gyp" rebuild \
    --arch=loong64
)
node_pty_binding="${node_pty_root}/build/Release/pty.node"
assert_loongarch_elf "${node_pty_binding}"

echo "== stage GoodBuddy application and architecture-neutral runtimes =="
cp -a "${input_root}/out" "${app_root}/out"
mkdir -p \
  "${resources_root}/licenses" \
  "${resources_root}/runtimes" \
  "${resources_root}/skills"
cp -a "${input_root}/resources/skills/." "${resources_root}/skills/"
cp "${input_root}/resources/release-notes.json" \
  "${resources_root}/release-notes.json"
cp "${input_root}/resources/agent-release-keys.json" \
  "${resources_root}/agent-release-keys.json"
cp "${input_root}/agent-runtime-lock.json" \
  "${resources_root}/agent-runtime-lock.json"
cp "${input_root}/remote-runtime-lock.json" \
  "${resources_root}/remote-runtime-lock.json"
cp "${input_root}/build/icon.png" "${resources_root}/icon.png"
cp "${input_root}/build/icon-tray.png" \
  "${resources_root}/tray-icon.png"
cp "${input_root}/LICENSE" \
  "${resources_root}/licenses/GoodBuddy-0BSD.txt"
mkdir -p "${resources_root}/runtimes/continue/dist"
cp "${input_root}/node_modules/@continuedev/cli/package.json" \
  "${resources_root}/runtimes/continue/package.json"
cp "${input_root}/node_modules/@continuedev/cli/dist/cn.js" \
  "${resources_root}/runtimes/continue/dist/cn.js"
cp "${input_root}/node_modules/@continuedev/cli/dist/index.js" \
  "${resources_root}/runtimes/continue/dist/index.js"
cp "${input_root}/node_modules/@continuedev/cli/dist/xhr-sync-worker.js" \
  "${resources_root}/runtimes/continue/dist/xhr-sync-worker.js"
cp -a "${input_root}/node_modules/npm" \
  "${resources_root}/runtimes/npm"

echo "== reject foreign native addons =="
while IFS= read -r -d '' native_addon; do
  assert_loongarch_elf "${native_addon}"
done < <(
  find "${app_root}/node_modules" \
    -type f \
    -name '*.node' \
    -print0
)

if test -e "${resources_root}/agents" ||
  test -e "${resources_root}/remote-runtimes" ||
  test -e "${resources_root}/runtimes/opencode"
then
  echo "preview package unexpectedly contains Agent or OpenCode payload" >&2
  exit 1
fi

echo "== build isolated preview DEB =="
mkdir -p \
  "${package_root}/DEBIAN" \
  "${package_root}/usr/bin" \
  "${package_root}/usr/share/applications" \
  "${package_root}/usr/share/icons/hicolor/512x512/apps"
ln -s \
  "/opt/${application_directory}/${executable_name}" \
  "${package_root}/usr/bin/${executable_name}"
cp "${input_root}/build/icon.png" \
  "${package_root}/usr/share/icons/hicolor/512x512/apps/${executable_name}.png"
cat > "${package_root}/usr/share/applications/${executable_name}.desktop" <<EOF
[Desktop Entry]
Name=GoodBuddy LoongArch Preview
Comment=GoodBuddy LoongArch 主体预览版
Exec=/opt/${application_directory}/${executable_name} %U
Terminal=false
Type=Application
Icon=${executable_name}
Categories=Utility;
StartupWMClass=GoodBuddy LoongArch Preview
EOF
cat > "${package_root}/DEBIAN/control" <<EOF
Package: goodbuddy-loongarch-preview
Version: ${deb_version}
Architecture: loong64
Maintainer: MesaLogo
Section: utils
Priority: optional
Depends: libasound2t64, libatspi2.0-0t64, libgbm1, libgtk-3-0t64, libnotify4, libnss3, libpulse0, libsecret-1-0, libuuid1, libxss1, libxtst6, xdg-utils
Description: GoodBuddy LoongArch desktop preview
 Experimental LoongArch desktop build without bundled Agent, Remote Runtime,
 OpenCode, or native Canvas image decoding.
EOF

artifact="${artifact_root}/${artifact_name}"
dpkg-deb --root-owner-group --build "${package_root}" "${artifact}"

echo "== verify preview package =="
test "$(dpkg-deb --field "${artifact}" Architecture)" = "loong64"
verify_root="${work_root}/verify"
mkdir "${verify_root}"
dpkg-deb --extract "${artifact}" "${verify_root}"
assert_loongarch_elf \
  "${verify_root}/opt/${application_directory}/${executable_name}"
assert_loongarch_elf \
  "${verify_root}/opt/${application_directory}/resources/app/${node_pty_binding#${app_root}/}"
assert_loongarch_elf \
  "${verify_root}/opt/${application_directory}/resources/app/${koffi_binding#${app_root}/}"

(
  cd "${artifact_root}"
  sha256sum "${artifact_name}" > SHA256SUMS
)
cat > "${artifact_root}/preview-manifest.json" <<EOF
{
  "formatVersion": 1,
  "product": "GoodBuddy LoongArch Preview",
  "goodBuddyVersion": "${project_version}",
  "previewVersion": "${preview_version}",
  "electronVersion": "${electron_version}",
  "architecture": "loong64",
  "artifact": "${artifact_name}",
  "bundledAgent": false,
  "bundledRemoteRuntime": false,
  "bundledOpenCode": false,
  "nativeCanvas": false,
  "continueRuntime": true,
  "nodePty": true,
  "koffiGlibc": true,
  "nativeLaunchVerified": false
}
EOF

cat "${artifact_root}/preview-manifest.json"
echo "artifact=${artifact}"
