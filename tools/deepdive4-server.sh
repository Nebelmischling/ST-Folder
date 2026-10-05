#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Read-only deep dive, part 4: exact feature set of the two existing
# character-management UIs (folders? nesting? drag&drop? persistence?).
# Writes nothing, needs no sudo.
# ---------------------------------------------------------------------------
set -u
ST="${ST_PATH:-$HOME/SillyTavern}"
DATA="$ST/data/default-user"
hr() { printf '\n===== %s =====\n' "$1"; }

NE="$DATA/extensions/NemoPresetExt/features/character-manager"

hr "NEMO character-manager-ui.html (popup markup)"
cat "$NE/character-manager-ui.html" 2>/dev/null

hr "NEMO character-manager-ui.js — header / docs"
head -n 45 "$NE/character-manager-ui.js" 2>/dev/null

hr "NEMO character-manager-ui.js — feature keywords"
for kw in parentId subfolder nested depth drag sortable localStorage saveMetadata createFolder renameFolder deleteFolder moveFolder count color icon search filter rootFolder; do
    c=$(grep -o "$kw" "$NE/character-manager-ui.js" 2>/dev/null | wc -l | tr -d ' ')
    printf '  %-16s %s\n' "$kw" "$c"
done

hr "NEMO character-manager-ui.js — concept of the data + main actions"
grep -nE "folders\[|\.parent|childFolders|rootFolders|folderId|characterFolder|metadata\.folders|metadata\.characters" "$NE/character-manager-ui.js" 2>/dev/null | head -n 25

hr "NEMO character-manager-ui.js — how folders are created/rendered"
grep -nE "function [a-zA-Z]*[Ff]older|function [a-zA-Z]*(render|create|rename|delete|move)[a-zA-Z]*\(|addEventListener\('(click|dblclick|contextmenu|dragstart|drop)'" "$NE/character-manager-ui.js" 2>/dev/null | head -n 30

hr "NEMO dom-cache.js — what it caches/observes"
head -n 30 "$NE/dom-cache.js" 2>/dev/null
grep -nE "MutationObserver|observe\(|class |export" "$NE/dom-cache.js" 2>/dev/null | head -n 15

hr "NEMO — is the character manager feature enabled?"
grep -rnE "character-manager|CharacterManager|enableCharacterManager|Browse" "$DATA/extensions/NemoPresetExt/content.js" 2>/dev/null | head -n 15

hr "CHARACTER LIBRARY — character grouping / shelves"
CL="$DATA/extensions/SillyTavern-CharacterLibrary"
if [ -d "$CL" ]; then
    echo "--- inventory ---"
    ls -1 "$CL/modules" "$CL/app" 2>/dev/null | head -n 40
    echo "--- grouping keywords across all js ---"
    for kw in collection shelf folderId groupId tagFilter grouping bucket section category; do
        c=$(grep -rho "$kw" "$CL" --include='*.js' 2>/dev/null | wc -l | tr -d ' ')
        printf '  %-14s %s\n' "$kw" "$c"
    done
    echo "--- folderId usage (first 13 hits) ---"
    grep -rn "folderId" "$CL" --include='*.js' 2>/dev/null | head -n 13
    echo "--- how the library stores its own state ---"
    grep -rnE "extensionSettings\.[A-Za-z]+|indexedDB|localStorage\.setItem" "$CL" --include='*.js' 2>/dev/null | head -n 15
    echo "--- does it hide/override the native character list? ---"
    grep -rnE "style\.display|classList\.add\('hidden|removeChild|RmPrintCharacters|rm_print_characters_block" "$CL" --include='*.js' 2>/dev/null | head -n 12
fi

hr "DONE (deep dive 4) — nothing was modified"
