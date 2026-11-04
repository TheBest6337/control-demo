#!/usr/bin/env bash
# Re-vendor the operator UI from a qitechgmbh/control checkout and re-apply the
# browser patches listed in ui-patches.md.
#
#   scripts/sync-ui.sh [path/to/control]   (default: ../control)
#
# Afterwards: npm test (catches protocol drift), npm run dev, check the pages,
# and update ui/UPSTREAM with the printed revision.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
control="$(cd "${1:-$here/../control}" && pwd)"
src="$control/electron"
dst="$here/ui"

[ -f "$src/src/App.tsx" ] || { echo "not a control checkout: $control" >&2; exit 1; }

rsync -a --delete \
  --exclude 'main.ts' \
  --exclude 'preload.ts' \
  --exclude 'browser-shim.ts' \
  --exclude 'tests/e2e/' \
  "$src/src/" "$dst/src/"
rsync -a --delete "$src/public/" "$dst/public/"
cp "$src/index.html" "$src/components.json" "$src/postcss.config.ts" "$src/tsconfig.json" "$dst/"

# 1. Electron main-process code (needs node:fs, child_process, electron)
rm -f "$dst/src/helpers/ipc/context-exposer.ts" \
      "$dst/src/helpers/ipc/listeners-register.ts" \
      "$dst"/src/helpers/ipc/*/*-listeners.ts \
      "$dst"/src/helpers/ipc/*/*-context.ts \
      "$dst/src/helpers/ipc/update/token-store.ts" \
      "$dst/src/helpers/ipc/export/removable-media.ts"
cat > "$dst/src/helpers/ipc/update/git-fetch-utils.ts" <<'EOF'
// control-demo: the original file runs git in the Electron main process.
// The browser build only needs the types.
export type GitRefInfo = {
  hash: string;
  name: string;
  date: string;
};

export type RepoImportResult = {
  tags: GitRefInfo[];
  commits: GitRefInfo[];
  branches: GitRefInfo[];
};
EOF

# 2. browser shim before the app
printf 'import "./browser-shim";\nimport "@/App";\n' > "$dst/src/renderer.ts"

# 3. same-origin backend, start page
patch_line() { # file, search (fixed string), replacement
  local file="$dst/src/$1"
  grep -qF -- "$2" "$file" || { echo "patch anchor not found in $1: $2" >&2; exit 1; }
  FROM="$2" TO="$3" perl -0pi -e 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$file"
}
patch_line client/useClient.tsx \
  'const baseUrl = "http://localhost:3001";' \
  'const baseUrl = window.location.origin; // control-demo: same-origin mock backend'
patch_line client/socketioStore.ts \
  'baseUrl: "http://localhost:3001",' \
  'baseUrl: window.location.origin, // control-demo: same-origin mock backend'
patch_line components/graph/excelExport/excelUtils.ts \
  'private baseUrl: string = "http://10.10.10.1:3001",' \
  'private baseUrl: string = window.location.origin, // control-demo'
patch_line routes/router.tsx \
  'initialEntries: ["/_sidebar/setup/ethercat"],' \
  'initialEntries: ["/_sidebar/setup/machines"], // control-demo: start on the machine list'

# 4. dependencies: start from control's lockfile so every UI package has exactly
#    the version production ships (newer lucide-react, for example, drops icons
#    the UI uses); npm adds only the mock server's own packages on top
cp "$src/package-lock.json" "$here/package-lock.json"
(cd "$here" && npm install --no-audit --no-fund)

rev="$(git -C "$control" rev-parse HEAD)"
echo "synced from $control @ $rev"
echo "$rev" > "$dst/UPSTREAM"
