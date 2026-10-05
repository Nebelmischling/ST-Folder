#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Read-only audit of a SillyTavern installation.
#
# Guarantees:
#   * writes nothing (no temp files, no package installs, no restarts)
#   * runs without sudo
#   * prints no secrets: config.yaml is only grepped for a fixed key allowlist,
#     settings.json is only summarised (counts / key names), never dumped
#   * prints no chat, character or world-info content
#
# Intended invocation (script is piped to the remote bash, so it contains no
# heredocs on purpose - a heredoc would swallow the rest of the script):
#   Get-Content audit-server.sh -Raw | ssh -T -i <key> -p <port> <user>@<host> 'bash -s'
# ---------------------------------------------------------------------------
set -u

hr() { printf '\n===== %s =====\n' "$1"; }

hr "SYSTEM"
uname -a 2>/dev/null || true
( . /etc/os-release 2>/dev/null && echo "distro: ${PRETTY_NAME:-unknown}" ) || true
echo "user: $(id -un) (uid=$(id -u), groups=$(id -Gn 2>/dev/null | tr ' ' ',' ))"
echo "home: $HOME"
echo "date: $(date -Is 2>/dev/null || date)"

hr "RUNTIME"
for c in node npm npx git docker docker-compose podman pm2 tmux screen jq; do
    if command -v "$c" >/dev/null 2>&1; then
        v=$("$c" --version 2>&1 | head -n 1)
        printf '%-15s %s  [%s]\n' "$c" "$(command -v "$c")" "$v"
    else
        printf '%-15s not found\n' "$c"
    fi
done

hr "RUNNING SILLYTAVERN PROCESSES"
if command -v ps >/dev/null 2>&1; then
    ps -eo pid,etime,rss,cmd 2>/dev/null | grep -iE 'server\.js|sillytavern|tavern' | grep -v grep | head -n 10 || echo "(none found)"
fi

hr "LISTENING PORTS (visible to this user)"
(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | head -n 25 || echo "(ss/netstat unavailable)"

hr "SERVICE / AUTOSTART"
echo "--- systemd user units ---"
systemctl --user list-units --type=service --no-pager 2>/dev/null | head -n 12 || echo "(n/a)"
echo "--- systemd system units matching tavern/node ---"
systemctl list-units --type=service --no-pager 2>/dev/null | grep -iE 'tavern|silly|node' | head -n 10 || echo "(none)"
echo "--- unit files on disk ---"
ls -1 /etc/systemd/system 2>/dev/null | grep -iE 'tavern|silly' || echo "(none)"
echo "--- unit definition (User / ExecStart / WorkingDirectory) ---"
systemctl list-units --type=service --no-legend --plain --no-pager 2>/dev/null | grep -iE 'tavern|silly' | cut -d' ' -f1 | while IFS= read -r unit; do
    [ -n "$unit" ] || continue
    echo "unit: $unit"
    systemctl show -p User -p Group -p WorkingDirectory -p Restart -p ExecStart "$unit" 2>/dev/null | head -n 6 | sed 's/^/  /'
done
echo "--- start script (first 30 non-empty lines) ---"
for s in /home/*/SillyTavern/start.sh "$HOME"/SillyTavern/start.sh; do
    if [ -f "$s" ]; then
        echo "script: $s"
        grep -vE '^\s*$' "$s" 2>/dev/null | head -n 30 | sed 's/^/  /'
    fi
done
echo "--- crontab ---"
crontab -l 2>/dev/null | grep -iE 'tavern|silly|node' || echo "(none)"

hr "CONTAINERS"
if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.Names}} | {{.Image}} | {{.Ports}} | {{.Status}}' 2>&1 | head -n 15
    echo "--- compose projects ---"
    docker compose ls 2>&1 | head -n 10
else
    echo "(docker not available)"
fi

hr "CANDIDATE INSTALLATIONS"
ST_DIR=""
FOUND=0
if [ -n "${ST_PATH:-}" ] && [ -f "$ST_PATH/server.js" ]; then
    echo "path provided via ST_PATH: $ST_PATH"
    ST_DIR="$ST_PATH"
else
while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    FOUND=$((FOUND + 1))
    dir=$(dirname "$candidate")
    pkg="$dir/package.json"
    name=""
    [ -f "$pkg" ] && name=$(grep -m1 '"name"' "$pkg" 2>/dev/null | tr -d ' ",' | sed 's/name://')
    marker=""
    [ -d "$dir/public/scripts/extensions" ] && marker="(looks like SillyTavern)"
    printf '%s  %s %s\n' "$dir" "$name" "$marker"
    if [ "$name" = "sillytavern" ] && [ -z "$ST_DIR" ]; then
        ST_DIR="$dir"
    fi
done < <(find "$HOME" /home /root /opt /srv /var/www /usr/local /mnt /media /data -maxdepth 5 \
    \( -name node_modules -o -name .git -o -name proc -o -name .cache \) -prune -o \
    -type f -name server.js -print 2>/dev/null | head -n 25)
fi
[ "$FOUND" -eq 0 ] && [ -z "$ST_DIR" ] && echo "(no server.js found in the searched paths)"

if [ -z "$ST_DIR" ]; then
    hr "RESULT"
    echo "No SillyTavern directory (package.json name=sillytavern) detected automatically."
    echo "Please tell me the path and I will audit it directly."
    exit 0
fi

hr "INSTALLATION: $ST_DIR"
echo "version:  $(grep -m1 '"version"' "$ST_DIR/package.json" | tr -d ' ",' | sed 's/version://')"
echo "size:     $(du -sh "$ST_DIR" 2>/dev/null | cut -f1)"
echo "node_modules present: $([ -d "$ST_DIR/node_modules" ] && echo yes || echo no)"
echo "node engine required: $(grep -m1 '"node"' "$ST_DIR/package.json" | tr -d ' ",' | sed 's/node://')"

if [ -d "$ST_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    echo "git:      $(git -C "$ST_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null) @ $(git -C "$ST_DIR" log -1 --format='%h %ci' 2>/dev/null)"
    echo "git remote: $(git -C "$ST_DIR" remote get-url origin 2>/dev/null || echo '(none)')"
    echo "local modifications: $(git -C "$ST_DIR" status --porcelain 2>/dev/null | wc -l) file(s)"
    echo "recent commits:"
    git -C "$ST_DIR" log -3 --format='  %h %ci %s' 2>/dev/null
else
    echo "git:      not a git checkout (zip/release install)"
fi

hr "CONFIG.YAML (key allowlist only)"
CONFIG="$ST_DIR/config.yaml"
if [ -f "$CONFIG" ]; then
    echo "path: $CONFIG  ($(wc -l < "$CONFIG") lines)"
    grep -nE '^[[:space:]]*(dataRoot|port|listen|listenAddress|protocol|enableUserAccounts|whitelistMode|basicAuthMode|enableServerPlugins|securityOverride|autorun|browserLaunchEnabled):' "$CONFIG" 2>/dev/null | head -n 20
    echo "--- extensions block ---"
    grep -nA3 -E '^extensions:' "$CONFIG" 2>/dev/null | head -n 12
else
    echo "config.yaml not found (SillyTavern creates it on first start)"
fi

hr "DATA LAYOUT"
DATA_ROOT="$ST_DIR/data"
if [ -f "$CONFIG" ]; then
    cfg_root=$(grep -m1 -E '^[[:space:]]*dataRoot:' "$CONFIG" 2>/dev/null | sed 's/^[^:]*:[[:space:]]*//' | tr -d '"'"'" | tr -d '\r')
    [ -n "$cfg_root" ] && DATA_ROOT="$cfg_root"
    case "$DATA_ROOT" in
        ./*|../*) DATA_ROOT="$ST_DIR/${DATA_ROOT#./}" ;;
    esac
fi
echo "dataRoot: $DATA_ROOT"

for handleDir in "$DATA_ROOT"/*/; do
    [ -d "$handleDir" ] || continue
    handle=$(basename "$handleDir")
    case "$handle" in _uploads|_cache|_errors) continue ;; esac
    echo "--- handle: $handle ---"
    for sub in characters chats groups worlds backgrounds themes user avatars; do
        if [ -d "$handleDir$sub" ]; then
            printf '    %-12s %6s entries\n' "$sub" "$(find "$handleDir$sub" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l | tr -d ' ')"
        fi
    done
    if [ -d "$handleDir/extensions" ]; then
        echo "    user extensions: $(ls -1 "$handleDir/extensions" 2>/dev/null | tr '\n' ' ')"
    else
        echo "    user extensions: (directory does not exist yet)"
    fi

    SETTINGS="$handleDir/settings.json"
    if [ -f "$SETTINGS" ]; then
        if command -v node >/dev/null 2>&1; then
            node -e 'const fs=require("fs");const p=process.argv[1];try{const s=JSON.parse(fs.readFileSync(p,"utf8"));const tags=Array.isArray(s.tags)?s.tags:[];const es=s.extension_settings||{};console.log("    settings.json: "+(fs.statSync(p).size/1024).toFixed(0)+" kB");console.log("    tags: "+tags.length+", of them folder-tags: "+tags.filter(t=>t&&t.folder_type&&t.folder_type!=="NONE").length+", tag_map entries: "+Object.keys(s.tag_map||{}).length);console.log("    power_user.bogus_folders (Tags as Folders): "+Boolean(s.power_user&&s.power_user.bogus_folders));console.log("    disabled extensions: "+((s.disabled_extensions||[]).join(", ")||"(none)"));console.log("    extension_settings keys: "+(Object.keys(es).join(", ")||"(none)"));console.log("    charListGrid: "+Boolean(s.power_user&&s.power_user.charListGrid));}catch(e){console.log("    settings.json unreadable: "+e.message);}' "$SETTINGS"
        else
            echo "    settings.json: present ($(wc -c < "$SETTINGS") bytes; node missing for summary)"
        fi
    else
        echo "    settings.json: (not found)"
    fi
done

hr "EXTENSIONS ON DISK"
echo "--- built-in / bundled ---"
ls -1 "$ST_DIR/public/scripts/extensions" 2>/dev/null | tr '\n' ' '; echo
echo "--- third-party (global, admin only) ---"
if [ -d "$ST_DIR/public/scripts/extensions/third-party" ]; then
    for d in "$ST_DIR/public/scripts/extensions/third-party"/*/; do
        [ -d "$d" ] || continue
        manifest="$d/manifest.json"
        if [ -f "$manifest" ]; then
            printf '  %-32s %s\n' "$(basename "$d")" "$(grep -m1 '"display_name"' "$manifest" | sed 's/.*: *//' | tr -d '",\r')"
        else
            printf '  %-32s (no manifest.json - skipped by SillyTavern)\n' "$(basename "$d")"
        fi
    done
else
    echo "  (directory does not exist)"
fi
echo "--- collision check for the new extension ---"
for p in "$ST_DIR/public/scripts/extensions/third-party/character-folders" "$DATA_ROOT"/*/extensions/character-folders; do
    if [ -e "$p" ]; then echo "  ALREADY EXISTS: $p"; fi
done
echo "  (no ALREADY EXISTS line above means the name is free)"

hr "DONE"
echo "Audit finished - nothing was modified."
