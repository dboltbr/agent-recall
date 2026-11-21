#!/bin/sh
# agent-recall status renderer for Claude Code CLI (`statusLine`) and `/agent-recall:release`.
PATH="${PATH:+$PATH:}$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH
script="$(dirname "$0")/../dist/status.mjs"
try_node() {
  if [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
    exec "$1" "$script" "$@"
  fi
}
oldifs=$IFS
IFS=:
for dir in $PATH; do
  IFS=$oldifs
  [ -n "$dir" ] && try_node "$dir/node" "$@"
done
IFS=$oldifs
exit 0
