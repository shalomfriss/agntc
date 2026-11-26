#!/usr/bin/env bash

set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

case "$(uname -s):$(uname -m)" in
	Darwin:arm64) arch=arm64 ;;
	Darwin:x86_64) arch=x64 ;;
	*) printf 'Run this packaging script on macOS.\n' >&2; exit 1 ;;
esac

node_version="$(tr -d '[:space:]' < .nvmrc)"
local_node="$root/.build-tools/node-v$node_version-darwin-$arch/bin"
if [[ -x "$local_node/node" ]]; then
	export PATH="$local_node:$PATH"
fi

export AGENTIC_DESKTOP_OUTPUT="$root/release"
npm run gulp -- "vscode-darwin-$arch"

app="$AGENTIC_DESKTOP_OUTPUT/VSCode-darwin-$arch/Agentic Workbench.app"
ln -s code "$app/Contents/Resources/app/bin/agentic-workbench"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
printf '\nBuilt %s\n' "$app"
