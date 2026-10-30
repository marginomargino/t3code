#!/usr/bin/env bash
# Builds the Linux CLI archive for a local rebuild inside colima's docker and publishes it to
# <release-dir>/v<version>/, the layout the SSH remote runner downloads from (packages/ssh tunnel.ts).
# <release-dir> and its parent must sit inside a colima mount: the build checkout lives beside it
# and the VM reads the release through file://.
set -euo pipefail
repo="$1" commit="$2" version="$3" release_dir="$4"
checkout="$(dirname "$release_dir")/t3-linux-build"
script_dir="$(cd "$(dirname "$0")" && pwd)"
container=t3-local-linux-build

if [ ! -e "$checkout/.git" ]; then
  # A checkout deleted by hand stays registered and would block `worktree add`.
  git -C "$repo" worktree prune
  git -C "$repo" worktree add --detach "$checkout" "$commit"
fi
# An interrupted rebuild leaves its container running: the docker client's death does not stop it.
docker rm --force "$container" >/dev/null 2>&1 || true
# --force also drops the version stamps the previous build wrote into package.json files.
git -C "$checkout" checkout --detach --force "$commit"

node_version="$(node -p 'require(process.argv[1]).engines.node' "$checkout/package.json")"
vp_version="$(sed -nE 's/^  vite-plus: ([0-9][^ ]*)$/\1/p' "$checkout/pnpm-workspace.yaml")"
: "${vp_version:?vite-plus is not pinned in pnpm-workspace.yaml}"
image="t3-local-linux-build:node${node_version}-vp${vp_version}"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  # Pulls only public images, so an empty config sidesteps a credsStore helper that is not on PATH
  # (Docker Desktop's "desktop" after switching to colima); the host keeps the current context.
  docker_host="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
  docker_config="$(mktemp -d)"
  trap 'rm -rf "$docker_config"' EXIT
  printf '{}' >"$docker_config/config.json"
  DOCKER_HOST="$docker_host" docker --config "$docker_config" build \
    --build-arg NODE_VERSION="$node_version" --build-arg VITE_PLUS_VERSION="$vp_version" \
    -t "$image" -f "$script_dir/Dockerfile" "$script_dir"
fi

# The pnpm store lives in the checkout's node_modules, so only cargo needs a cache volume.
docker run --rm --init --name "$container" \
  -v "$checkout:/src" \
  -v t3-local-linux-cargo:/root/.cargo/registry \
  "$image" bash /src/scripts/local-rebuild/container-build.sh "$version" /src/release-cli

archive="$(cd "$checkout/release-cli" && ls "t3-$version-linux-"*.tar.gz)"
staging="$release_dir/.v$version.partial"
rm -rf "$staging"
mkdir -p "$staging"
cp "$checkout/release-cli/$archive" "$staging/"
(cd "$staging" && shasum -a 256 "$archive" >SHA256SUMS)
rm -rf "$release_dir/v$version"
mv "$staging" "$release_dir/v$version"
echo "Published $release_dir/v$version/$archive"
