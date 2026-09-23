@echo off
setlocal enabledelayedexpansion
rem Zaganjalnik za Windows (Popravek A, QA krog 2026-09-22 - glej HISTORY_AI_AGENT.txt).
rem Namesto neposrednega dvoklika na index.html (kar v Chrome/Edge blokira OCR worker zaradi
rem varnostne omejitve file:// izvora) ta skripta pozene majhen lokalen streznik na 127.0.0.1
rem (dostopen SAMO iz tega racunalnika) in samodejno odpre aplikacijo v privzetem brskalniku.
rem
rem POPRAVEK (2026-09-22, DRUGA ITERACIJA): na macOS je bilo DEJANSKO POTRJENO (glej
rem HISTORY_AI_AGENT.txt), da "ukaz obstaja" (where/command -v) NI dovolj - vgrajen macOS
rem "python3" brez namescenih Xcode Command Line Tools "obstaja", a ob zagonu ne naredi nic
rem uporabnega. Windows ima ZELO PODOBNO past: ce Python ni resnicno namescen, "python"/"python3"
rem v ukaznem oknu lahko kaze na t.i. "App Execution Alias" (Microsoft Store zacetnik), ki ob
rem klicu samo odpre Microsoft Store namesto da bi zagnal Python - "where python" ga kljub temu
rem najde. Zato ta skripta (enako kot macOS razlicica) DEJANSKO POSKUSI pognati streznik z vsakim
rem kandidatom po vrsti in sele ob neuspehu VSEH pokaze napako.
rem OPOZORILO ZA NASLEDNJEGA AGENTA/RAZVIJALCA: ta skripta v tem okolju (Linux, brez cmd.exe) NI
rem bila dejansko izvedena/testirana - je analizirana in napisana po znanih vzorcih, po analogiji
rem z resnicno potrjenim popravkom na macOS. Priporocljivo je preveriti na resnicnem Windows
rem racunalniku pred prvo pravo uporabo (glej odprto tocko v HISTORY_AI_AGENT.txt).
rem
rem POPRAVEK (2026-09-23, TRETJA ITERACIJA, PO ANALOGIJI - glej HISTORY_AI_AGENT.txt): na macOS je
rem bilo DEJANSKO POTRJENO, da se python3 lahko dejansko zazene (proces zivi), a v presmerjeno
rem datoteko ne zapise sporocila "Serving HTTP..." dovolj hitro - najverjetneje zaradi blocnega
rem (ne vrsticnega) predpomnjenja izhoda ob preusmeritvi v datoteko namesto v terminal. Zastavica
rem "-u" (spodaj) prisili Python v NEPREDPOMNJEN izpis, kar to tveganje odpravi tudi tu - ta
rem popravek na Windows NI bil se dejansko testiran (ni cmd.exe v tem okolju), a je zastavica "-u"
rem standardna in neskodljiva, zato jo dodajamo preventivno po analogiji z dokazanim macOS popravkom.

cd /d "%~dp0"

set "PORT="
set "WORKING_CMD="

call :try_candidate python
if defined PORT goto gotport
call :try_candidate "py -3"
if defined PORT goto gotport

echo NAPAKA: Lokalnega streznika ni bilo mogoce zagnati z nobenim najdenim ukazom (python/py -3).
echo.
echo Mozni vzrok: "python" v tem oknu kaze na Microsoft Store namesto na resnicno namescen
echo Python (pogosta past na Windows - t.i. "App execution alias"). Ce se ob vnosu "python" v
echo ukazno vrstico odpre Microsoft Store, je to potrjen vzrok.
echo.
echo RESITEV: namestite Python 3 NEPOSREDNO s te povezave (izberite "Windows installer"):
echo   https://www.python.org/downloads/windows/
echo Pri namestitvi OBVEZNO obkljukajte "Add python.exe to PATH". Po namestitvi to datoteko
echo znova zazenite. Ce se je prej odpiral Microsoft Store, lahko dodatno onemogocite alias
echo prek: Nastavitve Windows -> Aplikacije -> Napredne nastavitve aplikacij -> Alias izvajanja
echo aplikacij -> izklopite "python.exe"/"python3.exe".
pause
exit /b 1

:gotport
set "URL=http://127.0.0.1:%PORT%/index.html"
echo Lokalni streznik tece na: %URL%
rem Popravek (2026-09-23, na uporabnikovo zeljo - glej HISTORY_AI_AGENT.txt, PO ANALOGIJI z macOS
rem popravkom - NA PRAVEM WINDOWS SE NI BILO TESTIRANO, glej opozorilo na vrhu te datoteke): namesto
rem odpiranja v PRIVZETEM brskalniku najprej poskusimo neposredno v Microsoft Edge. "where msedge"
rem preveri, ali je msedge.exe najdljiv (PATH ali t.i. "App Paths" registrski vnos, kamor ga namesti
rem privzeta namestitev Edge na Windows 10/11) - ce ni najden, se varno vrnemo na prejsnje vedenje
rem (odpri v privzetem brskalniku), da uporabnik brez Edge-a se vedno dobi delujočo aplikacijo.
where msedge >nul 2>nul
if %errorlevel%==0 (
    start "" msedge "%URL%"
) else (
    echo (Microsoft Edge ni bil najden - odpiram v privzetem brskalniku namesto tega.)
    start "" "%URL%"
)
echo.
echo To okno lahko zaprete - streznik bo v ozadju tekel v svojem oknu ("OCR Iskalnik slik - streznik %WORKING_CMD%").
echo Ko koncate z uporabo aplikacije, zaprite TISTO okno, da ustavite streznik.
pause
exit /b 0

:try_candidate
set "CAND=%~1"
set "LOGFILE=%TEMP%\ocr-index-app-server-%RANDOM%.log"
start "OCR Iskalnik slik - streznik %CAND%" /min cmd /c "%CAND% -u -m http.server 0 --bind 127.0.0.1 > "%LOGFILE%" 2>&1"
set "FOUNDPORT="
set /a TRIES=0
:waitport_sub
if defined FOUNDPORT goto sub_done
set /a TRIES+=1
if %TRIES% GTR 50 goto sub_done
rem "ping" namesto "timeout.exe" za kratek premor (~1s) - zanesljivejse v necinteraktivnem/
rem preusmerjenem oknu, kjer se je izkazalo, da timeout.exe lahko sam odpove (isti razred
rem tveganja kot "ukaz obstaja, a ne deluje", zato se mu tu namenoma izognemo).
ping -n 2 127.0.0.1 >nul 2>nul
for /f "tokens=2 delims=: " %%P in ('findstr /r "port [0-9]*" "%LOGFILE%" 2^>nul') do set "FOUNDPORT=%%P"
goto waitport_sub

:sub_done
if defined FOUNDPORT (
    set "PORT=%FOUNDPORT%"
    set "WORKING_CMD=%CAND%"
) else (
    echo (poskus z ukazom '%CAND%' ni uspel - glej %LOGFILE% za podrobnosti, ce se napaka ponovi)
)
exit /b 0
