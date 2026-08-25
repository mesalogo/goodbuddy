#!/usr/bin/env bash

set -euo pipefail

results_root="${1:-/results}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
results="${results_root}/${run_id}"
mkdir -p "${results}"

log="${results}/probe.log"
exec > >(tee "${log}") 2>&1

assert_loongarch_elf() {
  local file_path="$1"
  file "${file_path}"
  readelf -h "${file_path}" | grep -Eq \
    'Machine:[[:space:]]+(LoongArch|Loongson Loongarch)'
}

echo "== tool versions =="
loongarch64-linux-gnu-gcc --version | head -n 1
loongarch64-linux-gnu-g++ --version | head -n 1
loongarch64-linux-gnu-ld --version | head -n 1
qemu-loongarch64 --version | head -n 1
node --version
npm --version
node-gyp --version
rustc --version
cargo --version
cmake --version | head -n 1

echo "== C probe =="
cat > "${results}/hello.c" <<'EOF'
#include <stdio.h>

int main(void) {
  puts("goodbuddy-loongarch-c-ok");
  return 0;
}
EOF

loongarch64-linux-gnu-gcc \
  -O2 \
  -Wall \
  -Wextra \
  -Werror \
  "${results}/hello.c" \
  -o "${results}/hello-c"
assert_loongarch_elf "${results}/hello-c"
test "$(
  qemu-loongarch64 \
    -L /usr/loongarch64-linux-gnu \
    "${results}/hello-c"
)" = "goodbuddy-loongarch-c-ok"

echo "== C++ probe =="
cat > "${results}/hello.cpp" <<'EOF'
#include <iostream>
#include <string_view>

int main() {
  constexpr std::string_view message{"goodbuddy-loongarch-cpp-ok"};
  std::cout << message << '\n';
  return 0;
}
EOF

loongarch64-linux-gnu-g++ \
  -std=c++20 \
  -O2 \
  -Wall \
  -Wextra \
  -Werror \
  "${results}/hello.cpp" \
  -o "${results}/hello-cpp"
assert_loongarch_elf "${results}/hello-cpp"
test "$(
  qemu-loongarch64 \
    -L /usr/loongarch64-linux-gnu \
    "${results}/hello-cpp"
)" = "goodbuddy-loongarch-cpp-ok"

echo "== CMake probe =="
mkdir "${results}/cmake-source"
cat > "${results}/cmake-source/CMakeLists.txt" <<'EOF'
cmake_minimum_required(VERSION 3.20)
project(goodbuddy_loongarch_probe LANGUAGES C)
add_executable(goodbuddy-cmake-probe main.c)
target_compile_options(
  goodbuddy-cmake-probe
  PRIVATE -Wall -Wextra -Werror
)
EOF
cp "${results}/hello.c" "${results}/cmake-source/main.c"
cmake \
  -S "${results}/cmake-source" \
  -B "${results}/cmake-build" \
  -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE=/opt/goodbuddy/loongarch64-toolchain.cmake
cmake --build "${results}/cmake-build"
assert_loongarch_elf \
  "${results}/cmake-build/goodbuddy-cmake-probe"

echo "== Rust probe =="
mkdir -p "${results}/rust-probe/src"
cat > "${results}/rust-probe/Cargo.toml" <<'EOF'
[package]
name = "goodbuddy-loongarch-rust-probe"
version = "0.1.0"
edition = "2024"

[dependencies]
EOF
cat > "${results}/rust-probe/src/main.rs" <<'EOF'
fn main() {
    println!("goodbuddy-loongarch-rust-ok");
}
EOF
cargo build \
  --release \
  --manifest-path "${results}/rust-probe/Cargo.toml"
rust_binary="$(
  find "${results}/rust-probe/target" \
    -type f \
    -name goodbuddy-loongarch-rust-probe \
    -print \
    -quit
)"
test -n "${rust_binary}"
assert_loongarch_elf "${rust_binary}"
test "$(
  qemu-loongarch64 \
    -L /usr/loongarch64-linux-gnu \
    "${rust_binary}"
)" = "goodbuddy-loongarch-rust-ok"

echo "== NAPI-RS Rust addon probe =="
mkdir -p "${results}/napi-rs-probe/src"
cat > "${results}/napi-rs-probe/Cargo.toml" <<'EOF'
[package]
name = "goodbuddy-loongarch-napi-probe"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "3", default-features = false, features = ["napi8"] }
napi-derive = "3"

[build-dependencies]
napi-build = "2"
EOF
cat > "${results}/napi-rs-probe/build.rs" <<'EOF'
fn main() {
    napi_build::setup();
}
EOF
cat > "${results}/napi-rs-probe/src/lib.rs" <<'EOF'
use napi_derive::napi;

#[napi]
pub fn architecture_probe() -> &'static str {
    "loong64"
}
EOF
cargo build \
  --release \
  --manifest-path "${results}/napi-rs-probe/Cargo.toml"
napi_binding="$(
  find "${results}/napi-rs-probe/target" \
    -type f \
    -name 'libgoodbuddy_loongarch_napi_probe.so' \
    -print \
    -quit
)"
test -n "${napi_binding}"
assert_loongarch_elf "${napi_binding}"

echo "== Debian package probe =="
package_root="${results}/deb-root"
mkdir -p \
  "${package_root}/DEBIAN" \
  "${package_root}/usr/lib/goodbuddy-loongarch-probe"
cp "${results}/hello-c" \
  "${package_root}/usr/lib/goodbuddy-loongarch-probe/hello"
cat > "${package_root}/DEBIAN/control" <<'EOF'
Package: goodbuddy-loongarch-cross-probe
Version: 1.0.0
Architecture: loong64
Maintainer: MesaLogo
Description: GoodBuddy LoongArch cross-compilation probe
EOF
dpkg-deb --build \
  "${package_root}" \
  "${results}/goodbuddy-loongarch-cross-probe_1.0.0_loong64.deb"
test "$(
  dpkg-deb \
    --field \
    "${results}/goodbuddy-loongarch-cross-probe_1.0.0_loong64.deb" \
    Architecture
)" = "loong64"

echo "== Koffi prebuilt probe =="
mkdir "${results}/koffi"
npm pack \
  "@koromix/koffi-linux-loong64@3.1.4" \
  --ignore-scripts \
  --pack-destination "${results}/koffi"
koffi_archive="$(
  find "${results}/koffi" \
    -maxdepth 1 \
    -type f \
    -name '*.tgz' \
    -print \
    -quit
)"
test -n "${koffi_archive}"
mkdir "${results}/koffi/package"
tar \
  -xzf "${koffi_archive}" \
  -C "${results}/koffi/package" \
  --strip-components 1
koffi_binding="${results}/koffi/package/linux_loong64/koffi.node"
assert_loongarch_elf "${koffi_binding}"
if test -e "${results}/koffi/package/musl_loong64/koffi.node"; then
  echo "Unexpected Koffi musl binding is present"
  exit 1
fi
echo "Koffi loong64 currently provides a glibc binding only"

echo "== Canvas package availability probe =="
canvas_package_status=unavailable
if npm view \
  "@napi-rs/canvas-linux-loong64-gnu" \
  version \
  > "${results}/canvas-package-version.txt" \
  2> "${results}/canvas-package-error.txt"
then
  canvas_package_status=available
fi
echo "@napi-rs/canvas loong64 package: ${canvas_package_status}"

echo "== node-pty cross-build probe =="
mkdir "${results}/node-pty"
npm pack \
  "node-pty@1.1.0" \
  --ignore-scripts \
  --pack-destination "${results}/node-pty"
node_pty_archive="$(
  find "${results}/node-pty" \
    -maxdepth 1 \
    -type f \
    -name '*.tgz' \
    -print \
    -quit
)"
test -n "${node_pty_archive}"
mkdir "${results}/node-pty/package"
tar \
  -xzf "${node_pty_archive}" \
  -C "${results}/node-pty/package" \
  --strip-components 1
(
  cd "${results}/node-pty/package"
  npm install --ignore-scripts --omit=dev
  npm install \
    --ignore-scripts \
    --no-save \
    "node-gyp@11.4.2"
  CC=loongarch64-linux-gnu-gcc \
  CXX=loongarch64-linux-gnu-g++ \
  npm_config_arch=loong64 \
  npm_config_target_arch=loong64 \
  npm_config_runtime=electron \
  npm_config_target=43.2.0 \
  npm_config_disturl=https://electronjs.org/headers \
  ./node_modules/.bin/node-gyp rebuild \
    --arch=loong64
)
node_pty_binding="${results}/node-pty/package/build/Release/pty.node"
assert_loongarch_elf "${node_pty_binding}"

echo "== summary =="
sha256sum \
  "${results}/hello-c" \
  "${results}/hello-cpp" \
  "${rust_binary}" \
  "${napi_binding}" \
  "${results}/goodbuddy-loongarch-cross-probe_1.0.0_loong64.deb" \
  "${koffi_binding}" \
  "${node_pty_binding}" \
  > "${results}/SHA256SUMS"

cat > "${results}/summary.txt" <<EOF
result=pass
target=loong64
c=pass
cpp=pass
cmake=pass
rust=pass
napi_rs=pass
qemu=pass
deb=pass
koffi=pass
koffi_musl=unavailable
canvas_package=${canvas_package_status}
node_pty=pass
EOF

cat "${results}/summary.txt"
echo "results=${results}"
