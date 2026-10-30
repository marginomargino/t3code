# Linux toolchain for `build-linux-cli-archive.sh`: Vite+ (which brings Node and pnpm), Rust for the
# resource monitor, and the ldd/patchelf/libatomic that build-cli-archive.ts bundles on Linux.
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git libatomic1 patchelf python3 xz-utils \
  && rm -rf /var/lib/apt/lists/*

ARG VITE_PLUS_VERSION
ARG NODE_VERSION
ENV VP_HOME=/root/.vite-plus VP_NODE_MANAGER=yes
ENV PATH="/root/.vite-plus/bin:/root/.cargo/bin:${PATH}"
RUN curl -fsSL https://vite.plus | VP_VERSION="${VITE_PLUS_VERSION}" bash \
  && vp env use "${NODE_VERSION}"
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal

WORKDIR /src
