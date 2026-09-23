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
#
# POPRAVEK (2026-09-23, TRETJA ITERACIJA – glej HISTORY_AI_AGENT.txt): DRUG, LOČEN vzrok odpovedi je
# bil dokazan na resničnem macOS računalniku uporabnika: python3 SE JE dejansko zagnal (proces je bil
# ŽIV celih prejšnjih 5 sekund, dokler ga ta skripta ni sama ubila), a v "$logfile" v tem času ni
# zapisal POPOLNOMA NIČESAR (niti sporočila "Serving HTTP..." niti kakršnekoli napake) – najverjetnejši
# vzrok je izhodno predpomnjenje (buffering): ko Python izhod (stdout) preusmerimo v datoteko (ne v
# terminal), Python privzeto uporablja BLOČNO predpomnjenje namesto vrstičnega, kar lahko na nekaterih
# sistemih/verzijah pomeni, da se kratko sporočilo o zagonu strežnika ne zapiše na disk takoj, temveč
# šele kasneje (ali ob izhodu procesa) – naša skripta pa medtem, ne da bi to vedela, sklene, da se
# strežnik ni zagnal, in ga ubije. Popravek ima DVE plasti: (1) zastavica `-u` prisili Python v
# NEPREDPOMNJEN (takojšen) izpis – to odpravi vzrok, če gre res za predpomnjenje; (2) časovna omejitev
# čakanja je podaljšana s prejšnjih 5 s na 10 s (počasnejši/prvi zagon interpreterja na nekaterih
# sistemih), IN sporočilo o napaki zdaj LOČI dva različna primera: če je bil proces ob poteku čakanja
# ŠE VEDNO ŽIV (kot v dokazanem primeru), gre najverjetneje za počasen/zakasnjen zagon – ne za resnično
# odpoved – kar dobi SVOJE, drugačno (ne xcode-select) pojasnilo.
cd "$(dirname "$0")" || exit 1

COMBINED_LOG=""
PORT=""
SERVER_PID=""
SAW_ALIVE_TIMEOUT=0 # postavljeno na 1, če je bil VSAJ EN kandidat ob poteku čakanja še vedno živ
                     # (glej opombo zgoraj – kaže na predpomnjenje izhoda/počasen zagon, ne na pravo napako)

try_candidate() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || return 1
  local logfile
  logfile="$(mktemp -t 'ocr-index-app-server.XXXXXX')"
  # "-u" = nepredpomnjen (unbuffered) izpis – glej opombo o POPRAVKU zgoraj.
  "$cmd" -u -m http.server 0 --bind 127.0.0.1 > "$logfile" 2>&1 &
  local pid=$!
  local port=""
  local stillAlive=0
  local i
  for i in $(seq 1 100); do
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
  if kill -0 "$pid" 2>/dev/null; then stillAlive=1; SAW_ALIVE_TIMEOUT=1; fi
  kill "$pid" 2>/dev/null
  COMBINED_LOG="${COMBINED_LOG}
--- poskus z ukazom '$cmd' ni uspel (proces ob prekinitvi $([ "$stillAlive" = "1" ] && echo "ŠE VEDNO ŽIV – verjetno počasen zagon/zakasnjen izpis" || echo "že sam končan")), izpis: ---
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
  elif [ "$SAW_ALIVE_TIMEOUT" = "1" ]; then
    echo ""
    echo "Videti je, da se je Python DEJANSKO zagnal (proces je tekel), a v 10 sekundah ni sporočil,"
    echo "da posluša – to je lahko počasen/zakasnjen zagon (npr. prvi zagon po namestitvi, počasnejši"
    echo "disk, ali varnostno skeniranje datoteke). POSKUSITE ŠE ENKRAT – če se napaka ponovi tudi"
    echo "drugič/tretjič, odprite Terminal (Iskalnik > Programi > Pripomočki > Terminal), vnesite:"
    echo "  cd \"$(pwd)\" && python3 -m http.server 8123"
    echo "in mi sporočite, kaj se izpiše (ali obtiči brez izpisa)."
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
# Popravek (2026-09-23, na uporabnikovo željo - glej HISTORY_AI_AGENT.txt): namesto da URL odpremo v
# PRIVZETEM brskalniku (kar je bilo prejšnje vedenje in JE lahko drug brskalnik, ne nujno Edge), zdaj
# NAJPREJ poskusimo odpreti NEPOSREDNO v Microsoft Edge (aplikacija "Microsoft Edge.app", ki jo `open -a`
# najde po imenu, ne po poti). Če Edge na tem Macu NI nameščen, `open -a` vrne napako (izhodna koda != 0)
# - v tem primeru se varno vrnemo na prejšnje vedenje (odpri v privzetem brskalniku), da uporabnik brez
# Edge-a še vedno dobi delujočo aplikacijo.
if ! open -a "Microsoft Edge" "$URL" 2>/dev/null; then
  echo "(Microsoft Edge ni bil najden na tem Macu - odpiram v privzetem brskalniku namesto tega.)"
  open "$URL"
fi

echo ""
echo "To okno pustite odprto, dokler uporabljate aplikacijo – strežnik teče v njem."
echo "Ko končate, zaprite to okno Terminala (s tem se ustavi tudi strežnik)."
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT INT TERM
wait "$SERVER_PID"
