#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 [major|minor|patch]

Defaults to patch if no argument is provided.
EOF
  exit 1
}

bump_type=${1:-patch}
if [[ "$bump_type" != "major" && "$bump_type" != "minor" && "$bump_type" != "patch" ]]; then
  usage
fi

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg_json="$root_dir/package.json"

current_version=$(node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(pkg.version);" "$pkg_json")
IFS='.' read -r major minor patch <<< "$current_version"
case "$bump_type" in
  major)
    major=$((major + 1))
    minor=0
    patch=0
    ;;
  minor)
    minor=$((minor + 1))
    patch=0
    ;;
  patch)
    patch=$((patch + 1))
    ;;
esac

new_version="$major.$minor.$patch"

node -e "const fs=require('fs'); const pkgPath=process.argv[1]; const newVersion=process.argv[2]; const pkg=JSON.parse(fs.readFileSync(pkgPath,'utf8')); pkg.version=newVersion; fs.writeFileSync(pkgPath, JSON.stringify(pkg,null,2)+'\n');" "$pkg_json" "$new_version"

echo "Bumped package.json version: $current_version -> $new_version"

# Keep package-lock.json in sync (lockfile v2: top-level "version";
# lockfile v3: top-level "version" + packages[""].version).
lock_json="$root_dir/package-lock.json"
if [[ -f "$lock_json" ]]; then
  node -e "
const fs=require('fs');
const lockPath=process.argv[1];
const newVersion=process.argv[2];
const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));
lock.version=newVersion;
if (lock.packages && lock.packages['']) {
  lock.packages[''].version=newVersion;
}
fs.writeFileSync(lockPath, JSON.stringify(lock,null,2)+'\n');
" "$lock_json" "$new_version"
  echo "Bumped package-lock.json version: $current_version -> $new_version"
fi

echo "Run 'npm publish' once you have committed the version bump."
