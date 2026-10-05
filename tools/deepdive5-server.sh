#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Read-only deep dive, part 5: is NemoPresetExt's character manager actually
# wired up, and where does its folder data live? Writes nothing, no sudo.
# ---------------------------------------------------------------------------
set -u
ST="${ST_PATH:-$HOME/SillyTavern}"
DATA="$ST/data/default-user"
NE="$DATA/extensions/NemoPresetExt"
hr() { printf '\n===== %s =====\n' "$1"; }

hr "WHO REFERENCES the character-manager feature?"
grep -rn "character-manager\|CharacterManager\|characterManager" "$NE" --include='*.js' --include='*.html' --include='*.json' 2>/dev/null | grep -v '^Binary' | head -n 25

hr "HOW ARE FEATURES LOADED?"
echo "--- content.js: imports and feature initialisation ---"
grep -nE "^import|features/|await import|loadFeature|initFeature|init\(\)" "$NE/content.js" 2>/dev/null | head -n 40
echo "--- core directory ---"
ls -1 "$NE/core" 2>/dev/null | head -n 25

hr "FEATURE LOADER (if any)"
for f in "$NE"/core/*.js; do
    if grep -qE "features/" "$f" 2>/dev/null; then
        echo "--- $(basename "$f") ---"
        grep -nE "features/|import\(" "$f" 2>/dev/null | head -n 12
    fi
done

hr "NEMO — where folder metadata is read/written"
grep -rn "nemoCharacterMetadata_v1\|localStorage.setItem\|localStorage.getItem\|navigatorMetadata" "$NE" --include='*.js' 2>/dev/null | head -n 25

hr "NEMO SETTINGS — navigatorMetadata / favourites content shape"
node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const n=s.extension_settings?.NemoPresetExt||{};
const nm=n.navigatorMetadata;
console.log("navigatorMetadata type:", Array.isArray(nm)?"array":typeof nm, "| size:", JSON.stringify(nm||{}).length, "chars");
if(nm && typeof nm==="object"){
  console.log("keys:", Object.keys(nm).slice(0,15).join(", "));
  const probe=JSON.stringify(nm).slice(0,300);
  console.log("preview:", probe);
}
console.log("favoriteCharacters:", JSON.stringify(n.favoriteCharacters||null).slice(0,200));
console.log("sectionsEnabled:", JSON.stringify(n.sectionsEnabled||null).slice(0,200));
' "$DATA/settings.json" 2>&1

hr "CHARACTER LIBRARY — entry point & whether it shows all characters"
CL="$DATA/extensions/SillyTavern-CharacterLibrary"
grep -nE "getContext\(\)|characters\b.*filter|ourContext\.characters|extensionSettings\.[a-zA-Z]+" "$CL/app/library.js" 2>/dev/null | head -n 20
echo "--- how it is opened (button/drawer) ---"
grep -nE "drawerIcon|extensionsMenu|addEventListener\('click'|open\(|toggle" "$CL/index.js" 2>/dev/null | head -n 20

hr "CONFLICT SURFACE — all extensions touching #rm_characters_block"
for ext in "$DATA/extensions"/*/; do
    [ -d "$ext" ] || continue
    n=$(basename "$ext")
    hits=$(grep -rl "rm_characters_block" "$ext" --include='*.js' --include='*.html' 2>/dev/null | wc -l | tr -d ' ')
    hits2=$(grep -rl "filterFunctions\|entitiesFilter" "$ext" --include='*.js' 2>/dev/null | wc -l | tr -d ' ')
    [ "$hits" != "0" -o "$hits2" != "0" ] && printf '  %-40s files_with_rm_characters_block=%-3s files_with_entitiesFilter=%s\n' "$n" "$hits" "$hits2"
done

hr "DONE (deep dive 5) — nothing was modified"
