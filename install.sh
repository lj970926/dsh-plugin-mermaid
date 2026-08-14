#!/usr/bin/env bash
# Install dsh-plugin-mermaid into the DSH web profile.
#
# Usage:
#   tools/dsh-plugin-mermaid/install.sh
#
# What it does:
#   1. Copies this folder into $DSH_HOME/profiles/web/node_modules/dsh-plugin-mermaid
#   2. Appends an `insert` entry for it in the web profile's cordis.patch.yml
#      (idempotent — re-running will not duplicate).
#   3. Tells you to restart `dsh web`.
set -euo pipefail

PLUGIN_NAME="dsh-plugin-mermaid"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
TARGET_DIR="$PROFILE_DIR/node_modules/$PLUGIN_NAME"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$PROFILE_DIR" ]]; then
  echo "error: web profile not found at $PROFILE_DIR" >&2
  echo "       Run 'dsh web' once to auto-initialize the profile, then retry." >&2
  exit 1
fi

echo "→ Copying plugin to $TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp -R "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/lib" "$SCRIPT_DIR/cordis.patch.yml" "$TARGET_DIR/"

# DSH requires this user patch file to parse as a top-level YAML array. A
# comment-only file (for example, after manually deleting a previous entry) is
# invalid, so normalize a missing/empty/comment-only file to [] before editing.
if [[ ! -f "$PATCH_FILE" ]] || ! grep -Eqv '^[[:space:]]*(#|$)' "$PATCH_FILE"; then
  printf '[]\n' > "$PATCH_FILE"
fi

if grep -q "id: $PLUGIN_NAME" "$PATCH_FILE"; then
  echo "→ Patch entry already present in $PATCH_FILE (skipping)"
elif [[ "$(tr -d '[:space:]' < "$PATCH_FILE")" == "[]" ]]; then
  # The default flow-sequence form cannot coexist with block entries appended
  # below, so replace it with the first block entry.
  echo "→ Adding entry to $PATCH_FILE"
  cat > "$PATCH_FILE" <<EOF
# Added by $PLUGIN_NAME/install.sh
- insert:
    - id: $PLUGIN_NAME
      name: $PLUGIN_NAME
EOF
else
  echo "→ Adding entry to $PATCH_FILE"
  printf '\n' >> "$PATCH_FILE"
  cat >> "$PATCH_FILE" <<EOF
# Added by $PLUGIN_NAME/install.sh
- insert:
    - id: $PLUGIN_NAME
      name: $PLUGIN_NAME
EOF
fi

cat <<EOF

✓ Installed.

Next steps:
  1. Restart dsh web (stop the running process and run 'dsh web' again).
  2. Hard-refresh the browser (Cmd+Shift+R) so the new boot manifest loads.
  3. Any \`\`\`mermaid code block in a conversation will render with a
     "图表/源码" toggle in its banner.

To uninstall:
  - Remove the block from $PATCH_FILE
  - rm -rf $TARGET_DIR
  - Restart dsh web.
EOF
