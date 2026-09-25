# Handoff: Zagon "OCR Iskalnik slik" na IT-omejenem službenem Windows računalniku (Novartis)

**Created:** 2026-09-24T06:40Z
**Branch:** main
**Session Duration:** ta segment: ~1 uro (več predhodnih segmentov, glej HISTORY_AI_AGENT.txt za polno zgodovino od v2.1 dalje)
**Context Window Status:** ni sprožen zaradi bližine limita konteksta — uporabnik je izrecno zahteval, da se ta dokument vodi SPROTI, kot tekoč zapisnik neuspešnih poskusov, ne le ob koncu seje. To je prvi zapis; nadaljnje seje naj ga POSODOBIJO (ne prepišejo na novo) ob vsakem novem poskusu/napaki.

---

## Summary

Uporabnik (Matej) na svojem IT-upravljanem službenem Windows računalniku (Novartis) poskuša zagnati lokalno OCR aplikacijo "OCR Iskalnik slik" (Tesseract.js, statičen HTML/JS, zahteva lokalen HTTP strežnik zaradi brskalniške omejitve `file://`). Doslej sta odpovedala DVA neodvisna zaganjalna mehanizma (Python-osnovan in prvi PowerShell-osnovan), zdaj je v teku tretji poskus (utrjen PowerShell strežnik, v2.8). Trenutno stanje: aplikacija se NALOŽI in OCR strežnik TEČE, a OCR pregled DOSLEDNO (100 % ponovljivo, ne občasno) odpove z `NetworkError: Failed to execute 'importScripts'` pri nalaganju ene same, največje datoteke (`tesseract-core-simd-lstm.wasm.js`, ~3,9 MB) znotraj Web Worker-ja.

---

## Development Process Log

1. Osnovna aplikacija (OCR Hitro/Natančno, indeksiranje map, iskanje) — status: DONE — produced: `index.html`, `app.js`, `assets/` (od začetka projekta, v2.1+)
2. FAZA 1 (konflikt dveh zavihkov, QA najdbe) — status: DONE — produced: commit `b90d34f` (v2.2)
3. FAZA 2 1. del (svetla tema, regex namig, naslov zavihka, README licence) — status: DONE — produced: commit `5ee6595` (v2.3)
4. macOS zaganjalnik — popravek "buffering" napake (python3 živ, a brez izpisa) — status: DONE, POTRJENO na realnem Macu — produced: commit `869a30a` (v2.4)
5. macOS/Windows — odpiranje v Microsoft Edge namesto privzetega brskalnika — status: DONE, POTRJENO na realnem Macu; NI testirano na realnem Windows — produced: commit `e7401af` (v2.5)
6. Windows — README ROČNI obhod za IT-blokirano `.bat` izvajanje (klic `python` neposredno v cmd/PowerShell) — status: DONE, a NEZADOSTEN (glej spodaj) — produced: commit `ec5403a` (v2.6)
7. Windows — PowerShell-osnovan strežnik (`streznik-powershell.ps1`) kot obhod za primer, ko je tudi `python.exe` IT-blokiran — status: DONE, DELNO POTRJENO (strežnik se zažene, osnovna stran deluje), a OCR odpove — produced: commit `5d901d2` (v2.7)
8. Windows — utrditev PowerShell strežnika (pošiljanje velikih datotek po delih, brez keep-alive) — status: DONE v kodi, a ŠE NI POTRJENO ali odpravi dejansko napako na uporabnikovem računalniku (uporabnik je do zdaj samo PREDVIDEL enak izid, ni še dejansko ponovno testiral v2.8 — glej Open Questions) — produced: commit `3826994` (v2.8)
9. Diagnoza vzroka napake `importScripts`/`NetworkError` na velikem `.wasm.js` — status: V TEKU, NI RAZREŠENO — produced: (ta dokument), obsežni testi v razvojnem okolju (glej spodaj), ŠE NI produciral delujočega popravka

Overall progress: 8/9 korakov v tem loku dokončanih v kodi; ključni korak (9 — dejanska diagnoza in odprava OCR napake na resničnem IT-omejenem računalniku) OSTAJA NERAZREŠEN in je glavni fokus nadaljnjega dela.

---

## Kaj DOSLEJ NI DELOVALO (ključni namen tega dokumenta — bere se PRED poskušanjem novih pristopov)

### 1. Neposreden dvoklik na `index.html` (brez strežnika)
- NAPAKA: brskalnik (Chrome/Edge) blokira OCR Web Worker zaradi varnostne omejitve izvora `file://`.
- Status: NI in NE BO delovalo — to je znana, trajna omejitev brskalnika, ne napaka aplikacije. Ni predmet nadaljnjih poskusov.

### 2. `zazeni-windows.bat` (samodejni zaganjalnik, Python-osnovan)
- NAPAKA: "Pojavi se opozorilo Windows/IT politike in prepreči zagon" — IT politika (AppLocker/SRP) blokira izvajanje `.bat` SKRIPTNIH DATOTEK kot razred.
- Status: POTRJENO NE DELUJE na tem računalniku. Ni smiselno ponovno poskušati brez spremembe IT politike.

### 3. Ročni vpis `python -m http.server ...` neposredno v cmd/PowerShell (README obhod v2.6)
- NAPAKA: enako IT opozorilo kot pri `.bat`, tokrat ŠELE ob vpisu ukaza `python ...` (ne ob odprtju ukaznega okna).
- Diagnoza: IT politika blokira `python.exe` kot IZVRŠLJIV PROGRAM (EXE-pravilo), NE le skriptne datoteke. To je LOČEN mehanizem od točke 2.
- Diagnostični test uporabnika: `calc`/`notepad` delujeta, SAMO `python` je blokiran → potrjuje pravilo na ravni specifičnega programa, ne splošno.
- Status: POTRJENO NE DELUJE na tem računalniku. Kakršenkoli pristop, ki poskuša zagnati `python.exe` (v katerikoli obliki — .bat, ročen ukaz, drug ovojni skript), NE BO deloval na tem računalniku. NE poskušaj ponovno.

### 4. `streznik-powershell.ps1` v2.7 (prvotna PowerShell različica, en sam `ReadAllBytes()+Write()` na datoteko)
- Diagnostični test uporabnika PRED implementacijo: `[System.Net.HttpListener]::new()` v PowerShell oknu se izvede BREZ IT opozorila (zaslonsko potrjeno) → PowerShell + `System.Net.HttpListener` NISTA zajeta v isto IT EXE-pravilo kot `python.exe`.
- Realni test: strežnik SE JE uspešno zagnal na uporabnikovem računalniku (brez IT opozorila), osnovna aplikacija (`index.html`, `app.js`, `tesseract.min.js`) se je naložila BREZ napake.
- NAPAKA: ob dejanskem OCR pregledu: `NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'http://127.0.0.1:8934/assets/tesseract-core-simd-lstm.wasm.js' failed to load.` — DOSLEDNO, vsakič (uporabnik potrdil: "vsakič", ne občasno).
- POMEMBNO: ta napaka prizadene SAMO to eno, največjo datoteko (~3,9 MB) v projektu. Vse manjše datoteke (html, css, app.js, tesseract.min.js) se naložijo brez težav.
- Status: POTRJENO NE DELUJE za OCR funkcionalnost (osnovna stran DA, OCR NE).

### 5. Poskusi PONOVITVE napake v RAZVOJNEM OKOLJU (ta sandbox, Linux)
Cilj: ponoviti napako, da bi jo lahko zanesljivo popravili in preverili popravek pred vračanjem uporabniku.
- Prenesen realen PowerShell 7.4.6 (Linux x64 build) v peskovnik izključno za namen testiranja (orodje, NI del dobave uporabniku).
- Test A: 12 vzporednih `curl` zahtev za `tesseract-core-simd-lstm.wasm.js` proti izvorni (v2.7, sekvenčni) skripti → VSEH 12 uspešnih (HTTP 200), brez napak.
- Test B: resničen Playwright + Chromium brskalnik, dejanski klic `getWorker('fast', ['eng'])` (ista funkcija kot prava aplikacija) proti resničnemu, tekočemu PowerShell 7 strežniku (izvorna v2.7) → worker IN velika datoteka naložena BREZ napake `importScripts`/`NetworkError`.
- Test C: enak test, a s pravo veljavno PNG testno sliko ("Hello") in celotnim `worker.recognize()` klicem proti utrjeni (v2.8) skripti → CELOTEN OCR cikel uspešen, vrnjeno točno besedilo "Hello", BREZ ene same napake.
- SKLEP: napake v tem (Linux) razvojnem okolju NI BILO MOGOČE PONOVITI niti pri v2.7 niti pri v2.8 — kljub uporabi ISTE funkcije, ISTE velike datoteke in resničnega PowerShell 7 + resničnega brskalnika (Chromium). To pomeni, da je vzrok VERJETNO specifičen za: (a) uporabnikov konkreten Windows sistem (Windows PowerShell 5.1 namesto PowerShell 7, drugačna http.sys implementacija HttpListener-ja na Windows napram Linux .NET), in/ali (b) korporativno varnostno programsko opremo (EDR/protivirusni/proxy pregled prometa), ki v tem sandbox okolju ni prisotna in je ni mogoče simulirati.
- Status pristopa "utrditev strežnika" (chunked write, brez keep-alive, v2.8): implementirano in testirano V RAZVOJNEM OKOLJU USPEŠNO, a NI ŠE POTRJENO na uporabnikovem resničnem računalniku (glej Open Questions — uporabnik je za zdaj le PREDVIDEL, da bo napaka enaka, ni še dejansko pognal v2.8 na svojem računalniku).

---

## Files Affected

### Created
- `streznik-powershell.ps1` — alternativni lokalni HTTP strežnik v čistem PowerShell (`System.Net.HttpListener`), brez zagona kateregakoli `.exe` programa (obide IT EXE-blokado `python.exe`).
  - Glavna zanka: `while ($Listener.IsListening) { $Context = $Listener.GetContext(); ... }` — SEKVENČNA (enonitna), obdela eno zahtevo naenkrat, nato se vrne po naslednjo.
  - Serviranje datoteke (po popravku v2.8): odpre `FileStream`, bere in piše po 64 KB delih z eksplicitnim `.Flush()` po vsakem delu (namesto enega `ReadAllBytes()+Write()` klica), `$Response.KeepAlive = $false`, doda glavo `Cache-Control: no-store`.
  - Vsebuje mapiranje pripon → MIME tipov (`$ContentTypes` slovar) in osnovno zaščito pred izhodom iz korenske mape (`$FullPath.StartsWith($Root, ...)`).
- `docs/handoffs/HANDOFF_SLUZBENI_RACUNALNIK_WINDOWS_09_24.md` — ta dokument.

### Modified
- `README.txt` — dodana dva nova razdelka: "ČE JE IZVAJANJE .BAT/.COMMAND DATOTEK BLOKIRANO" (ročni cmd/PowerShell obhod s Pythonom, NEZADOSTEN če je tudi `python.exe` blokiran) in "ČE JE TUDI PYTHON.EXE BLOKIRAN (ALTERNATIVA BREZ PYTHONA)" (navodila za `streznik-powershell.ps1`, kopiranje vsebine neposredno v odprto PowerShell okno).
- `zazeni-macos.command` — dodan `-u` (unbuffered) flag, podaljšan timeout, Microsoft Edge-prednostno odpiranje (POTRJENO delujoče na realnem Macu).
- `zazeni-windows.bat` — enake spremembe po analogiji (NI testirano na realnem Windows — sam `.bat` se sploh ne zažene zaradi IT politike, glej točko 2 zgoraj).
- `HISTORY_AI_AGENT.txt` — poln, kronološki dnevnik vseh ugotovitev/popravkov/testov (obsežnejši od tega dokumenta, a manj "kaj NE poskušati znova" osredotočen).

### Read (Reference)
- `app.js` (funkcija `getWorker(profile, langs)`, vrstice ~502-518) — kliče `Tesseract.createWorker(langs.join('+'), 1, { workerPath, corePath: absAssetUrl('assets/tesseract-core-simd-lstm.wasm.js'), langPath, gzip: true, logger })` — točno ta `corePath` je datoteka, ki dosledno odpove na uporabnikovem računalniku.

---

## Technical Context

### Arhitektura
- Aplikacija je povsem statična (HTML/JS/CSS), OCR teče lokalno v brskalniku prek Tesseract.js 5.1.1 in WebAssembly (WASM), v Web Worker-ju (ločena nit, da OCR ne blokira uporabniškega vmesnika).
- Ker Web Worker v Chrome/Edge ne sme nalagati virov z `file://` izvora, aplikacija ZAHTEVA lokalen HTTP strežnik na `127.0.0.1` (poljuben, ni omrežnega dostopa navzven).
- Doslej PREIZKUŠENI strežniški mehanizmi: Python (`http.server`) — blokiran na tem računalniku; PowerShell (`System.Net.HttpListener`) — deluje za majhne datoteke, odpove za eno veliko (~3,9 MB) datoteko.

### Odvisnosti
- Tesseract.js 5.1.1 (vgrajen v `assets/`, ni omrežnega CDN klica).
- `streznik-powershell.ps1` je odvisen SAMO od vgrajenega .NET razreda `System.Net.HttpListener` — brez zunanjih modulov/paketov.

---

## Things to Know

### Gotchas & Pitfalls
- IT politika na tem računalniku ima VSAJ DVA LOČENA mehanizma blokade: (1) blokada IZVAJANJA `.bat`/`.ps1` SKRIPTNIH DATOTEK kot razreda, (2) blokada `python.exe` kot SPECIFIČNEGA IZVRŠLJIVEGA PROGRAMA. Ne mešaj ju — rešitev za enega ne rešuje drugega.
- Trenutna napaka (`importScripts`/`NetworkError`) je DOSLEDNA (100 %), NE občasna — kar govori PROTI naključnemu omrežnemu/EDR vmešavanju in BOLJ v prid deterministični razliki med Windows PowerShell/http.sys in Linux .NET (ali specifičnemu, ponovljivemu vedenju korporativnega varnostnega filtra za VSAKO tako veliko datoteko).
- Napaka prizadene SAMO največjo datoteko v projektu (~3,9 MB) — vse manjše datoteke delujejo. To je pomemben namig: možno je, da gre za prag velikosti (npr. DLP/vsebinski filter na določeno velikost odziva), NE za splošno nedelovanje strežnika.
- Testi v tem (Linux) razvojnem okolju NISO uspeli ponoviti napake niti pri PRVOTNI (v2.7) niti pri UTRJENI (v2.8) skripti — kar pomeni, da je vzrok VERJETNO specifičen za Windows/http.sys ali za korporativno varnostno programsko opremo, ki je v peskovniku ni mogoče simulirati. Nadaljnji razvojno-okoljski testi verjetno NE bodo dali novih spoznanj brez dodatnih podatkov z uporabnikovega računalnika.

### Assumptions Made
- Predvidevano (NI potrjeno): vzrok je korporativna varnostna programska oprema (EDR/protivirusni pregled prometa) ali DLP-podoben prag velikosti odziva.
- Predvidevano (NI potrjeno): uporabnikov računalnik uporablja Windows PowerShell 5.1 (privzeta različica na Windows 10/11) — RAZLIČNA implementacija `HttpListener` (http.sys) od PowerShell 7/.NET Core, uporabljenega za teste v tem razvojnem okolju (Linux, upravljan HttpListener brez http.sys).

### Known Issues
- `streznik-powershell.ps1` je ENONITEN (sekvenčen) — obdela eno HTTP zahtevo naenkrat. Za to aplikacijo (majhno število vzporednih zahtev) to v razvojnem okolju ni bilo ozko grlo, a ni bilo preizkušeno pod realno korporativno omrežno/varnostno obremenitvijo.
- `zazeni-windows.bat` (Python-osnovan samodejni zaganjalnik) na tem konkretnem računalniku NE MORE delovati (IT politika) — ni ga smiselno naprej popravljati ZA TA RAČUNALNIK (lahko ostane relevanten za DRUGE, manj omejene Windows računalnike, npr. uporabnikov osebni računalnik).

---

## Current State

### What's Working
- Osnovna aplikacija (nalaganje strani, brskanje po mapah, prikaz tabele) prek `streznik-powershell.ps1` na uporabnikovem službenem računalniku — DA.
- Isti strežniški pristop (PowerShell + `HttpListener`), vključno s CELOTNIM OCR ciklom (worker + WASM + prepoznava besedila) — DA, a SAMO v razvojnem okolju (Linux); NE na uporabnikovem računalniku.
- macOS zaganjalnik (`zazeni-macos.command`), vključno z Edge-odpiranjem — DA, POTRJENO na realnem Macu.

### What's Not Working
- OCR pregled na uporabnikovem službenem Windows računalniku prek `streznik-powershell.ps1` — NE, dosledno odpove pri nalaganju `tesseract-core-simd-lstm.wasm.js` (`NetworkError: importScripts`). Sum: EDR/DLP prag velikosti ALI razlika Windows PowerShell 5.1/http.sys napram testnemu okolju — NI POTRJENO.
- `zazeni-windows.bat` na tem računalniku — NE (IT politika, .bat blokada).
- Ročni `python -m http.server` obhod na tem računalniku — NE (IT politika, python.exe EXE-blokada).

### Tests
- [x] Ročno testiranje (uporabnik): osnovna PowerShell stran DA, OCR NE (v2.7, dosledno).
- [ ] Ročno testiranje uporabnika za v2.8 (utrjena skripta) — ŠE NI IZVEDENO (uporabnik je le predvidel enak izid, glej Open Questions).
- [x] Razvojno okolje (Linux, resničen PowerShell 7 + resničen Chromium): osnovno serviranje DA, velika datoteka DA (curl), worker+WASM nalaganje DA, poln OCR cikel DA (v2.8) — napake NI bilo mogoče ponoviti.

---

## Next Steps

### Immediate (Start Here)
1. **Pridobi od uporabnika DEJANSKO potrjen rezultat testa v2.8** (ne le predvidevanje) — poslati mu je bila že poslana `ocr-index-app-18.zip` / `streznik-powershell.ps1` (commit `3826994`, tag `v2.8`). Če je napaka enaka tudi pri v2.8, to POTRDI, da problem NI v enkratnem `ReadAllBytes()+Write()` vzorcu.
2. **Pridobi zavihek "Omrežje" (Network) iz razvijalskih orodij brskalnika** za natančno zahtevo `tesseract-core-simd-lstm.wasm.js` med OCR pregledom — status koda (200? 0? drugo?), velikost prejetega (koliko od 3,9 MB je dejansko prispelo?), čas trajanja. To je NAJPOMEMBNEJŠI manjkajoč podatek — screenshota Network zavihka doslej NISMO dobili (uporabnik je poslal Console/Styles zaslonske posnetke, ne Network).
3. **Predlagaj uporabniku enostaven ločen test**: neposredno v naslovno vrstico brskalnika (NE prek aplikacije) vpisati `http://127.0.0.1:8934/assets/tesseract-core-simd-lstm.wasm.js` in preveriti, ali se datoteka naloži/prenese SAMOSTOJNO, izven Worker konteksta. Če DA → problem je specifičen za Worker (`importScripts`) kontekst, NE za splošno serviranje datoteke. Če NE → strežnik/omrežje na splošno ne zmore te velikosti na tem računalniku.

### Subsequent
- Če se izkaže, da gre za prag velikosti (DLP/EDR): razmisliti o RAZDELITVI velike `tesseract-core-simd-lstm.wasm.js` datoteke na manjše dele s stran aplikacije (zahtevna sprememba, poseže v Tesseract.js nalaganje — visoko tveganje) ALI preveriti, ali obstaja manjša/druga različica WASM jedra (npr. brez SIMD, `tesseract-core-lstm.wasm.js` namesto `-simd-`) — če je manjša, je to hiter test brez poseganja v arhitekturo.
- Če se izkaže, da gre za Worker/CSP specifičnost: raziskati alternativo nalaganja WASM jedra (npr. `fetch()` + `WebAssembly.instantiate()` namesto `importScripts()`), kar bi zahtevalo spremembo TESSERACT.JS KONFIGURACIJE ali morda drugo verzijo knjižnice — večji poseg, SAMO če manjši popravki ne pomagajo.
- Preveriti z uporabnikom, ali IT oddelek beleži/blokira karkoli ob času napake (Windows Defender/CrowdStrike dnevnik) — to bi dokončno potrdilo/ovrglo EDR domnevo.

### Blocked On
- Manjkajoč Network-zavihek podatek (status/velikost/čas za neuspelo zahtevo) — brez tega je nadaljnja diagnoza ugibanje.
- Uporabnikov dejanski (ne predviden) test v2.8.

---

## Related Resources

### Commands to Run
```bash
# Sintaksa in lokalen test streznik-powershell.ps1 (v tem razvojnem okolju, Linux):
cd /tmp/claude-0/-home-claude/00142b1a-3608-536c-9608-15beef4de2c9/scratchpad/app/ocr-index-app
/tmp/pwsh/pwsh -NoProfile -File streznik-powershell.ps1 &
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" http://127.0.0.1:8934/assets/tesseract-core-simd-lstm.wasm.js

# Pravi OCR test prek Playwright (worker + WASM + recognize):
node /tmp/claude-0/-home-claude/00142b1a-3608-536c-9608-15beef4de2c9/scratchpad/test_worker_full.js
```

### Search Queries
- `grep -n "corePath\|workerPath\|getWorker" app.js` — najde natančno mesto, kjer aplikacija zahteva veliko WASM datoteko.
- `grep -rn "tesseract-core" assets/` — najde vse različice WASM jedra (SIMD/ne-SIMD), če obstajajo alternative manjše velikosti.

---

## Open Questions — RAZREŠENO (2026-09-24, kasneje isti dan)

STATUS: PROBLEM ODPRAVLJEN. Uporabnik je mapo aplikacije razpakiral na SVEŽO lokacijo (izven prejšnje OneDrive poti) — PowerShell strežnik (v2.8) + ročen vpis README URL v brskalnik zdaj DELUJE ZANESLJIVO, vključno s pravim OCR pregledom 10.000 slik.

Najverjetnejši (a formalno NE dokazan z ikonami/napredkom, ker uporabnik ni potrdil te podrobnosti) vzrok: OneDrive "Files On-Demand" na PREJŠNJI lokaciji mape (znotraj "OneDrive - Novartis Pharma AG") — velike datoteke (wasm.js, *.traineddata.gz) niso bile dosledno v celoti prenesene lokalno, medtem ko so majhne datoteke vedno bile. To se ujema z VSEMI opaženimi simptomi (glej HISTORY_AI_AGENT.txt, razdelek "RAZREŠENO" z istim datumom) in s tem, da napake ni bilo mogoče ponoviti v sandbox okolju (brez OneDrive).

Prejšnja vprašanja (spodaj) so s tem PRESEŽENA — nadaljnje sandbox testiranje/ugibanje o EDR/http.sys NI VEČ POTREBNO, razen če se napaka na drugem računalniku/mapi ponovi:
- ~~Je bila v2.8 skripta dejansko pognana~~ — DA, potrjeno.
- ~~Network zavihek status/velikost~~ — pridobljeno (404, "text/plain", ustreza naši lastni "datoteka ni najdena" napaki) — to je bil KLJUČNI namig, ki je pripeljal do prave diagnoze (napaka je bila na STREŽNIŠKI/DISK strani, ne omrežni).
- ~~Neposreden URL dostop~~ — pridobljeno, potrdilo isto (404 tudi tam).
- Manjša WASM različica / EDR dnevnik — NI VEČ RELEVANTNO glede na potrjen vzrok.

NASLEDNJIM AGENTOM: če se ista napaka pojavi na DRUGI mapi/računalniku, najprej preveri, ali je mapa znotraj cloud-sync poti (OneDrive/Google Drive/Dropbox), PREDEN se lotiš kode.

---

## Session Notes

Uporabnik je izrecno zahteval (24.9.2026), naj se ta dokument vodi SPROTI in NAJ SE V NJEM BELEŽI, KAJ DOSLEJ NI DELOVALO IN KJE SO SE NAPAKE POJAVLJALE — namen je preprečiti, da bi prihodnja seja (ali ta ista) po nepotrebnem ponovno poskušala že ovržene pristope (Python v katerikoli obliki, `.bat` zaganjalnik na tem računalniku). Ta dokument je zato zgrajen tako, da razdelek "Kaj DOSLEJ NI DELOVALO" pride PRED "Next Steps" — bralec naj ga prebere najprej.

Ta dokument NE nadomešča `HISTORY_AI_AGENT.txt` (ki ostaja polni kronološki dnevnik za dokumentacijske namene uporabnika/README) — dopolnjuje ga s strnjenim, akcijsko usmerjenim pogledom "kaj poskusiti naslednjič / česa ne poskušati več".

---

_Ta dokument je bil ustvarjen na eksplicitno zahtevo uporabnika za sprotno vodenje, NE ob limitu konteksta. Naslednja seja/nadaljevanje naj ga POSODOBI (dopolni z novimi ugotovitvami), ne prepiše na novo._
