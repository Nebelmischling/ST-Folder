#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Read-only deep dive, part 2: local patches, existing character-list UI
# extensions and folder readiness. Writes nothing, needs no sudo.
#
# Invocation (base64 to avoid encoding issues):
#   $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
#   ssh -T -i <key> root@<host> "echo $b64 | base64 -d | bash"
# ---------------------------------------------------------------------------
set -u
ST="${ST_PATH:-$HOME/SillyTavern}"
DATA="$ST/data/default-user"
hr() { printf '\n===== %s =====\n' "$1"; }

hr "LOCAL PATCHES IN THE GIT CHECKOUT"
if [ -d "$ST/.git" ]; then
    echo "--- git status --porcelain ---"
    git -C "$ST" status --porcelain 2>/dev/null | head -n 20
    echo "--- git diff --stat ---"
    git -C "$ST" diff --stat 2>/dev/null | tail -n 10
    echo "--- git diff (first 60 lines) ---"
    git -C "$ST" diff 2>/dev/null | head -n 60
    echo "--- untracked, excluding data/backups/node_modules ---"
    git -C "$ST" status --porcelain --untracked-files=all 2>/dev/null | grep '^??' | grep -vE 'data/|backups/|node_modules/' | head -n 15
else
    echo "(no git checkout)"
fi

hr "EXTENSIONS THAT TOUCH THE CHARACTER LIST / PANEL"
for ext in "$DATA/extensions"/*/; do
    [ -d "$ext" ] || continue
    name=$(basename "$ext")
    hits=$(grep -rlE "rm_print_characters_block|entitiesFilter|character_select|rm_characters_block|character_filter" "$ext" --include='*.js' --include='*.html' 2>/dev/null | head -n 5)
    if [ -n "$hits" ]; then
        echo "--- $name ---"
        echo "$hits" | sed 's/^/    /'
        grep -rhoE "rm_print_characters_block|entitiesFilter|rm_characters_block|filterFunctions|select_rm_characters" "$ext" --include='*.js' 2>/dev/null | sort | uniq -c | sort -rn | head -n 6 | sed 's/^/      /'
    fi
done

hr "EXTENSION MANIFESTS (all user extensions)"
for ext in "$DATA/extensions"/*/; do
    [ -d "$ext" ] || continue
    m="$ext/manifest.json"
    name=$(basename "$ext")
    if [ -f "$m" ]; then
        dn=$(grep -m1 '"display_name"' "$m" | sed 's/.*: *//' | tr -d '",\r')
        ver=$(grep -m1 '"version"' "$m" | sed 's/.*: *//' | tr -d '",\r')
        js=$(grep -m1 '"js"' "$m" | sed 's/.*: *//' | tr -d '",\r')
        printf '  %-42s %-28s %-8s js=%s\n' "$name" "$dn" "$ver" "$js"
    else
        printf '  %-42s %s\n' "$name" "*** NO manifest.json ***"
    fi
done

hr "CHARACTER LIBRARY EXTENSION — folder/collection capabilities"
CL="$DATA/extensions/SillyTavern-CharacterLibrary"
if [ -d "$CL" ]; then
    echo "files: $(ls -1 "$CL" | tr '\n' ' ')"
    echo "size: $(du -sh "$CL" 2>/dev/null | cut -f1)"
    echo "--- feature keywords in index.js ---"
    for kw in folder folderId collection tag category library grid sort search; do
        c=$(grep -oi "$kw" "$CL/index.js" 2>/dev/null | wc -l | tr -d ' ')
        printf '  %-12s %s\n' "$kw" "$c"
    done
    echo "--- manifest ---"
    cat "$CL/manifest.json" 2>/dev/null | head -n 25
    echo "--- where it hooks in (context lines) ---"
    grep -nE "rm_print_characters_block|rm_characters_block|entitiesFilter|character_select|folder|Folder" "$CL/index.js" 2>/dev/null | head -n 25
else
    echo "(not installed under that name)"
fi

hr "TAG / FOLDER READINESS"
node -e '
const fs=require("fs");
const p=process.argv[1];
const s=JSON.parse(fs.readFileSync(p,"utf8"));
const tags=Array.isArray(s.tags)?s.tags:[];
const map=s.tag_map||{};
const counts={};
for(const [avatar,ids] of Object.entries(map)){ for(const id of (ids||[])){ counts[id]=(counts[id]||0)+1; } }
const folderTypes=["OPEN","CLOSED","NONE"];
const byType={OPEN:0,CLOSED:0,NONE:0,undefined:0};
for(const t of tags){ const ft=t&&t.folder_type; if(ft===undefined) byType.undefined++; else if(byType[ft]===undefined) byType[ft]=0,byType[ft]++; else byType[ft]++; }
console.log("tags total:", tags.length);
console.log("tag folder_type distribution:", JSON.stringify(byType));
console.log("tags with >=1 character:", tags.filter(t=>counts[t.id]>0).length);
console.log("characters with >=1 tag:", Object.keys(map).length);
console.log("tags sorted by usage (top 15):");
tags.slice().sort((a,b)=>(counts[b.id]||0)-(counts[a.id]||0)).slice(0,15).forEach(t=>console.log("   "+(counts[t.id]||0)+"x  "+String(t.name).slice(0,40)));
console.log("all tag names (first 30):", tags.slice(0,30).map(t=>String(t.name).slice(0,24)).join(" | "));
' "$DATA/settings.json" 2>&1

hr "CHARACTERS / FILES OVERVIEW"
echo "characters: $(find "$DATA/characters" -maxdepth 1 -name '*.png' 2>/dev/null | wc -l | tr -d ' ') png files"
echo "character subfolders (alt images / CharX assets): $(find "$DATA/characters" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
echo "chats: $(find "$DATA/chats" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ') folders, $(find "$DATA/chats" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ') files"
echo "worlds: $(find "$DATA/worlds" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ') files"
echo "newest 5 characters:"; ls -lt "$DATA/characters"/*.png 2>/dev/null | head -n 5 | awk '{print "   "$6" "$7" "$8"  "$9}'
echo "oldest 5 characters:"; ls -ltr "$DATA/characters"/*.png 2>/dev/null | head -n 5 | awk '{print "   "$6" "$7" "$8"  "$9}'

hr "DISK / BACKUPS"
df -h /home 2>/dev/null | head -n 3
echo "install size: $(du -sh "$ST" 2>/dev/null | cut -f1) (node_modules: $(du -sh "$ST/node_modules" 2>/dev/null | cut -f1))"
echo "data size:    $(du -sh "$ST/data" 2>/dev/null | cut -f1)"
if [ -d "$ST/backups" ]; then
    echo "backups: $(find "$ST/backups" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l | tr -d ' ') entries, newest:"
    ls -lt "$ST/backups" 2>/dev/null | head -n 5 | sed 's/^/   /'
else
    echo "backups: (no backups directory)"
fi

hr "ST CONFIG — SECURITY RELEVANT (values only)"
grep -nE '^[[:space:]]*(listen|listenAddress|whitelistMode|basicAuthMode|enableUserAccounts|securityOverride|enableServerPlugins|protocol|ssl|corsProxy|requestProxy|autorun):' "$ST/config.yaml" 2>/dev/null | sed 's/^/  /'

hr "DONE (deep dive 2) — nothing was modified"
