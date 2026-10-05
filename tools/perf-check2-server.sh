#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Read-only performance deep dive #2: client-side weight, backups, extensions.
# Writes nothing.
# ---------------------------------------------------------------------------
set -u
ST="${ST_PATH:-$HOME/SillyTavern}"
DATA=$ST/data/default-user
hr() { printf '\n===== %s =====\n' "$1"; }

hr "EXTENSIONS: size, manifest, auto_update"
for d in "$DATA/extensions"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    size=$(du -sh "$d" 2>/dev/null | cut -f1)
    if [ -f "$d/manifest.json" ]; then
        au=$(grep -o '"auto_update"[^,}]*' "$d/manifest.json" 2>/dev/null | head -1)
        dn=$(grep -m1 '"display_name"' "$d/manifest.json" | sed 's/.*: *//' | tr -d '",\r')
        printf '  %-38s %7s  %-28s %s\n' "${name:0:38}" "$size" "${dn:0:28}" "${au:-auto_update:no}"
    else
        printf '  %-38s %7s  *** KEIN manifest.json -> von ST ignoriert ***\n' "${name:0:38}" "$size"
    fi
done

hr "CUSTOM CSS / THEME WEIGHT"
node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const p=s.power_user||{};
const ui=["fast_ui_mode","movingUI","blur_strength","shadow_width","theme","avatar_style","image_modal","message_token_count_enabled","expand_message_actions","relaxed_api_urls","auto_connect","swipes","custom_stopping_strings"];
for(const k of ui) if(k in p) console.log("   "+k+": "+JSON.stringify(p[k]).slice(0,60));
console.log("   custom_css length: "+(typeof p.custom_css==="string"?p.custom_css.length:0)+" chars");
console.log("   themes installed: "+(fs.readdirSync(process.argv[2]+"/themes").length));
' "$DATA/settings.json" "$DATA" 2>&1
echo "--- groesste Theme-Dateien ---"
ls -lS "$DATA/themes" 2>/dev/null | head -4 | awk '{printf "   %6.0f kB  %s\n", $5/1024, $9}'

hr "BACKUPS (chat backups)"
grep -nA8 "^backups:" "$ST/config.yaml" 2>/dev/null | grep -vE "^\s*[0-9]+-\s*#" | head -12
echo "--- Backups auf Platte ---"
echo -n "   count: "; find "$DATA/backups" -type f 2>/dev/null | wc -l
echo -n "   size:  "; du -sh "$DATA/backups" 2>/dev/null | cut -f1
echo "   oldest/newest:"; find "$DATA/backups" -type f -printf "%T+ %p\n" 2>/dev/null | sort | sed -n '1p;$p' | sed 's/^/     /'

hr "TOKENIZER CACHE / THUMBNAILS / GALLERY"
for d in tokenizers thumbnails _storage; do
    if [ -d "$DATA/$d" ]; then
        echo "   $d: $(du -sh "$DATA/$d" 2>/dev/null | cut -f1) in $(find "$DATA/$d" -type f | wc -l) files"
    else
        echo "   $d: (nicht vorhanden)"
    fi
done
echo "   user/images: $(du -sh "$DATA/user/images" 2>/dev/null | cut -f1) in $(find "$DATA/user/images" -type f 2>/dev/null | wc -l) files"
echo "--- groesste Bilder in user/ ---"
find "$DATA/user" -type f -printf "%s %p\n" 2>/dev/null | sort -rn | head -3 | awk '{printf "   %6.1f MB  %s\n", $1/1048576, $2}'
echo "--- groesste Karten ---"
find "$DATA/characters" -maxdepth 1 -name "*.png" -printf "%s %p\n" 2>/dev/null | sort -rn | head -5 | awk '{printf "   %6.1f MB  %s\n", $1/1048576, $2}'

hr "PAGE LOAD COST: was laedt der Browser wirklich?"
node -e '
const fs=require("fs"), path=require("path");
const ST=process.argv[1], DATA=process.argv[2];
const sumDir=(dir)=>{let t=0,n=0; for(const e of fs.readdirSync(dir,{withFileTypes:true})){ const f=path.join(dir,e.name); if(e.isDirectory()){const r=sumDir(f); t+=r.t; n+=r.n;} else if(/\.(js|mjs|css|html)$/.test(e.name)){ t+=fs.statSync(f).size; n++; } } return {t,n};};
let total=0, files=0;
const extDir=path.join(DATA,"extensions");
for(const name of fs.readdirSync(extDir)){
  const d=path.join(extDir,name);
  if(!fs.statSync(d).isDirectory()) continue;
  if(!fs.existsSync(path.join(d,"manifest.json"))) continue;
  const r=sumDir(d); total+=r.t; files+=r.n;
}
console.log("   alle JS/CSS der aktivierten Extensions: "+(total/1048576).toFixed(2)+" MB in "+files+" Dateien");
const libs=sumDir(path.join(ST,"public/lib"));
console.log("   public/lib (jquery, jquery-ui, ...):    "+(libs.t/1048576).toFixed(2)+" MB in "+libs.n+" Dateien");
' "$ST" "$DATA" 2>&1

hr "DONE"
