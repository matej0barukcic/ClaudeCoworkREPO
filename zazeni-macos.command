#!/bin/bash
# Zaganjalnik za macOS (Popravek A, QA krog 2026-09-22 – glej HISTORY_AI_AGENT.txt).
# Namesto neposrednega dvoklika na index.html (kar v Chrome/Edge blokira OCR worker zaradi
# varnostne omejitve file:// izvora – glej HISTORY_AI_AGENT.txt) ta skripta požene majhen
# lokalen strežnik na 127.0.0.1 (dostopen SAMO iz tega računalnika, brez omrežja navzven) in
# samodejno odpre aplikacijo v privzetem brskalniku prek http://.
#
# Vrata (port): namerno NISO fiksna (dobra praksa za ad-hoc lokalne strežnike, da se izognemo
# konfliktu "Address already in use") – uporabimo "port 0", kar operacijski sistem prosi, naj
# sam dodeli prosta vrata, nato dejansko dodeljena vrata razberemo iz izpisa strežnika.
#
# POPRAVEK (2026-09-22, DRUGA ITERACIJA – glej HISTORY_AI_AGENT.txt): prejšnja različica je SAMO
# preverila, ali ukaz "python3"/"python" OBSTAJA (`command -v`), ne pa, ali DEJANSKO DELUJE. Na
# macOS brez nameščenih Xcode Command Line Tools obstaja vgrajen "/usr/bin/python3", ki se KOT
# UKAZ najde (`command -v python3` uspe), a se ob dejanskem zagonu ne izvede kot Python, temveč
# izpiše samo "xcode-select: note: No developer tools were found, requesting install." in se konča
# brez zagona strežnika – dokazano na resničnem macOS računalniku uporabnika (glej HISTORY_AI_AGENT.txt).
# Zdaj skripta DEJANSKO POSKUSI zagnati strežnik z vsakim kandidatom po vrsti (python3, nato
# python) in šele če noben dejansko ne zažene strežnika, prikaže napako – s prilagojenim,
# razumljivim navodilom, če prepozna ta točno ta (zelo pogost) vzrok.

cd "$(dirname "$0")" || exit 1

COMBINED_LOG=""
PORT=""
SERVER_PID=""

try_candidate() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || return 1
  local logfile
  logfile="$(mktemp -t 'ocr-index-app-server.XXXXXX')"
  "$cmd" -m http.server 0 --bind 127.0.0.1 > "$logfile" 2>&1 &
  local pid=$!
  local port=""
  local i
  for i in $(seq 1 50); do
    port=$(grep -oE 'port [0-9]+' "$logfile" 2>/dev/null | grep -oE '[0-9]+' | head -1)
    if [ -n "$port" ]; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if [ -n "$port" ]; then
    PORT="$port"
    SERVER_PID="$pid"
    rm -f "$logfile"
    return 0
  fi
  kill "$pid" 2>/dev/null
  COMBINED_LOG="${COMBINED_LOG}
--- poskus z ukazom '$cmd' ni uspel, izpis: ---
$(cat "$logfile" 2>/dev/null)"
  rm -f "$logfile"
  return 1
}

FOUND=0
for CAND in python3 python; do
  if try_candidate "$CAND"; then
    FOUND=1
    break
  fi
done

if [ "$FOUND" != "1" ]; then
  echo "NAPAKA: Lokalnega strežnika ni bilo mogoče zagnati z nobenim najdenim ukazom (python3/python)."
  if printf '%s' "$COMBINED_LOG" | grep -qi "xcode-select\|developer tools\|command line tools"; then
    echo ""
    echo "Videti je, da Python na tem Macu ni pravilno nameščen (manjkajo Xcode Command Line Tools,"
    echo "ki jih vgrajeni macOS ukaz 'python3' zahteva, a jih ta Mac privzeto nima)."
    echo "REŠITEV: prenesite in namestite Python 3 NEPOSREDNO s te povezave:"
    echo "  https://www.python.org/downloads/macos/"
    echo "(ta namestitev NE zahteva Xcode orodij in je hitrejša od namestitve celotnih Xcode"
    echo "Command Line Tools). Po namestitvi to datoteko znova zaženite."
  else
    echo ""
    echo "Podrobnosti (za poročanje razvijalcu/AI agentu):"
    echo "$COMBINED_LOG"
  fi
  read -r -p "Pritisnite Enter za izhod ..." _
  exit 1
fi

URL="http://127.0.0.1:${PORT}/index.html"
echo "Lokalni strežnik teče na: $URL"
open "$URL"

echo ""
echo "To okno pustite odprto, dokler uporabljate aplikacijo – strežnik teče v njem."
echo "Ko končate, zaprite to okno Terminala (s tem se ustavi tudi strežnik)."
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT INT TERM
wait "$SERVER_PID"
