#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Read-only: do other installed extensions interfere with dragging character
# cards? Looks for mousedown / dragstart / pointer-events handling on
# .character_select and for CSS that disables selection or pointer events.
# ---------------------------------------------------------------------------
set -u
ST="${ST_PATH:-$HOME/SillyTavern}"
DATA="$ST/data/default-user"
EXT="$DATA/extensions"
hr() { printf '\n===== %s =====\n' "$1"; }

hr "JS handlers on character cards in OTHER extensions"
for ext in "$EXT"/*/; do
    [ -d "$ext" ] || continue
    name=$(basename "$ext")
    case "$name" in character-folders) continue ;; esac
    hits=$(grep -rn "character_select" "$ext" --include='*.js' 2>/dev/null | grep -E "mousedown|mouseup|dragstart|dragend|dragover|pointerdown|touchstart|addEventListener" | head -n 6)
    if [ -n "$hits" ]; then
        echo "--- $name ---"
        echo "$hits" | sed 's/^/    /'
    fi
done

hr "CSS: pointer-events / user-select on cards"
grep -rn -B2 -A2 "character_select" "$EXT" --include='*.css' 2>/dev/null | grep -E "pointer-events|user-select|-webkit-user-drag|touch-action" | head -n 20

hr "jQuery UI touch/drag availability in the running client"
grep -n "touch-punch\|jquery-ui.min.js" "$ST/public/index.html" | head -n 5

hr "How many characters would be listed at once (pagination default)"
node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
console.log("characters:", (fs.readdirSync(process.argv[2]).filter(f=>f.endsWith(".png"))).length);
console.log("charListGrid:", s.power_user?.charListGrid, "| per-page setting is client-side (accountStorage)");
console.log("existing folder assignments from my extension:", JSON.stringify(s.extension_settings?.["character-folders"]?.assignments ?? null));
console.log("folders created so far:", (s.extension_settings?.["character-folders"]?.folders ?? []).map(f=>f.name).join(", ")||"(none)");
' "$DATA/settings.json" "$DATA/characters" 2>&1

hr "DONE"
