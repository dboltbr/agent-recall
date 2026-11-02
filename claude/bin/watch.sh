#!/bin/sh
# agent-recall watcher for one Claude Code process, started by the plugin's asyncRewake hooks.
# `rearm` (PostToolUse) skips node when this process already has a live watcher: it runs after
# every tool call. Nothing here may print to stdout.
state="$HOME/.local/state/agent-recall/claude"
if [ "$1" = rearm ] && [ -n "$CLAUDE_PID" ] && [ -f "$state/armed/$CLAUDE_PID/holder" ]; then
  holder=$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$state/armed/$CLAUDE_PID/holder")
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    exit 0
  fi
fi
# Claude Desktop starts hooks with a short PATH (on macOS without /opt/homebrew/bin). The watcher
# and what it runs (node, gh, git, claude) look in the usual install places too, after the PATH
# Claude Code gave.
PATH="${PATH:+$PATH:}$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH
script="$(dirname "$0")/../dist/watch.mjs"
# First node >= 20 (the bundle's target) along that PATH; an older one is skipped.
try_node() {
  if [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
    exec "$1" "$script"
  fi
}
oldifs=$IFS
IFS=:
for dir in $PATH; do
  IFS=$oldifs
  [ -n "$dir" ] && try_node "$dir/node"
done
IFS=$oldifs
mkdir -p "$state" && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $$ error nenhum node >= 20 encontrado" >>"$state/watch.log"
exit 0
