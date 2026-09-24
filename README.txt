OCR Iskalnik slik (OCR Image Search) — navodila
================================================

KAJ JE TO
---------
Samostojna aplikacija za iskanje besedila znotraj slikovnih datotek (npr. posnetkov
zaslona). Deluje kot Everything (hitro iskanje po imenih datotek, napredna sintaksa
iskanja), dodatno pa z OCR (optičnim prepoznavanjem besedila) prebere in indeksira
tudi besedilo, ki je vidno NA sliki — podobno kot AnyTXT Searcher, a brez namestitve.

Vse potrebno (OCR mehanizem in jezikovni podatki za angleščino in slovenščino) je
že priloženo v mapi "assets" — internetna povezava po prvem prenosu ni potrebna.

Kratek video prikaz uporabe (animirana .gif slika) je na voljo kot LOČENA datoteka
"ocr-index-app-demo.gif" (ni del te mape/tega arhiva, da mapa ostane majhna za
prenos) — prikazuje orodno vrstico, iskanje, "Možnosti iskanja", "Pomoč" in gumb
"Dnevnik". Prikazani posnetki zaslona v videu so IZMIŠLJENI vzorčni primeri
(zaradi predstavitve), ne dejanski rezultat OCR na resničnih slikah.

ALI POTREBUJEM SKRBNIŠKE (ADMINISTRATORSKE) PRAVICE V WINDOWS?
----------------------------------------------------------------
Ne. Aplikacija ni namestitveni program (.exe, .msi) — je samo mapa z datotekami
(HTML/JavaScript), ki jo odpre že nameščen brskalnik. Ne piše v register, ne
namešča gonilnikov in ne zahteva zagona "kot skrbnik". Deluje enako kot odpiranje
katerekoli druge spletne strani ali dokumenta v brskalniku, torej tudi z navadnim
(ne-skrbniškim) uporabniškim računom. Edina mesta, kamor aplikacija sploh piše, so:
lokalna podatkovna baza brskalnika (za "Odpri zadnjo mapo") in datoteka
"ocr-index.json" znotraj mape, ki jo sami izberete za pregled — oboje brez potrebe
po dovoljenjih na ravni operacijskega sistema.
Edina realna omejitev je, če IT-politika podjetja v brskalniku izrecno onemogoči
dostop do datotečnega sistema (File System Access API) — to pa je nastavitev
brskalnika/IT-politike, ne aplikacije same.

POMEMBNO (dodano 2026-09-22, po QA testiranju): priložena zaganjalnika
("zazeni-windows.bat"/"zazeni-macos.command", glej "KAKO ZAGNATI" spodaj) prav
tako NE zahtevata namestitve ne skrbniških pravic — poženeta le majhen lokalen
strežnik (vgrajen v že nameščen Python), dostopen IZKLJUČNO iz tega računalnika
(naslov 127.0.0.1, brez dostopa od zunaj/po omrežju), enakovredno odpiranju
katerekoli druge datoteke.

ZAHTEVE
-------
- Windows (primarna platforma), deluje pa povsod, kjer teče ustrezen brskalnik.
- Brskalnik Google Chrome ali Microsoft Edge (novejša različica).
  Firefox in Safari NE podpirata potrebnega API-ja za dostop do map (File System
  Access API) in aplikacija v njiju ne bo delovala.
- Nameščen Python 3 (za priložena zaganjalnika, glej spodaj) — na macOS je
  praviloma že na voljo; na Windows ga po potrebi namestite z
  https://www.python.org/downloads/windows/ (pri namestitvi obkljukajte
  "Add python.exe to PATH"). Če Python ni najden, vas zaganjalnik na to jasno
  opozori z navodilom.

KAKO ZAGNATI
------------
POMEMBNO (spremenjeno 2026-09-22, po QA testiranju — glej HISTORY_AI_AGENT.txt):
aplikacije NE odpirajte več z neposrednim dvoklikom na "index.html" — v
brskalnikih Chrome/Edge to zaradi njihove varnostne omejitve pri nalaganju
datotek iz Worker-ja PREPREČI delovanje OCR-ja (iskanje po imenu/poti datotek bi
sicer še delovalo, OCR indeksiranje vsebine pa ne zanesljivo). Namesto tega:

1. Celotno mapo "ocr-index-app" prenesite na računalnik (lahko tudi na USB ključek).
   Pomembno: datoteka index.html, mapa "assets" IN oba zaganjalnika morajo ostati
   SKUPAJ, v isti mapi.
2. Dvokliknite ustrezen zaganjalnik za svoj operacijski sistem:
   - Windows: "zazeni-windows.bat"
   - macOS:   "zazeni-macos.command"
   (Če macOS ob prvem zagonu prikaže opozorilo "neznan razvijalec": v Finderju
   desni klik na datoteko → Odpri → potrdite "Odpri".)
   Zaganjalnik požene majhen lokalen strežnik (samo za ta računalnik, brez
   dostopa od zunaj) in samodejno odpre aplikacijo v privzetem brskalniku na
   naslovu oblike http://127.0.0.1:<vrata>/. Okno, ki se ob tem odpre (Terminal
   na macOS / ukazno okno na Windows), pustite odprto, dokler uporabljate
   aplikacijo — v njem teče strežnik; ob zaprtju se strežnik samodejno ustavi.
   Če aplikacijo kljub temu (npr. iz starejše različice mape) odprete z
   neposrednim dvoklikom na index.html, vas na to opozori tako vrstica stanja
   kot vnos v "Dnevnik" (glej razdelek "ČE KAJ NE DELUJE" spodaj).
3. Kliknite "Izberi mapo…" in izberite mapo s posnetki zaslona.
   Brskalnik bo vprašal za dovoljenje za branje/pisanje v to mapo — potrdite.
4. Aplikacija bo poiskala vse slike (.jpg, .jpeg, .png, .bmp, .gif, .webp, .tif,
   .tiff), jih po vrsti obdelala z OCR-jem (privzeto v hitrem načinu) in prikazala
   v tabeli. Pri velikem številu slik lahko prvo indeksiranje traja dlje časa
   (glejte vrstico napredka).
5. V iskalno polje vpišite besedo ali uporabite napredno sintakso (glejte spodaj).
   Ujemanje je v tabeli obarvano.
6. Dvoklik na vrstico (ali gumb "Odpri") odpre sliko v novem zavihku brskalnika.

ČE JE IZVAJANJE .BAT/.COMMAND DATOTEK BLOKIRANO (IT POLITIKA SLUŽBENEGA
RAČUNALNIKA)
------------------------------------------------------------------------
Na nekaterih službenih (IT-upravljanih) računalnikih varnostna politika
podjetja (npr. AppLocker/Software Restriction Policy na Windows) na splošno
prepreči IZVAJANJE skriptnih datotek (.bat, .ps1, .command ipd.) — to NI
napaka te aplikacije, ampak nastavitev vašega računalnika, ki jo upravlja IT
oddelek. Prepoznate jo po tem, da se ob dvokliku na "zazeni-windows.bat"
prikaže opozorilo, da je izvajanje te vrste datotek blokirano s politiko
podjetja.

V tem primeru lahko strežnik zaženete ROČNO, brez izvajanja skriptne
datoteke — z vpisovanjem ukazov neposredno v že odprto ukazno okno (to
politike, ki blokirajo izvajanje SKRIPTNIH DATOTEK, navadno NE preprečijo,
ker gre za uporabo že dovoljenega programa "cmd.exe", ne za zagon nove
datoteke):

1. Odprite ukazno vrstico (Command Prompt): v iskanje v opravilni vrstici
   Windows vtipkajte "cmd" in pritisnite Enter (ali PowerShell, če je cmd.exe
   prav tako blokiran — ukazi spodaj delujejo v obeh).
2. V ukazno okno prekopirajte spodnja DVA ukaza, enega za drugim (namesto poti
   spodaj vstavite DEJANSKO pot do mape z aplikacijo na vašem računalniku —
   dobite jo tako, da v Raziskovalcu odprete to mapo in kliknete na naslovno
   vrstico, da se izpiše polna pot):
   ```
   cd "C:\pot\do\mape\ocr-index-app"
   python -m http.server 8934 --bind 127.0.0.1
   ```
   (Če ukaz "python" javi napako "ni prepoznan", poskusite namesto njega
   "python3" ali "py -3".) Okno bo izpisalo nekaj podobnega "Serving HTTP on
   127.0.0.1 port 8934 ..." — TO OKNO PUSTITE ODPRTO (v njem teče strežnik).

   POMEMBNO: na nekaterih strožje upravljanih računalnikih IT politika ne
   blokira le izvajanja SKRIPTNIH DATOTEK (.bat/.ps1), temveč tudi neposreden
   zagon samega programa "python.exe" — ne glede na to, ali ga zaženete iz
   .bat datoteke ali ročno vtipkanega ukaza (potrjeno na resničnem primeru,
   glej HISTORY_AI_AGENT.txt). Prepoznate to po tem, da se ob vpisu zgornjega
   ukaza "python -m http.server ..." prikaže IT opozorilo. V tem primeru
   uporabite spodnji razdelek "ČE JE TUDI PYTHON.EXE BLOKIRAN (ALTERNATIVA
   BREZ PYTHONA)" namesto nadaljevanja korakov spodaj.
3. Odprite Microsoft Edge (ali kateri koli brskalnik) in v naslovno vrstico
   vpišite:
   ```
   http://127.0.0.1:8934/index.html
   ```
   Če je vrata 8934 na vašem računalniku že zasedena (redko), boste dobili
   napako "Address already in use" — v tem primeru v 2. koraku zamenjajte
   "8934" s poljubno drugo številko (npr. 8935) in enako številko uporabite
   tudi v naslovu brskalnika v 3. koraku.
4. Ko končate z uporabo aplikacije, se vrnite v ukazno okno iz 2. koraka in
   pritisnite Ctrl+C, da ustavite strežnik (ali preprosto zaprite okno).

Ta način zahteva enak korak vsakič znova ob novem zagonu računalnika/seje
(zaganjalnik "zazeni-windows.bat" bi sicer to naredil samodejno z enim
dvoklikom) — je pa edini znani obhod za računalnike, kjer IT politika
onemogoča izvajanje skriptnih datotek.

ČE JE TUDI PYTHON.EXE BLOKIRAN (ALTERNATIVA BREZ PYTHONA)
------------------------------------------------------------------------
Če vam IT politika prepreči tudi zagon samega "python.exe" (glej opozorilo
zgoraj), lahko namesto Pythona za lokalni strežnik uporabite PowerShell, ki
je na Windows računalnikih praviloma že dovoljen program in ni bil ob tem
odkrit kot blokiran (potrjeno na resničnem primeru). Ta način NE zažene
nobenega novega .exe programa — vsa logika teče znotraj že odprtega
PowerShell okna prek vgrajenega .NET razreda "System.Net.HttpListener".

1. Odprite PowerShell: v iskanje v opravilni vrstici Windows vtipkajte
   "PowerShell" in pritisnite Enter.
2. V PowerShell okno prekopirajte spodnji ukaz, ki premakne trenutno mapo na
   mapo z aplikacijo (namesto poti spodaj vstavite DEJANSKO pot do mape z
   aplikacijo na vašem računalniku):
   ```
   cd "C:\pot\do\mape\ocr-index-app"
   ```
3. Nato v isto okno prilepite CELOTNO vsebino priložene datoteke
   "streznik-powershell.ps1" (odprite jo v Beležnici/Notepad, izberite vso
   vsebino s Ctrl+A, kopirajte s Ctrl+C, nato jo prilepite v PowerShell okno
   in pritisnite Enter). NE zaganjajte te datoteke z dvoklikom niti z ukazom
   ".\streznik-powershell.ps1" — samo prilepite njeno vsebino neposredno v
   okno, da se izognete morebitni ločeni politiki o izvajanju .ps1 datotek.
   Okno bo izpisalo "Lokalni streznik (PowerShell, brez Pythona) tece na:
   http://127.0.0.1:8934/index.html" — TO OKNO PUSTITE ODPRTO.
4. Odprite Microsoft Edge (ali kateri koli brskalnik) in v naslovno vrstico
   vpišite:
   ```
   http://127.0.0.1:8934/index.html
   ```
   Če je vrata 8934 na vašem računalniku že zasedena (redko), boste dobili
   napako ob 3. koraku — v tem primeru na vrhu datoteke
   "streznik-powershell.ps1" spremenite vrstico "$Port = 8934" na drugo
   številko (npr. 8935), ponovite 3. korak in enako številko uporabite tudi
   v naslovu brskalnika v 4. koraku.
5. Ko končate z uporabo aplikacije, se vrnite v PowerShell okno iz 3. koraka
   in pritisnite Ctrl+C, da ustavite strežnik (ali preprosto zaprite okno).

Ta način je bil dejansko preizkušen (postrežba index.html, app.js in
odgovor 404 za neobstoječo datoteko) v razvojnem okolju, NI PA ŠE bil
preizkušen na resničnem IT-upravljanem Windows računalniku v celoti (torej
z dejanskim odpiranjem strani v brskalniku in izvedbo OCR pregleda) — glej
odprto točko v HISTORY_AI_AGENT.txt.

OCR KAKOVOST: HITRO PROTI NATANČNO
------------------------------------
Privzeto je vklopljen način "Hitro" — uporablja manjši, hitrejši OCR model, tako da
je prvo indeksiranje čim hitrejše (primerno za takojšen pregled velikih map).
Če je besedilo na določeni sliki drobno, zamegljeno ali slabo prepoznano:
- V vrstici te slike v stolpcu "Dejanja" kliknite gumb "Natančno". Aplikacija bo
  SAMO to sliko znova prebrala z natančnejšim (počasnejšim) modelom in dodatno
  izboljšano (povečano, kontrastno) različico slike ter posodobila indeks.
- Če pričakujete, da bo večina slik zahtevnih (npr. cela mapa drobnih posnetkov
  uporabniškega vmesnika), lahko v orodni vrstici razdelek "OCR: Hitro/Natančno"
  preklopite na "Natančno" PRED klikom na "Ponovno preglej" — takrat bo natančen
  način uporabljen za vse nove/spremenjene slike v tem pregledu (počasneje).
Katera različica je bila uporabljena za posamezno sliko, je vedno vidno v stolpcu
"Status" (oznaka "hitro" ali "natančno").
V internem testu je natančen način na zamegljeni/nizko-kontrastni sliki popravil
napačno prepoznan znak, ki ga je hitri način izpustil/popačil — razlika je torej
resnična, ne le teoretična, čeprav pri jasnih, ostrih posnetkih zaslona najverjetneje
ne boste opazili razlike.

ISKALNA SINTAKSA (podobno programu Everything)
------------------------------------------------
Iskalno polje podpira preprosto besedilo IN naslednjo napredno sintakso. Gumb
"Pomoč ?" v orodni vrstici odpre popoln seznam vseh možnosti s praktičnim
primerom pod vsako — najhitrejša pot do polne sintakse je ta gumb.

  presledek           = IN (AND) — vsi izrazi morajo ustrezati
  |                    = ALI (OR) — kateri koli od izrazov
  !izraz               = IZLOČI (NOT) — vrstice s tem izrazom se skrijejo
  "natančna fraza"     = dobesedno ujemanje (brez nadomestnih znakov)
  "podmapa/pot"  ali  podmapa/pot (brez narekovajev)
                       = RELATIVNA POT mape/datoteke znotraj izbrane mape — kadar
                         izraz vsebuje "/" ali "\", se samodejno išče v celotni
                         relativni poti, enako kot vpis poti v Everything.
                         Poševnica naprej (/) in nazaj (\) delujeta enako.
  *  in  ?             = nadomestna znaka (wildcard): * = poljubno zaporedje, ? = en znak
  .pdf  (ali katera koli druga končnica z vodilno piko)
                       = hitra bližnjica: išče ".pdf" kot besedilo v imenu/poti/vsebini,
                         enako kot v Everything ("relativna pot" .pdf primer spodaj)
  ext:png;jpg          = natančen filter SAMO po dejanski končnici datoteke
  path:mapa            = ujemanje v poti/podmapi (enako kot narekovaji s "/")
  name:izraz           = ujemanje samo v imenu datoteke
  content:izraz  /  ocr:izraz   = ujemanje samo v besedilu, prebranem z OCR
  size:>1mb  size:<500kb  size:100kb-2mb   = filter po velikosti datoteke
  dm:today  dm:yesterday  dm:thisweek  dm:thismonth  dm:thisyear
  dm:2024  dm:2024-06  dm:2024-06-15  dm:>2024-01-01   = filter po datumu spremembe

Primer (natanko kot v vprašanju o Everything): iskalni niz
  "projekti/2024" .pdf
najde vse .pdf datoteke, katerih relativna pot vsebuje "projekti/2024".

Drug primer: "screenshot ext:png !budget dm:thisweek" najde png slike s
"screenshot" v imenu/poti/vsebini, ki NE vsebujejo "budget" in so bile
spremenjene ta teden.

Gumb "Možnosti iskanja" odpre dodatne nastavitve:
- Ločevanje velikih/malih črk, ujemanje cele besede, način regularnega izraza (regex).
- Kje se iščejo navadni izrazi brez predpone: ime datoteke, pot/mapa in/ali vsebina
  (OCR besedilo) — polja lahko posamično izklopite.
- Zasebnost — "ne shranjuj OCR besedila na disk (samo v pomnilnik)": če je ta
  kljukica VKLOPLJENA, se prebrano besedilo NE zapiše v datoteko "ocr-index.json"
  (v njej ostane samo prazno polje z oznako, da je besedilo izpuščeno). Iskanje po
  vsebini v ISTI seji/zavihku deluje naprej nemoteno, ker besedilo ostane v
  pomnilniku brskalnika, dokler je zavihek odprt. Ob naslednjem odpiranju iste mape
  (nov zagon brskalnika) besedila iz prejšnje seje ne bo — aplikacija bo za te
  slike ponovno pognala OCR. Če kljukico pozneje izklopite in kliknete "Ponovno
  preglej", aplikacija samodejno znova prebere in tokrat tudi dejansko shrani
  besedilo za slike, ki so bile prej shranjene brez njega ("dopolnitev za nazaj").
Opomba: znak "|" se v iskalnem polju vedno obnaša kot ločilo ALI (OR) med izrazi,
tudi kadar je vklopljen način regex — za alternacijo znotraj enega regularnega
izraza uporabite npr. skupino v oklepaju s piko namesto "|" na najvišji ravni, ali
pa napišite dva ločena izraza in ju povežite z "|" na način te aplikacije.

PONOVNO ODPIRANJE IN POSODABLJANJE
-----------------------------------
- Indeks se shrani nazaj v izbrano mapo kot datoteka "ocr-index.json". Ob
  naslednjem odpiranju iste mape se ta datoteka samodejno prebere, zato
  prejšnjega OCR dela ni treba ponavljati.
- Gumb "Odpri zadnjo mapo" ponudi bližnjico do nazadnje uporabljene mape (brskalnik
  bo vseeno ponovno vprašal za dovoljenje — to je varnostna zahteva brskalnika,
  ne napaka aplikacije).
- Gumb "Ponovno preglej" ponovno pregleda mapo in obdela SAMO nove ali
  spremenjene slike (primerja velikost in datum spremembe) — obstoječih
  nespremenjenih slik (vključno s tistimi, obdelanimi v načinu "Natančno") ne
  obdeluje znova, razen če se je datoteka dejansko spremenila.
- Aplikacija NE zaznava sprememb v mapi samodejno v ozadju (npr. med tem, ko je
  zaprta ali ko ni odprt zavihek). Za zajem novih posnetkov zaslona je treba
  ročno pritisniti "Ponovno preglej".

ČE KAJ NE DELUJE: GUMB "DNEVNIK"
----------------------------------
V orodni vrstici je gumb "Dnevnik" (ob morebitni napaki se ob njem prikaže
majhna rdeča številka). Odpre seznam zabeleženih dogodkov in napak iz
trenutne seje (velja samo za odprt zavihek — ob zaprtju/osvežitvi strani se
izbriše). Če kaj ne deluje pričakovano:
1. Kliknite "Dnevnik".
2. Kliknite "Izvozi (.txt)" — prenese se datoteka
   "ocr-index-app-dnevnik-<datum-čas>.txt".
3. To datoteko pošljite osebi/AI agentu, ki je aplikacijo izdelal ali jo
   vzdržuje, skupaj z opisom, kaj ste počeli, preden je prišlo do težave.
Dnevnik ne vpliva na delovanje aplikacije niti se ne shranjuje trajno nikamor
(ne v ocr-index.json, ne drugam) — je samo v pomnilniku odprtega zavihka.

Dodano 2026-09-22: če je aplikacija odprta neposredno prek file:// (torej mimo
zaganjalnika — glej opozorilo v "KAKO ZAGNATI" zgoraj), se ob zagonu samodejno
zapiše opozorilo v ta dnevnik in v vrstico stanja. Prav tako, če se nalaganje OCR
mehanizma ne konča v 20 sekundah (kar se lahko zgodi prav zaradi zgornje težave
s file://), se izpiše jasna napaka s časovno omejitvijo namesto da bi vrstica
napredka obtičala brez sledi.

OMEJITVE, KI JIH JE DOBRO POZNATI
----------------------------------
- Natančnost OCR je odvisna od kakovosti besedila na sliki. Jasno, veliko tipkano
  besedilo se prebere zelo zanesljivo; drobno, zamegljeno ali nizko-kontrastno
  besedilo lahko zmanjša natančnost — za take primere uporabite način "Natančno".
- Prvo indeksiranje večjega števila slik lahko traja dlje časa (približno
  1-5 sekund na sliko v hitrem načinu, dlje v natančnem načinu zaradi predobdelave
  slike in počasnejšega modela — odvisno od velikosti slike in zmogljivosti računalnika).
- Aplikacija ne uporablja Windows iskalnega indeksa niti NTFS-ja neposredno,
  zato je hitrost prvega pregleda mape odvisna od brskalnika, ne od diska.
- Trenutno sta na voljo dva jezika OCR: angleščina (ENG) in slovenščina (SLV).
  Privzeto je vklopljena samo angleščina (ENG); slovenščino (SLV) lahko ročno
  vklopite s kljukico v orodni vrstici, če besedilo na slikah vsebuje slovenščino
  (dodaten jezik nekoliko upočasni OCR).

LICENCE VGRAJENIH KNJIŽNIC
--------------------------
Ta aplikacija vključuje naslednje odprtokodne knjižnice in podatke tretjih
oseb (v mapi assets/):
- Tesseract.js (OCR mehanizem) — licenca Apache License 2.0
- tessdata (jezikovni modeli za OCR, eng/slv) — licenca Apache License 2.0
Ti deli NISO avtorsko delo tega projekta — so vključeni nespremenjeni kot
odvisnosti. Ta opomba je za red v lastni dokumentaciji (ta repozitorij je
zaseben, ni namenjen javni distribuciji).

STRUKTURA MAPE
---------------
ocr-index-app/
  zazeni-windows.bat   <- na Windows: to dvokliknite za zagon (glej "KAKO ZAGNATI")
  zazeni-macos.command <- na macOS: to dvokliknite za zagon (glej "KAKO ZAGNATI")
  index.html          <- NE odpirajte neposredno (glej "KAKO ZAGNATI") — odpre in
                          uporabi ga zaganjalnik zgoraj
  app.js              <- programska logika
  README.txt          <- ta datoteka
  HISTORY_AI_AGENT.txt <- tehnična zgodovina projekta za razvijalca/AI agenta
                          (ni potrebna za običajno uporabo)
  assets/
    tesseract.min.js
    worker.min.js
    tesseract-core-simd-lstm.wasm(.js)
    tessdata/
      fast/       eng.traineddata.gz, slv.traineddata.gz       (hiter OCR model)
      accurate/   eng.traineddata.gz, slv.traineddata.gz       (natančen OCR model)
