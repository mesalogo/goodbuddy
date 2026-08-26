# LoongArch cross-compilation probe

This directory defines an isolated Ubuntu 26.04 amd64 environment for probing
GoodBuddy's Linux `loong64` prerequisites. It does not build Electron or
OpenCode.

The image includes:

- GCC and G++ targeting `loongarch64-linux-gnu`
- A LoongArch glibc development sysroot
- QEMU user-mode execution
- CMake and Ninja
- Rust's `loongarch64-unknown-linux-gnu` target
- Node.js, npm, and node-gyp

The probe validates:

- C, C++, CMake, and Rust LoongArch ELF output
- C, C++, and Rust execution through QEMU
- A minimal NAPI-RS Rust addon cross-build
- A Debian package with `Architecture: loong64`
- Koffi 3.1.4's published LoongArch glibc binding and the absence of a musl
  binding
- The current npm availability of an `@napi-rs/canvas` LoongArch package
- A source cross-build of node-pty 1.1.0

The node-pty probe uses its upstream node-gyp 11.4.2 dependency. Ubuntu's
distribution node-gyp unconditionally links Linux addons with `-lnode`, which
is appropriate for Ubuntu's shared Node.js package but not for Electron native
addons.

Build and run it from this directory on an amd64 Docker host:

```sh
docker build \
  --tag goodbuddy-loongarch-cross:ubuntu-26.04 \
  .

mkdir -p results
docker run --rm \
  --volume "$PWD/results:/results" \
  goodbuddy-loongarch-cross:ubuntu-26.04
```

Each run writes to a new UTC timestamped directory below `results`. A passing
run contains `summary.txt`, `SHA256SUMS`, the generated ELF files, and the
probe DEB.

QEMU only checks user-mode execution against the cross sysroot. Native Electron
loading, PTY behavior, desktop integration, GPU, audio, and packaging must
still be validated on a real Debian `loong64` host.

Koffi 3.1.4 currently publishes only `linux_loong64/koffi.node`, not a
`musl_loong64` binding. That is sufficient for a Debian desktop package but
does not satisfy GoodBuddy Agent's current dual-glibc/musl bundle contract.

The NAPI-RS probe confirms that a Rust Node addon can be cross-compiled. It
does not build Canvas itself, whose Skia dependency requires a separate port
and native validation.

## Experimental desktop preview

`prepare-input.cjs` creates the architecture-neutral GoodBuddy input archive.
`preview-deb.sh` combines it with the verified community Electron 42.3.0
LoongArch shell and produces an isolated `goodbuddy-loongarch-preview` DEB.

The preview:

- uses a separate application name and user-data directory;
- includes the direct model path and Continue runtime;
- cross-builds the input lockfile's node-pty version against Electron 42.3.0;
- includes Koffi's LoongArch glibc binding;
- does not include GoodBuddy Agent, Remote Runtime, OpenCode, or native Canvas;
- is not part of the production release matrix.

See
[`docs/development/loongarch-preview-build.md`](../../docs/development/loongarch-preview-build.md)
for the complete build and validation procedure.
