#!/usr/bin/env bash
# Runs inside the t3-local-linux-build image with the checkout at /src; follows the CLI archive steps
# of release-desktop.yml for the container's own architecture.
set -euo pipefail
version="$1" out="$2"
case "$(uname -m)" in
  aarch64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "Unsupported architecture $(uname -m)." >&2; exit 1 ;;
esac
cd /src
vp i
node scripts/update-release-package-versions.ts "$version"
vp run --filter t3 build
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
mkdir -p "/tmp/resource-monitor/linux-$arch"
cp native/resource-monitor/target/release/t3-resource-monitor "/tmp/resource-monitor/linux-$arch/"
node apps/server/scripts/cli.ts build-exe
rm -rf "$out"
node scripts/build-cli-archive.ts --platform linux --arch "$arch" --version "$version" \
  --resource-monitor-dir /tmp/resource-monitor --output-dir "$out"
# The remote installer trusts any archive whose t3 runs, so check the stamp here.
mkdir -p /tmp/verify
tar -xzf "$out/t3-$version-linux-$arch.tar.gz" -C /tmp/verify --strip-components=1
reported="$(/tmp/verify/t3 --version)"
if [[ "$reported" != *"$version"* ]]; then
  echo "Built t3 reports '$reported', expected '$version'." >&2
  exit 1
fi
