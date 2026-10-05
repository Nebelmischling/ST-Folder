#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Read-only deep dive, part 3: does an existing extension already provide
# character folders/grouping, and how do they touch the character panel?
# Writes nothing, needs no sudo.
# ---------------------------------------------------------------------------
set -u
ST="${ST_PATH:-$HOME/SillyTavern}"
DATA="$ST/data/default-user"
EXT="$DATA/extensions"
hr() { printf '\n===== %s =====\n' "$1"; }

hr "NemoPresetExt — structure"
NE="$EXT/NemoPresetExt"
if [ -d "$NE" ]; then
    echo "size: $(du -sh "$NE" 2>/dev/null | cut -f1)"
    echo "--- top-level ---"; ls -1 "$NE" | head -n 20
    echo "--- features ---"; ls -1 "$NE/features" 2>/dev/null | head -n 30
    echo "--- character-manager files ---"; ls -la "$NE/features/character-manager" 2>/dev/null
else
    echo "(not found)"
fi

hr "NemoPresetExt character-manager — does it do folders/groups?"
CM="$NE/features/character-manager/character-manager.js"
if [ -f "$CM" ]; then
    echo "lines: $(wc -l < "$CM")"
    echo "--- header comment (first 40 lines) ---"
    head -n 40 "$CM"
    echo "--- keyword counts ---"
    for kw in folder Folder group Group category collection tag Tag drag drop sort grid modal list panel character_select rm_characters_block MutationObserver; do
        c=$(grep -o "$kw" "$CM" 2>/dev/null | wc -l | tr -d ' ')
        [ "$c" != "0" ] && printf '  %-20s %s\n' "$kw" "$c"
    done
    echo "--- injection / DOM hooks ---"
    grep -nE "rm_print_characters_block|rm_characters_block|insertAdjacent|appendChild|prepend|innerHTML|MutationObserver|addEventListener\('click'|querySelector" "$CM" 2>/dev/null | head -n 25
fi

hr "NemoPresetExt — what else it does (feature list + manifest)"
sed -n '1,40p' "$NE/manifest.json" 2>/dev/null
echo "--- feature folders and their entry points ---"
for f in "$NE/features"/*/; do
    [ -d "$f" ] || continue
    printf '  %-28s %s\n' "$(basename "$f")" "$(ls -1 "$f" | head -n 4 | tr '\n' ' ')"
done
echo "--- does NemoPresetExt add a character-panel tab/button? ---"
grep -rnE "rm_buttons_container|extensionsMenu|rm_button_characters|OPTION|character_management" "$NE" --include='*.js' 2>/dev/null | head -n 15

hr "Character Library — how it presents itself"
CL="$EXT/SillyTavern-CharacterLibrary"
if [ -d "$CL" ]; then
    echo "--- entry / UI mechanism ---"
    grep -nE "OPEN_CHARACTER_LIBRARY|openCharacterLibrary|rm_buttons_container|extensionsMenu|createElement\('button'|appendChild|MOVABLE|movingDivs|popup" "$CL/index.js" 2>/dev/null | head -n 20
    echo "--- character list interaction at line 1685 (context) ---"
    sed -n '1675,1700p' "$CL/index.js"
    echo "--- modules / app directories ---"
    ls -1 "$CL/app" 2>/dev/null | head -n 12
    ls -1 "$CL/modules" 2>/dev/null | head -n 12
    echo "--- does it store its own character grouping? ---"
    for kw in folderId collectionId groupId characterGroup sortOrder; do
        c=$(grep -rho "$kw" "$CL" --include='*.js' 2>/dev/null | wc -l | tr -d ' ')
        printf '  %-16s %s\n' "$kw" "$c"
    done
fi

hr "MOONLIT ECHOES THEME — character panel tweak"
grep -n -A3 -B3 "rm_print_characters_block" "$EXT/SillyTavern-MoonlitEchoesTheme/src/config/theme-settings.js" 2>/dev/null | head -n 20

hr "CHARACTER FILE TYPES (data/default-user/characters)"
find "$DATA/characters" -maxdepth 1 -type f 2>/dev/null | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -n 10
echo "total entries: $(find "$DATA/characters" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l | tr -d ' ')"
echo "--- names containing spaces (first 8) ---"
find "$DATA/characters" -maxdepth 1 -type f -name '* *' 2>/dev/null | head -n 8 | sed 's/^/  /'
echo "--- names with special chars (quotes, &) ---"
find "$DATA/characters" -maxdepth 1 -type f 2>/dev/null | grep -E "['\"&]" | head -n 8 | sed 's/^/  /'

hr "EXTENSION_SETTINGS — relevant keys for my extension"
node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const es=s.extension_settings||{};
console.log("character-folders already present?", Object.prototype.hasOwnProperty.call(es,"character-folders"));
console.log("gallery.folders entries:", Object.keys(es.gallery?.folders||{}).length);
console.log("NemoPresetExt settings keys:", Object.keys(es.NemoPresetExt||{}).slice(0,20).join(", ")||"(none)");
console.log("CharacterLibrary-ish keys:", Object.keys(es).filter(k=>/librar|galler|innkeep/i.test(k)).join(", ")||"(none)");
console.log("power_user.aux_field:", s.power_user?.aux_field, "| charListGrid:", s.power_user?.charListGrid, "| bogus_folders:", s.power_user?.bogus_folders);
console.log("fuzzy_search:", s.power_user?.fuzzy_search, "| sort_order:", s.power_user?.sort_order, s.power_user?.sort_field);
' "$DATA/settings.json" 2>&1

hr "DONE (deep dive 3) — nothing was modified"
