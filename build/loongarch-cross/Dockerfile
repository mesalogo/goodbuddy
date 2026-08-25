FROM ubuntu:26.04

ARG DEBIAN_FRONTEND=noninteractive
ARG RUST_TOOLCHAIN=1.93.1

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    binutils-loongarch64-linux-gnu \
    build-essential \
    ca-certificates \
    cmake \
    dpkg-dev \
    fakeroot \
    file \
    g++-loongarch64-linux-gnu \
    gcc-loongarch64-linux-gnu \
    libc6-dev-loong64-cross \
    make \
    ninja-build \
    node-gyp \
    nodejs \
    npm \
    pkg-config \
    python3 \
    qemu-user \
    rustup \
    tar \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN rustup set profile minimal \
  && rustup toolchain install "${RUST_TOOLCHAIN}" \
    --target loongarch64-unknown-linux-gnu

ENV CC=loongarch64-linux-gnu-gcc \
    CXX=loongarch64-linux-gnu-g++ \
    AR=loongarch64-linux-gnu-ar \
    RANLIB=loongarch64-linux-gnu-ranlib \
    STRIP=loongarch64-linux-gnu-strip \
    CARGO_BUILD_TARGET=loongarch64-unknown-linux-gnu \
    CARGO_TARGET_LOONGARCH64_UNKNOWN_LINUX_GNU_LINKER=loongarch64-linux-gnu-gcc \
    RUSTUP_TOOLCHAIN=${RUST_TOOLCHAIN}

COPY toolchain.cmake /opt/goodbuddy/loongarch64-toolchain.cmake
COPY probe.sh /usr/local/bin/goodbuddy-loongarch-cross-probe
COPY preview-deb.sh /usr/local/bin/goodbuddy-loongarch-preview-deb

RUN chmod 0755 \
  /usr/local/bin/goodbuddy-loongarch-cross-probe \
  /usr/local/bin/goodbuddy-loongarch-preview-deb

WORKDIR /work

ENTRYPOINT ["/usr/local/bin/goodbuddy-loongarch-cross-probe"]
