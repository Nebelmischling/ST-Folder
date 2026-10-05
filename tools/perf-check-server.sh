#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Read-only performance measurement for the SillyTavern LXC.
# Writes nothing, prints no secrets.
# ---------------------------------------------------------------------------
set -u
ST="${ST_PATH:-$HOME/SillyTavern}"
DATA=$ST/data/default-user
hr() { printf '\n===== %s =====\n' "$1"; }

hr "CONTAINER LIMITS (cgroup)"
echo -n "cpu.max:        "; cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo "n/a"
echo -n "memory.max:     "; cat /sys/fs/cgroup/memory.max 2>/dev/null || echo "n/a"
echo -n "memory.high:    "; cat /sys/fs/cgroup/memory.high 2>/dev/null || echo "n/a"
echo -n "memory.current: "; cat /sys/fs/cgroup/memory.current 2>/dev/null || echo "n/a"
echo -n "memory.swap.max:"; cat /sys/fs/cgroup/memory.swap.max 2>/dev/null || echo "n/a"
echo -n "pids.max:       "; cat /sys/fs/cgroup/pids.max 2>/dev/null || echo "n/a"
echo -n "cores (nproc):  "; nproc
grep -m1 "model name" /proc/cpuinfo 2>/dev/null | sed 's/^/cpu:            /'
grep -m1 "MemTotal" /proc/meminfo | sed 's/^/meminfo:        /'
grep -m1 "MemAvailable" /proc/meminfo | sed 's/^/meminfo:        /'
swapon --show 2>/dev/null | sed 's/^/swap: /' || echo "swap: none"

hr "CURRENT LOAD / CPU"
uptime

hr "NODE PROCESS"
PID=$(pgrep -f "node server.js" | head -1)
if [ -n "${PID:-}" ]; then
    ps -o pid,%cpu,%mem,rss,vsz,nlwp,etime,time -p "$PID"
    echo -n "open FDs:       "; ls /proc/$PID/fd 2>/dev/null | wc -l
    echo -n "RSS MB:         "; awk '{print int($1/1024)}' /proc/$PID/status 2>/dev/null >/dev/null; grep -m1 VmRSS /proc/$PID/status | awk '{printf "%d MB\n", $2/1024}'
    grep -m1 VmHWM /proc/$PID/status | awk '{printf "peak RSS:       %d MB\n", $2/1024}'
    echo "--- top threads by CPU (if any) ---"
    ps -L -o tid,%cpu,comm -p "$PID" 2>/dev/null | sort -k2 -rn | head -4
else
    echo "(node server.js not found)"
fi

hr "DISK"
df -h / 2>/dev/null | head -3
echo "--- data/ subfolders (largest last) ---"
du -sh "$DATA"/* 2>/dev/null | sort -h | tail -12
echo "--- install sizes ---"
du -sh "$ST/node_modules" "$ST/public" "$ST/backups" 2>/dev/null

hr "STALE FILES"
echo -n "characters/*.backup/         *.bookbackup count: "
find "$DATA/characters" -maxdepth 1 -type f \( -name "*.backup" -o -name "*.bookbackup" \) 2>/dev/null | wc -l
echo -n "their total size:            "
find "$DATA/characters" -maxdepth 1 -type f \( -name "*.backup" -o -name "*.bookbackup" \) -printf "%s\n" 2>/dev/null | awk '{s+=$1} END {printf "%.1f MB\n", s/1048576}'
echo -n "empty chat folders:          "
find "$DATA/chats" -mindepth 1 -maxdepth 1 -type d -empty 2>/dev/null | wc -l
echo -n "chat folders total:          "
find "$DATA/chats" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l

hr "LARGEST CHAT FILES"
find "$DATA/chats" -name "*.jsonl" -printf "%s %p\n" 2>/dev/null | sort -rn | head -5 | awk '{printf "%6.2f MB  %s\n", $1/1048576, $2}'
echo -n "chats total size: "; find "$DATA/chats" -name "*.jsonl" -printf "%s\n" 2>/dev/null | awk '{s+=$1} END {printf "%.1f MB\n", s/1048576}'
echo -n "largest character cards: "
find "$DATA/characters" -maxdepth 1 -name "*.png" -printf "%s\n" 2>/dev/null | sort -rn | head -3 | awk '{printf "%.1f MB ", $1/1048576}'; echo
echo -n "characters total: "; find "$DATA/characters" -maxdepth 1 -type f -printf "%s\n" 2>/dev/null | awk '{s+=$1} END {printf "%.1f MB\n", s/1048576}'
echo -n "worlds total:     "; find "$DATA/worlds" -maxdepth 1 -type f -printf "%s\n" 2>/dev/null | awk '{s+=$1} END {printf "%.1f MB\n", s/1048576}'
echo -n "backgrounds total:"; find "$DATA/backgrounds" -maxdepth 1 -type f -printf "%s\n" 2>/dev/null | awk '{s+=$1} END {printf "%.1f MB\n", s/1048576}'

hr "SETTINGS.JSON BLOAT"
node -e '
const fs=require("fs");
const p=process.argv[1];
const s=JSON.parse(fs.readFileSync(p,"utf8"));
const size=o=>JSON.stringify(o??null).length;
const rows=[];
for(const [k,v] of Object.entries(s.extension_settings||{})) rows.push([size(v),k]);
rows.sort((a,b)=>b[0]-a[0]);
console.log("settings.json:      "+(fs.statSync(p).size/1048576).toFixed(2)+" MB");
console.log("extension_settings: "+(size(s.extension_settings)/1048576).toFixed(2)+" MB");
console.log("biggest extension settings blocks:");
rows.slice(0,10).forEach(([n,k])=>console.log("   "+(n/1024).toFixed(0).padStart(7)+" kB  "+k));
console.log("chat metadata / other big top-level keys:");
for(const [k,v] of Object.entries(s)) if(!["extension_settings","tags","tag_map","power_user","world_info","themes","quick_reply","variables"].includes(k) && size(v)>20000) console.log("   "+(size(v)/1024).toFixed(0).padStart(7)+" kB  "+k);
' "$DATA/settings.json" 2>&1

hr "CLIENT PERFORMANCE SETTINGS (power_user)"
node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const p=s.power_user||{};
const pick=["fast_ui_mode","message_token_count","streaming_fps","smooth_streaming","image_modal","charListGrid","bogus_folders","fuzzy_search","show_card_avatar_urls","compact_input_area","swipe_to_reply","auto_connect","tokenizer","world_info_scan_depth","world_info_max_recursion","world_info_min_activations","differentiate_on_activation","enable_extensions","extensions_auto_update"];
for(const k of pick) if(k in p) console.log("   "+k+": "+JSON.stringify(p[k]));
console.log("   vector settings:", JSON.stringify(s.extension_settings?.vectors??null).slice(0,300));
console.log("   transformers/sd/tts aktiv:", ["transformers","sd","tts","chromadb"].map(k=>k+"="+Boolean(s.extension_settings?.[k]?.enabled??false)).join(", "));
' "$DATA/settings.json" 2>&1

hr "ST CONFIG (performance + risk relevant)"
grep -nE "^[a-zA-Z]+:|^  (lazyLoadCharacters|memoryCacheCapacity|useDiskCache|enabled|minPayloadSize|maxPayloadSize|timeout|autoUpdate|enableServerPluginsAutoUpdate):" "$ST/config.yaml" 2>/dev/null | grep -vE "^\s*#" | head -40

hr "ACCESS LOG + GZIP"
echo -n "access log setting: "; grep -n "enableAccessLog" "$ST/config.yaml" | head -1
echo "--- response headers for a JS asset ---"
curl -s -o /dev/null -D - -H "Accept-Encoding: gzip, deflate, br" http://127.0.0.1:8000/script.js 2>/dev/null | grep -iE "^(HTTP|content-length|content-encoding|etag|cache-control)" | sed 's/^/   /'
echo "--- same for index.html ---"
curl -s -o /dev/null -D - -H "Accept-Encoding: gzip, deflate, br" http://127.0.0.1:8000/ 2>/dev/null | grep -iE "^(HTTP|content-length|content-encoding)" | sed 's/^/   /'

hr "PAGE WEIGHT (what a browser must download)"
node -e '
const fs=require("fs"), path=require("path");
const ST=process.argv[1], DATA=process.argv[2];
const html=fs.readFileSync(path.join(ST,"public/index.html"),"utf8");
const refs=[...html.matchAll(/(?:src|href)="((?:lib|css|scripts|webfonts|img)\/[^"]+)"/g)].map(m=>m[1]);
let total=0, missing=0;
const seen=new Set();
for(const r of refs){ if(seen.has(r)) continue; seen.add(r); const f=path.join(ST,"public",r); try{ const s=fs.statSync(f).size; total+=s; }catch{ missing++; } }
console.log("   core static assets: "+(total/1048576).toFixed(2)+" MB in "+seen.size+" files (missing: "+missing+")");
let extTotal=0, extFiles=0;
const extDir=path.join(DATA,"extensions");
for(const name of fs.readdirSync(extDir)){
  const mf=path.join(extDir,name,"manifest.json");
  if(!fs.existsSync(mf)) continue;
  let m; try{ m=JSON.parse(fs.readFileSync(mf,"utf8")); }catch{ continue; }
  for(const key of ["js","css"]){
    if(!m[key]) continue;
    const f=path.join(extDir,name,m[key]);
    if(fs.existsSync(f)){ extTotal+=fs.statSync(f).size; extFiles++; }
  }
  if(m.display_name && fs.existsSync(path.join(extDir,name,"style.css"))){}
}
console.log("   extension entry files: "+(extTotal/1048576).toFixed(2)+" MB in "+extFiles+" files (plus everything they import at runtime)");
' "$ST" "$DATA" 2>&1

hr "DONE"
