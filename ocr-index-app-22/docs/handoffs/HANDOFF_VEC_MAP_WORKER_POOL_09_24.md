# Handoff: Vzporedno OCR obdelovanje (worker pool) + podpora za VEČ MAP hkrati

**Created:** 2026-09-24T20:15Z (POSODOBLJENO: 2026-09-24T22:50Z, po QA krogu 2 — glej razdelek "QA KROG 2" na dnu)
**Branch:** main
**Session Duration:** ta segment: ~2 uri skupaj (nadaljevanje daljšega projekta - za polno zgodovino od v2.1 dalje glej HISTORY_AI_AGENT.txt in `HANDOFF_SLUZBENI_RACUNALNIK_WINDOWS_09_24.md`, ki obravnava LOČEN, že RAZREŠEN problem zagona na IT-omejenem računalniku)
**Context Window Status:** ta segment se je začel kot nadaljevanje po samodejnem povzetku (compaction) prejšnjega pogovora zaradi bližine limita konteksta. Trenutna poraba konteksta: nizka do srednja.

---

## QA KROG (dodano naknadno — glej dno dokumenta za poln razdelek)

Po prvotni dostavi v2.9 je bil na uporabnikovo izrecno zahtevo izveden skill `qatest` (4-fazni QA protokol). Najdeni sta bili DVE MODERATE napaki (obe POPRAVLJENI in POTRJENO preverjeni) in ena MINOR/hardening izboljšava; posebej zahtevan scenarij "izguba dovoljenja za dodatno mapo med sejo" je bil PREVERJEN in deluje pravilno BREZ dodatnega popravka. Podrobnosti čisto na dnu tega dokumenta, pod "QA KROG — podrobnosti".

## QA KROG 2 (dodano naknadno — glej dno dokumenta za poln razdelek)

Na uporabnikovo izrecno zahtevo za ponovni zagon je bil `qatest` izveden ŠE ENKRAT, tokrat s fokusom na scenarije, ki jih krog 1 NI pokril: izguba dostopa do mape NA MESTU BRANJA (ne le ob zapisu), za primarno IN dodatno mapo, ter vizualna doslednost gumba "+ Dodaj mapo" med aktivnim pregledom. Oba scenarija branja sta se izkazala za že pravilno obravnavana (brez najdbe). Najdena in POPRAVLJENA je bila ena MINOR najdba (gumb "+ Dodaj mapo" ni bil onemogočen med neposredno sproženim "Ponovno preglej"). Verdikt: READY. Podrobnosti pod "QA KROG 2 — podrobnosti" na dnu.

---

## Summary

Uporabnik je po resničnem zagonu OCR-ja na 10.000 slikah poročal, da je "hitri" način v ~5 urah obdelal šele 5.000 slik (strogo zaporedno, en sam worker = eno jedro procesorja) in vprašal, ali gre hitreje. Ob istem odgovoru je potrdil tudi implementacijo dodajanja VEČ map (poleg prvotno izbrane) s trajnim shranjevanjem seznama med sejami. Obe funkciji sta zdaj implementirani, ODLIČNO testirani (Playwright + realen Tesseract.js OCR, ne mock) in **PRIPRAVLJENI ZA COMMIT + DOSTAVO**, a ŠE NISTA bili commit-ani niti dostavljeni uporabniku (glej Next Steps).

---

## Development Process Log

1. Arhitekturna zasnova (per-folder kontekst `makeFolderCtx()`, `_indexDataRef`/`_folderCtx`/`_folderLabel` tagging, `saveIndexFileCore()`/`saveForCtx()` refaktor) — status: DONE (delo se je začelo v PREJŠNJEM segmentu pred compaction-om) — produced: začetni skelet v `app.js` (globalne spremenljivke, `saveIndexFile()`→`saveIndexFileCore()`/`saveExtraFolder()` refaktor, `loadIndexFile(handle=dirHandle)` refaktor)
2. `walkDirectory()` — dodano označevanje vsakega vnosa z `_folderCtx`/`_indexDataRef`/`_folderLabel`, stolpec "Mapa" za dodatne mape dobi predpono z imenom korenske mape — status: DONE
3. `getWorker(profile, langs, slot=0)`/`runOcr(..., slot=0)` — dodan parameter `slot` v ključ predpomnilnika, da vsak "prostor" v poolu dobi SVOJO ločeno Tesseract worker instanco — status: DONE
4. `rescan()` — POPOLN prepis: zanka čez `[primarna, ...extraFolders]`, `ensureExtraFolderLoaded()`, kombiniran `currentFiles` z dodelitvijo `_uid` vsaki vrstici, per-folder diff/pruning (`seenByCtx`), bounded-concurrency worker pool (`poolWorker(slot)` s skupnim sinhronim kazalcem `cursor`), `saveAllFolders()` na vsakih 15 KONČANIH datotek in ob koncu — status: DONE
5. `reOcrSingle(uid, btnEl)` — spremenjen parameter iz `relPath` v `uid` (popravek identificiranega tveganja: relPath ni več unikaten med mapami), uporablja `f._indexDataRef`/`saveForCtx(f._folderCtx)` — status: DONE
6. `buildRows()` — iskanje zapisa prek `f._indexDataRef.files[f.relPath]` namesto globalnega `indexData`, novo polje `uid` v vsaki vrstici — status: DONE
7. `renderTable()`/`openImageRow()`/klikovni event listenerji — `data-uid` namesto `data-path` za "Odpri"/"Natančno"/dvoklik (isBusyRow zdaj primerja `uid`); "Kopiraj pot" NAMENOMA ostane na `data-path`/relPath — status: DONE
8. `pickFolder()`/`reopenLastFolder()` — "Izberi mapo…" počisti `extraFolders` (nova primarna mapa), "Odpri zadnjo mapo" pokliče `restoreExtraFolders()` (nadaljevanje seje); `btnAddFolder.disabled` wiring dodan povsod, kjer se `btnRescan.disabled` nastavlja — status: DONE
9. Nove funkcije: `persistExtraFolders()`, `restoreExtraFolders()`, `addExtraFolder()`, `removeExtraFolder(index)`, `renderExtraFoldersList()`, `getWorkerPoolSize()`, `saveForCtx()`, `saveAllFolders()`, `ensureExtraFolderLoaded()` — status: DONE
10. `index.html` — `#optWorkerCount` izbirnik (poleg `#optOcrQuality`), `#extraFoldersBar`/`#btnAddFolder`/`#extraFoldersList` (pod `#pathBar`), CSS za `.folderChip`/`.folderChipRemove` — status: DONE
11. Testiranje (glej spodaj) — status: DONE, VSI testi uspešni
12. Dokumentacija (HISTORY_AI_AGENT.txt, ta handoff, "Depends on" komentarji v app.js/index.html) — status: DONE
13. Git commit + zip dostava uporabniku — status: **NI ŠE NAREJENO — glej Next Steps, TOČKA 1**

Overall progress: 12/13 korakov dokončanih; commit + dostava sta edini preostali korak.

---

## Work Completed

### Changes Made

- [x] `getWorker(profile, langs, slot=0)` in `runOcr(fileObj, profile, langs, slot=0)` podpirata več ločenih worker instanc hkrati (ključ predpomnilnika vključuje `slot`)
- [x] `rescan()` obdeluje `[primarna mapa, ...extraFolders]` in uporablja bounded-concurrency worker pool namesto zaporedne `for` zanke
- [x] Nova globalna spremenljivka `extraFolders` (`[{handle, indexData, lastKnownGeneratedAt, conflictWarnedGeneratedAt}]`) in `makeFolderCtx(handle)`
- [x] `_uid`/`_folderCtx`/`_indexDataRef`/`_folderLabel` na vsakem vnosu `currentFiles`, dodeljeno v `rescan()`/`walkDirectory()`
- [x] `reOcrSingle()`/`openImageRow()`/klik na vrstico zdaj identificirajo vrstico prek `_uid` (NE VEČ prek `relPath`, ki ni več unikaten med mapami)
- [x] `#btnAddFolder`, `#extraFoldersList` (chip UI z gumbom "×"), `#optWorkerCount` (1-8, privzeto glede na `navigator.hardwareConcurrency`, ni trajno shranjeno)
- [x] Trajno shranjevanje seznama dodatnih map v IndexedDB (`extraFolders` ključ) — obnovljeno ob "Odpri zadnjo mapo", počiščeno ob "Izberi mapo…"
- [x] Napaka pri branju/shranjevanju ENE mape ne prekine pregleda ostalih map ("best effort")
- [x] "Depends on" komentarji dodani na vrh `app.js` in `index.html`

### Key Decisions

| Decision | Rationale | Alternatives Considered |
| --- | --- | --- |
| Primarna mapa ostane na STARIH globalnih spremenljivkah (`dirHandle`/`indexData`/...), dodatne mape v ločenem `extraFolders` polju | Nazaj združljivost + minimalno tveganje regresije v obsežno QA-testirani obstoječi logiki | Poenoten model (VSE mape, vključno s primarno, v enem seznamu) - zavrnjeno zaradi večjega obsega sprememb in tveganja v že preverjeni kodi |
| Identifikacija vrstice prek `_uid` (naraščajoč indeks znotraj generacije `currentFiles`), ne prek sestavljenega ključa (npr. `folderLabel+relPath`) | Enostavnejše, ni potreben ločevalni znak/escaping, `_uid` je vedno na voljo kot navadno število v `data-uid` atributu | Sestavljen niz kot ključ - zavrnjeno zaradi kompleksnosti escaping-a in manjše berljivosti v DOM |
| Vsaka mapa ohrani SVOJ `ocr-index.json`, ni enotne združene datoteke | File System Access API nima koncepta "ena datoteka za več nepovezanih map"; poleg tega omogoča, da mapo uporablja tudi DRUGA neodvisna aplikacija/uporabnik brez konflikta | Ena skupna indeksna datoteka v posebni "glavni" mapi - zavrnjeno, ni jasno, KJE bi taka datoteka smiselno živela |
| `#optWorkerCount` NI trajno shranjen | Odvisen je od RAČUNALNIKA, na katerem se aplikacija ravno zdaj odpre (drugačen laptop = drugačno smiselno privzeto število) | Trajno shranjevanje kot pri `extraFolders` - zavrnjeno, uporabnik tega NI izrecno zahteval (za razliko od `extraFolders`, kjer je izrecno rekel "trajno shraniš") |
| Sinhron skupen kazalec (`cursor`) za worker pool namesto npr. `Promise.allSettled` na vnaprej razdeljenih kosih | JS enonitni izvajalni model zagotavlja varnost brez mutex-a (sinhrono branje+pisanje kazalca med `await` točkami); samodejno uravnoteži obremenitev (hitrejši worker pobere več datotek) | Vnaprej enakomerno razdeljeni kosi (chunk-i) na worker - zavrnjeno, manj učinkovito če se slike razlikujejo po velikosti/zahtevnosti OCR-ja |

---

## Files Affected

### Modified

- `app.js` — glej Development Process Log zgoraj za popoln seznam. Ključne funkcije:
  - `walkDirectory(handle, relPath, recursive, out, ctx)`: rekurzivno našteje slike v mapi; vsak vnos označi z `_folderCtx`/`_indexDataRef`/`_folderLabel` glede na `ctx` (primarni `primaryCtx` ali element `extraFolders`); stolpec `folder` za primarno mapo ostane nespremenjen (`relPath||'/'`), za dodatno dobi predpono z imenom korenske mape.
  - `getWorker(profile, langs, slot=0)`: predpomni Tesseract worker po ključu `profil|jeziki|slot` — z različnimi `slot` vrednostmi ustvari VEČ neodvisnih worker instanc za resnično vzporednost.
  - `saveIndexFileCore(handle, data, ctxState, noPersistText)`: generalizirana (iz prejšnjega `saveIndexFile()`) logika zapisa + zaznavanja konflikta; `saveIndexFile()` (brez argumentov, primarna mapa) in `saveExtraFolder(ctx)` sta tanka ovoja nad njo; `saveForCtx(ctx)` izbere pravega glede na `ctx.isPrimary`.
  - `ensureExtraFolderLoaded(ctx)`: naloži `ctx.indexData`, če še ni (prvi `rescan()` po dodajanju/obnovitvi mape).
  - `rescan(fromFolderOpen)`: POPOLNOMA prepisana — glej Development Process Log #4 zgoraj za podroben opis; ključna nova notranja funkcija `poolWorker(slot)` znotraj nje izvaja vzporedno OCR zanko.
  - `reOcrSingle(uid, btnEl)`: najde vrstico prek `_uid`, uporabi `f._indexDataRef`/`saveForCtx(f._folderCtx)`.
  - `buildRows()`: doda `uid: f._uid` v vsako vrstico, iskanje zapisa prek `f._indexDataRef.files[f.relPath]`.
  - `addExtraFolder()`/`removeExtraFolder(index)`/`renderExtraFoldersList()`/`persistExtraFolders()`/`restoreExtraFolders()`: nova UI/persistenca logika za dodatne mape — glej komentarje v kodi za podrobnosti vsake.
  - `getWorkerPoolSize()`: prebere `#optWorkerCount`, pade nazaj na `DEFAULT_WORKER_POOL_SIZE`, trda zgornja meja 8.
- `index.html` — nov `#optWorkerCount` izbirnik v orodni vrstici, nov `#extraFoldersBar`/`#btnAddFolder`/`#extraFoldersList` pod `#pathBar`, CSS za `.folderChip`/`.folderChipRemove`.
- `HISTORY_AI_AGENT.txt` — dodan obsežen razdelek "DODANO: vzporedno OCR obdelovanje (worker pool) + podpora za VEČ MAP hkrati" s polnim seznamom preverjenega/nepreverjenega.

### Created

- `docs/handoffs/HANDOFF_VEC_MAP_WORKER_POOL_09_24.md` — ta dokument.
- (scratchpad, NI del dostave uporabniku) `scratchpad/test_faza3_multifolder.js`, `scratchpad/test_pool_speed.js` — novi testi za to funkcionalnost.

### Read (Reference)

- `scratchpad/test_faza1.js`, `test_faza1_conflict.js`, `test_faza2.js`, `test_copy_path.js`, `test_perf.js` — obstoječi regresijski testi, ponovno pognani (dva od njih, `test_copy_path.js`/`test_perf.js`, POSODOBLJENA zaradi spremenjene notranje oblike `currentFiles` — glej HISTORY_AI_AGENT.txt).

---

## Technical Context

### Architecture/Design Notes

Glej "Key Decisions" zgoraj. Na kratko: primarna mapa = stare globalne spremenljivke + `primaryCtx` oznaka (samo za enotno obravnavo v skupni kodi), dodatne mape = `extraFolders` seznam kontekstov, vsaka s SVOJIM `ocr-index.json`. Prikaz je združen prek `_folderCtx`/`_indexDataRef` oznak na vsakem vnosu `currentFiles`. Worker pool: `slot`-parametriziran `getWorker()` + sinhron skupen kazalec (varen brez mutex-a v JS enonitnem modelu).

### Dependencies

Brez novih zunanjih odvisnosti (paketov/knjižnic) — vse spremembe uporabljajo obstoječi Tesseract.js, File System Access API, IndexedDB.

### Configuration Changes

Brez.

---

## Things to Know

### Gotchas & Pitfalls

- `relPath` sam po sebi NI VEČ unikaten identifikator vrstice (glej `_uid` popravek) — vsaka NOVA koda, ki bi iskala po `currentFiles.find(x => x.relPath === ...)`, mora namesto tega uporabiti `_uid`, RAZEN če namenoma želi PRVO ujemanje ne glede na mapo (trenutno tega primera ni).
- `f._indexDataRef` je NEPOSREDNA referenca na objekt (ne kopija) — mutacije nanj (`f._indexDataRef.files[relPath] = {...}`) neposredno vplivajo na `indexData`/`ctx.indexData`, kar je NAMERNO (izogne se ponovnemu iskanju konteksta).
- `primaryCtx` v `rescan()` je LOKALNA spremenljivka, zgrajena ob VSAKEM klicu `rescan()` na novo (`{handle: dirHandle, indexData, isPrimary: true}`) — NI persistentna med klici. To je varno, ker `saveForCtx()`/`buildRows()` uporabljajo `f._folderCtx` (ki KAŽE NA objekt, zgrajen v TEM `rescan()` klicu) dosledno znotraj istega `currentFiles` generacije.
- Worker pool ne "prekine" workerja, ki je že sredi `recognize()` klica ob `stopScan()` — enako vedenje kot prej (zaporedna zanka je prav tako počakala trenutno OCR operacijo do konca).

### Assumptions Made

- Predpostavljeno je, da uporabnik NE bo hkrati odprl ISTE dodatne mape v DVEH različnih zavihkih/oknih na način, ki bi zahteval enak "konflikt zaznavanja" nivo pozornosti kot primarna mapa — dejansko JE conflict-detection implementiran enako za dodatne mape (prek `ctx.lastKnownGeneratedAt`/`ctx.conflictWarnedGeneratedAt`), a to NI bilo posebej testirano za dodatne mape (samo za primarno, v `test_faza1_conflict.js`).
- Privzeta zgornja meja worker poola (8) in privzeta ocena (`min(6, hardwareConcurrency||4)`) sta konzervativni oceni brez dejanskega preverjanja razpoložljivega RAM-a (API za to je nezanesljiv) — temeljita na uporabnikovi izjavi "vsaj 16-32GB RAM".

### Known Issues

- Brez znanih nerazrešenih napak v tej funkcionalnosti. Glej "Kaj ni bilo mogoče preveriti" spodaj za omejitve TESTIRANJA (ne za znane hrošče).

---

## Current State

### What's Working

- Vzporedno OCR obdelovanje (worker pool) — DELUJE, izmerjena resnična pohitritev (1,51x pri 4 worker-jih na 8 slikah v CPU-omejenem peskovniku; na resničnem večjedrnem računalniku uporabnika pričakovano znatno višja).
- Dodajanje/odstranjevanje/trajno shranjevanje dodatnih map — DELUJE, vključno z obnovitvijo po "ponovnem zagonu" (simuliranem v testu).
- Ločeni `ocr-index.json` na mapo, brez navzkrižne kontaminacije — POTRJENO.
- Popravek tveganja napačnega ciljanja vrstice pri istoimenskih datotekah v različnih mapah (`_uid`) — POTRJENO.
- Odpornost na napako v ENI (dodatni) mapi — POTRJENO, ostale mape se obdelajo naprej.
- Vsi PREJŠNJI regresijski testi (konflikt zavihkov, naslov zavihka, kopiraj pot, hitrost izrisa) — ŠE VEDNO USPEŠNI po tej spremembi.

### What's Not Working

- Nič znanega. Glavna preostala negotovost je DEJANSKA pohitritev/stabilnost na uporabnikovem resničnem 10.000-slikovnem naboru — to bo lahko potrjeno šele po dostavi in resničnem testu uporabnika.

### Tests

- [x] Sintaksa: `node --check app.js` — USPEŠNO (po vsakem koraku)
- [x] Strukturni/funkcijski testi: `test_faza3_multifolder.js` (7 korakov, vsi USPEŠNI)
- [x] Testiranje hitrosti (real OCR): `test_pool_speed.js` (1,51x pohitritev, 8/8 OCR uspešnih v obeh načinih)
- [x] Regresija: `test_faza1.js`, `test_faza1_conflict.js`, `test_faza2.js` — vsi USPEŠNI brez sprememb testa
- [x] Regresija (POSODOBLJENA testna fixture zaradi nove notranje oblike podatkov): `test_copy_path.js`, `test_perf.js` — vsi USPEŠNI

---

## Next Steps

### Immediate (Start Here)

1. **Commit sprememb** v git (app.js, index.html, HISTORY_AI_AGENT.txt, ta handoff dokument) z ustreznim sporočilom v slovenščini in verzijo (predlog: v2.9 — glej `git log --oneline` za zadnjo verzijo, trenutno HEAD je v2.8+manjši popravki na commit-u `2dd68e6`).
2. **Zgraditi ZIP paket** in ga dostaviti uporabniku prek `SendUserFile`, skupaj s posebej naštetimi spremenjenimi datotekami (uveljavljen vzorec dostave v tem projektu).
3. Uporabnika obvestiti o novih funkcijah v odgovoru: kako uporabiti "+ Dodaj mapo", kje nastaviti število worker-jev, in KRATKO opozorilo o kompromisu RAM/hitrost.

### Subsequent

- Po uporabnikovem resničnem testu na 10.000 slikah: zabeležiti dejansko izmerjeno pohitritev v HISTORY_AI_AGENT.txt.
- Premisliti opozorilo uporabniku ob izbiri visokega št. worker-jev (6-8) — trenutno ni preverbe dejanske RAM (glej "Assumptions Made").

### Blocked On

- Nič trenutno — delo je pripravljeno za commit/dostavo, ni čakajočih odločitev uporabnika.

---

## Related Resources

### Documentation

- `HISTORY_AI_AGENT.txt` — razdelek "DODANO: vzporedno OCR obdelovanje (worker pool) + podpora za VEČ MAP hkrati (2026-09-24)" na koncu datoteke — polna dokumentacija testiranja.
- `docs/handoffs/HANDOFF_SLUZBENI_RACUNALNIK_WINDOWS_09_24.md` — LOČEN, že RAZREŠEN problem (zagon na IT-omejenem računalniku, OneDrive vzrok) — NI neposredno povezan s to funkcionalnostjo, a je del istega projekta.

### Commands to Run

```bash
cd app/ocr-index-app
node --check app.js                                  # sintaksa
cd ../../                                             # scratchpad koren
node test_faza3_multifolder.js                        # strukturni testi (7 korakov)
node test_pool_speed.js                                # test hitrosti (real OCR)
node test_faza1.js && node test_faza1_conflict.js && node test_faza2.js && node test_copy_path.js && node test_perf.js  # regresija
```

### Search Queries

- `grep -n "extraFolders" app.js` - najde vso logiko dodatnih map
- `grep -n "_uid\|_folderCtx\|_indexDataRef" app.js` - najde ves per-vrstica tagging mehanizem
- `grep -n "poolWorker\|getWorkerPoolSize\|DEFAULT_WORKER_POOL_SIZE" app.js` - najde vso worker-pool logiko

---

## Open Questions

- [ ] Kakšna je DEJANSKA pohitritev na uporabnikovem resničnem 10.000-slikovnem naboru (peskovniški test kaže samo NAČELO, ne realistične magnitude)?
- [ ] Ali je smiselno dodati opozorilo/omejitev glede na oceno RAM-a pri visokem št. worker-jev (glej "Assumptions Made")?

---

## Session Notes

To delo je bilo v CELOTI implementirano NEPOSREDNO (ne prek podagentov) zaradi tesne povezanosti z obstoječo, obsežno QA-testirano jedrno logiko (`rescan()`, `saveIndexFile()`, konflikt-zaznavanje, `folderOpBusy`/`scanning`/`singleOcrBusy` varovala) — glej HISTORY_AI_AGENT.txt za polno utemeljitev te odločitve. Dve MANJŠI, neodvisni funkciji iz istega uporabnikovega odgovora (samodejno odpiranje Edge, gumb "Kopiraj pot") STA bili delegirani podagentoma v PREJŠNJEM segmentu (pred tem handoff-om) in sta že commit-ani (`2dd68e6`).

---

_Ta handoff je bil ustvarjen po zaključku implementacije in testiranja, TIK PRED commit-om in dostavo uporabniku (glej Next Steps, točka 1-2) — ne zaradi bližine limita konteksta._

---

## QA KROG — podrobnosti (dodano 2026-09-24T20:40Z)

Izveden skill `qatest` (4-fazni protokol) na uporabnikovo izrecno zahtevo, z izrecnim dodatnim
poudarkom na prej neomenjen scenarij "izguba dovoljenja za dodatno mapo med sejo". Vse spodnje
najdbe so bile POTRJENE Z DEJANSKO IZVEDBO (Playwright, realen Tesseract.js OCR, prave OPFS mape,
prave `DOMException`-napake prek JS `Proxy`), ne le z branjem kode — glej `scratchpad/test_qa_round1.js`.

### Najdbe in popravki

| # | Resnost | Najdba | Status |
| --- | --- | --- | --- |
| 1 | MODERATE | `removeExtraFolder(index)` je uporabljal array indeks — hitro zaporedno odstranjevanje DVEH RAZLIČNIH map je lahko drugo odstranitev TIHO izničilo (stale index po prvi `splice()`) | POPRAVLJENO — `_chipId` (stabilen id na `ctx`) namesto indeksa; `removeExtraFolder(chipId)` |
| 2 | MODERATE | Če je OCR uspel, a zapis na disk spodletel, je `reOcrSingle()` PREPISAL opozorilo o neuspehu z lažno-pozitivnim "Natančen OCR končan" | POPRAVLJENO — `saveIndexFileCore()`/`saveIndexFile()`/`saveExtraFolder()`/`saveForCtx()`/`saveAllFolders()` zdaj vrnejo `true`/`false`; `reOcrSingle()`/`rescan()` prilagodita končno sporočilo |
| 3 | MINOR/hardening | `addExtraFolder()` ni imel lastnega `folderOpBusy` varovala (za razliko od `pickFolder()`/`reopenLastFolder()`) | POPRAVLJENO za doslednost (izvedba ni pokazala dejanske izkoristljivosti v tem testnem okolju); STRANSKA najdba med popravkom (rescan(false)→rescan(true), da lastnega klica ne zavrne) TAKOJ ujeta in popravljena |
| 4 | — (posebej zahtevan test) | Izguba dovoljenja/dosegljivosti dodatne mape MED sejo (`reOcrSingle()` in `rescan()`, prava `NotAllowedError`) | NI NAJDBE — že pravilno obravnavano (brez neujete izjeme, pravilno zabeleženo, aplikacija ostane odzivna, ostale mape nedotaknjene); NI bil potreben noben popravek |

### Verdikt

**READY.** Nobenih CRITICAL najdb. Obe MODERATE najdbi popravljeni in preverjeni z re-izvedbo istega testa (ne le ponovnim branjem diffa). En dodaten hardening popravek. Vsi obstoječi regresijski testi (7 datotek) po popravkih znova uspešni.

### Česa ni bilo mogoče preveriti

- Resničen uporabniški preklic dovoljenja prek nastavitev brskalnika MED sejo v pravem Chrome/Edge (peskovnik nima grafičnega vmesnika) — simulirano prek JS `Proxy`, ki vrže isto vrsto napake (`DOMException`/`NotAllowedError`), funkcionalno enakovredno, a ni identična koda pot kot resnična brskalnikova odločitev.
- Dva resnično sočasno kliknjena sistemska dialoga `showDirectoryPicker()` v pravem brskalniku (najdba #3 zgoraj) — hardening popravek je preventiven, ne potrjen popravek dokazane napake v resničnem okolju.

Polna dokumentacija (vključno z natančnim potekom vsakega testa) je v `HISTORY_AI_AGENT.txt`, razdelek "QA KROG (skill 'qatest')".

---

## QA KROG 2 — podrobnosti (dodano 2026-09-24T22:50Z)

Ponovni zagon skill `qatest` na uporabnikovo izrecno zahtevo ("ponovno, upoštevaj posodobljena
instructions"), na commit `53960b5` (v2.9.1). Fokus: scenariji, ki jih QA krog 1 ni pokril (ta je
izgubo dostopa do mape testiral SAMO ob ZAPISU indeksa) — glej `scratchpad/test_qa_round2.js`.
Vse najdbe potrjene z dejansko izvedbo (Playwright, prave OPFS mape, prava `DOMException` prek
`Proxy` na `handle.entries()`), ne le z branjem kode.

### Najdbe in popravki

| # | Resnost | Najdba | Status |
| --- | --- | --- | --- |
| 1 | — (Test F) | Primarna mapa nedosegljiva NA MESTU BRANJA (`walkDirectory`) sredi `rescan()` | Brez najdbe — napaka pravilno ujeta, `scanning` ponastavljen, gumbi znova omogočeni, brez neujete izjeme |
| 2 | — (Test G) | Dodatna mapa nedosegljiva NA MESTU BRANJA sredi `rescan()`, primarna + druga dodatna mapa zdravi | Brez najdbe — obstoječa "best effort" per-mapa izolacija deluje enako dobro za fazo branja kot za fazo zapisa (krog 1) |
| 3 | MINOR | `setBusy()` ni nikoli nastavljal `btnAddFolder.disabled` — med aktivnim neposredno sproženim "Ponovno preglej" je gumb "+ Dodaj mapo" ostal vizualno klikljiv (interno bi ga `scanning` varovalo v `addExtraFolder()` vseeno zavrnilo — brez podatkovne škode) | Popravljeno — `setBusy()` zdaj doda `btnAddFolder.disabled = isBusy \|\| !dirHandle`; preverjeno s ponovnim zagonom testa H |

### Verdikt

**READY.** Brez CRITICAL/MODERATE najdb v tem krogu. Ena MINOR najdba popravljena in preverjena. Regresija (7 obstoječih testnih datotek + test_qa_round1.js) po popravku ponovno zelena.

### Odprti vprašanji (na uporabnikovo zahtevo izrecno omenjeni tu, NISTA bili predmet tega QA kroga)

1. Dejanska pohitritev worker poola na resničnem cca. 10.000-slikovnem naboru uporabnika ni izmerjena (peskovniški test kaže samo načelo pohitritve, ne realistične magnitude).
2. V UI ni omejitve/opozorila glede na oceno porabe RAM-a pri visokem številu izbranih worker-jev (do 8) na šibkejšem računalniku.

### Česa ni bilo mogoče preveriti

Enako kot v krogu 1 (peskovnik nima grafičnega vmesnika/resničnega brskalnika): resničen uporabniški preklic dovoljenja prek nastavitev brskalnika MED sejo; resnično sočasno kliknjena dva sistemska `showDirectoryPicker()` dialoga.
