/* OCR Iskalnik slik – glavna logika
 * Zahteva Chrome/Edge (File System Access API). Vsi viri (Tesseract.js, jezikovni
 * podatki) so lokalni v mapi assets/ – aplikacija ne potrebuje internetne povezave
 * in ne zahteva namestitve ali skrbniških (administratorskih) pravic v Windows.
 *
 * Odvisnosti (Depends on):
 * - index.html – vsi elementi, na katere se sklicuje `el('...')` spodaj (gumbi, izbirniki,
 *   #extraFoldersList, #optWorkerCount ipd.) MORAJO obstajati v index.html, sicer `el()` vrne null.
 * - assets/tesseract.min.js, assets/worker.min.js, assets/tesseract-core-simd-lstm.wasm.js,
 *   assets/tessdata/{fast,accurate}/ – Tesseract.js OCR mehanizem in jezikovni podatki (glej getWorker()).
 * - Origin Private File System (OPFS, `navigator.storage.getDirectory()`) – uporabljen SAMO v testih
 *   (glej scratchpad/test_*.js), ne v produkcijski kodi te datoteke.
 */

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'bmp', 'gif', 'webp', 'tif', 'tiff']);
const ORIGINAL_TAB_TITLE = document.title; // za obnovitev naslova zavihka po obvestilu ob zaključku pregleda (glej finishScan())
const INDEX_FILENAME = 'ocr-index.json';
const IDB_DB = 'ocr-index-app';
const IDB_STORE = 'handles';
const MAX_LOG_ENTRIES = 500; // omeji pomnilnik dnevnika – najstarejši vnosi se izrivajo
// Trdi omejitvi proti ReDoS (katastrofalnemu regex "backtrackingu"), ki je bil
// dokazan v QA testiranju 2026-09-22 (glej HISTORY_AI_AGENT.txt, razdelek 10):
// vnos z veliko zaporednimi nadomestnimi znaki (* ali ?) lahko zamrzne cel
// zavihek, ker se iskanje izvaja sinhrono na glavni niti ob vsakem pritisku tipke.
const MAX_WILDCARDS_PER_TERM = 5;   // največ toliko '*'/'?' skupaj v ENEM (ne-frazi, ne-regex) izrazu
const MAX_SEARCH_TERM_LENGTH = 300; // trda omejitev dolžine enega izraza (velja tudi za frazo/regex način)
// Trda omejitev dolžine CELOTNEGA iskalnega niza (QA najdba #10, 2026-09-22, DRUGI KROG – FAZA 1,
// glej HISTORY_AI_AGENT.txt): MAX_SEARCH_TERM_LENGTH je omejeval samo POSAMEZEN izraz, preverjeno
// šele znotraj makeTextTest() – PO TEM, ko je bil za zelo dolg prilepljen niz (npr. cel odstavek
// besedila, pomotoma prilepljen v iskalno polje) že opravljen ves prejšnji korak (tokenizeQuery() +
// groupByOr() + compileTerm() za VSAK od morda tisoč ločenih "izrazov", vsak s svojim
// sestavljanjem/kompajliranjem regularnega izraza) – torej odvečno delo na vsak pritisk tipke, še
// preden je bil katerikoli posamezen izraz sploh zavrnjen. Ta meja je namenoma precej večja od
// MAX_SEARCH_TERM_LENGTH (dovoljuje več običajnih besed v enem iskalnem nizu), a prepreči skrajne
// primere (ogromen prilepljen blok besedila).
const MAX_QUERY_LENGTH = 2000;
// Trda časovna omejitev za nalaganje OCR mehanizma (QA najdba, 2026-09-22, ČETRTI KROG – glej
// HISTORY_AI_AGENT.txt): getWorker()/Tesseract.createWorker() lahko v nekaterih brskalniških
// okoljih (dokazano: file:// izvor v Chromium) obvisi v neskončnost namesto da bi se zavrnil –
// brez te omejitve bi vrstica napredka obtičala na "Nalagam OCR mehanizem …" brez ikakršne
// povratne informacije ali vnosa v dnevnik. Glej withTimeout() spodaj.
const OCR_WORKER_TIMEOUT_MS = 20000;

let dirHandle = null;          // FileSystemDirectoryHandle izbrane mape
let indexData = null;          // { version, generatedAt, files: { relPath: {size, mtime, text, ocrAt, error, mode} } }
let currentFiles = [];         // seznam trenutno zaznanih datotek [{relPath, name, folder, size, mtime, handle}]
let filteredRows = [];         // rezultat po filtru/iskanju, za izris
let sortKey = 'name';
let sortDir = 1;
let stopRequested = false;
let scanning = false;
let singleOcrBusy = false;     // ali trenutno teče posamični "Natančno" OCR iz tabele
let singleOcrUid = null;       // katera vrstica (_uid – glej rescan()) je trenutno v obdelavi – da renderTable() med
                                // tem ne "pozabi" na to ob morebitnem vmesnem ponovnem izrisu (glej QA #6)
let folderOpBusy = false;      // ali trenutno teče "Izberi mapo…" ALI "Odpri zadnjo mapo" (QA najdba #5,
                                // 2026-09-22): brez tega bi lahko hiter zaporedni klik na oba gumba sprožil
                                // dve vzporedni afterFolderSelected()/rescan() operaciji, ki bi si neusklajeno
                                // nastavljali isti globalni dirHandle/indexData – glej pickFolder()/reopenLastFolder()
const workers = {};            // predpomnilnik tesseract.js worker-jev po ključu "profile|langs"
let lastKnownGeneratedAt = null; // zadnji "generatedAt" iz ocr-index.json, kot ga POZNA ta zavihek
                                  // (prebran ob odpiranju mape, posodobljen ob vsakem uspešnem
                                  // zapisu) – glej saveIndexFile()/QA najdbo #4 (konflikt dveh
                                  // hkrati odprtih zavihkov nad isto mapo)
let conflictWarnedGeneratedAt = null; // dedupliciranje opozorila o konfliktu (glej saveIndexFile())

// ---------- DODATNE MAPE (funkcija, dodana 2026-09-23/24 na uporabnikovo željo) ----------
// Poleg PRVOTNE (glavne) mape, ki jo ves zgornji/spodnji kodi predstavljajo globalne
// spremenljivke `dirHandle`/`indexData`/`lastKnownGeneratedAt`/`conflictWarnedGeneratedAt`
// (NEspremenjeno, iz razlogov nazaj združljivosti in tveganja – ta koda je bila obsežno QA
// testirana v prejšnjih krogih), lahko uporabnik doda ŠE POLJUBNO ŠTEVILO dodatnih map.
// Vsaka dodatna mapa dobi svoj lasten "kontekst" – enako obliko podatkov kot prvotna mapa,
// a v LOČENEM objektu (ne globalnih spremenljivkah), da se izognemo dirkalnim
// stanjem/prepletanju med mapami. Vsaka mapa (prvotna IN vsaka dodatna) ohrani SVOJ LASTEN
// ocr-index.json, zapisan nazaj v SVOJO mapo – ni enotne/združene datoteke indeksa, ker
// File System Access API nima koncepta "ene datoteke, ki zajema več nepovezanih map".
// Prikaz/iskanje v tabeli JE združen (glej rescan()/buildRows()) – vsaka vrstica v `currentFiles`
// nosi referenco `_indexDataRef` na TOČNO TISTI indexData objekt (prvotne ali dodatne mape), iz
// katerega izvira, in `_folderLabel` (ime korenske mape) za prikaz, kadar je aktivnih več map.
// Popravek (QA krog 2026-09-24, najdba "stale index pri hitrem zaporednem odstranjevanju"):
// vsak kontekst dobi svoj STABILEN `_chipId` (nikoli ponovno uporabljen znotraj seje), na katerega
// se veže gumb "×" v renderExtraFoldersList()/removeExtraFolder() – PREJ je bil za to uporabljen
// array INDEX, ki pa je neveljaven/zastarel takoj, ko se `extraFolders` spremeni MED dvema hitro
// zaporednima klikoma (dokazano v QA testu: klik na "×" mape A in TAKOJ ZATEM na "×" mape C, PREDEN
// se je tabela/DOM osvežil po prvi odstranitvi, je povzročil, da je drugi klik tiho ("`if (!ctx)
// return`") ni naredil NIČESAR, ker je indeks 2 po odstranitvi A kazal MIMO konca skrajšanega
// seznama). `_chipId` ostane veljaven ne glede na to, koliko drugih map je bilo medtem odstranjenih.
let nextFolderChipId = 1;
function makeFolderCtx(handle) {
  return { handle, indexData: null, lastKnownGeneratedAt: null, conflictWarnedGeneratedAt: null, _chipId: nextFolderChipId++ };
}
let extraFolders = []; // [{handle, indexData, lastKnownGeneratedAt, conflictWarnedGeneratedAt, _chipId}]

// ---------- VZPOREDNO OCR OBDELOVANJE (worker pool, dodano 2026-09-24 na uporabnikovo željo) ----------
// Prejšnja različica je slike OCR-ala STROGO ZAPOREDNO (ena za drugo, en sam Tesseract worker) –
// pri uporabniku je to za 10.000 slik v načinu "Hitro" pomenilo ~3,6 s/sliko in več ur skupaj,
// kar uporablja SAMO ENO jedro procesorja, ne glede na to, koliko jih ima računalnik na voljo.
// Zdaj se lahko hkrati zažene VEČ neodvisnih Tesseract worker-jev (vsak je resnična ločena nit/
// Web Worker), ki si RAZDELIJO seznam datotek za obdelavo – glej rescan() spodaj in getWorker()
// (parameter `slot`). Privzeto število je zmerna ocena glede na št. logičnih jeder procesorja
// (navigator.hardwareConcurrency), navzgor omejena na 6 (varovalka proti pretirani porabi
// pomnilnika – vsak worker nosi svojo kopijo OCR jedra/jezikovnih podatkov, tudi >10-15 MB) –
// uporabnik lahko število v nastavitvah poljubno spremeni (glej #optWorkerCount v index.html).
const DEFAULT_WORKER_POOL_SIZE = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4)));

// ---------- Dnevnik dogodkov/napak (samo v pomnilniku tega zavihka, za poročanje težav) ----------
let debugLog = [];              // [{time, level: 'info'|'warn'|'error'|'debug', message, detail}]
let debugErrorCount = 0;        // število vnosov level 'warn'/'error' – prikazano kot značka na gumbu
let lastBadRegexSrc = null;     // dedupliciranje ponavljajočih se opozoril o neveljavnem regexu med tipkanjem
let lastBadWildcardSrc = null;  // dedupliciranje opozoril o preveč nadomestnih znakih (ReDoS omejitev)
let lastUnsafeRegexSrc = null;  // dedupliciranje opozoril o nevarnem gnezdenju v regex načinu (QA najdba #1,
                                 // 2026-09-22 – glej hasUnsafeRegexNesting())
let lastUnclosedQuoteQuery = null; // dedupliciranje opozorila o nezaprtem narekovaju (glej tokenizeQuery())
let lastTooLongQuery = null;    // dedupliciranje opozorila o predolgem CELOTNEM iskalnem nizu (glej parseQuery())
const redactedPathIds = new Map(); // relPath -> zaporedna številka znotraj TE seje, glej logPath() spodaj

const el = (id) => document.getElementById(id);
const btnPickFolder = el('btnPickFolder');
const btnReopenLast = el('btnReopenLast');
const btnRescan = el('btnRescan');
const btnStop = el('btnStop');
const btnToggleOptions = el('btnToggleOptions');
const btnHelp = el('btnHelp');
const btnHelpClose = el('btnHelpClose');
const helpOverlay = el('helpOverlay');
const btnDebug = el('btnDebug');
const btnDebugClose = el('btnDebugClose');
const btnDebugExport = el('btnDebugExport');
const btnDebugClear = el('btnDebugClear');
const debugOverlay = el('debugOverlay');
const debugLogBody = el('debugLogBody');
const debugBadge = el('debugBadge');
const debugCountText = el('debugCountText');
const searchBox = el('searchBox');
const pathBar = el('pathBar');
const searchOptionsPanel = el('searchOptionsPanel');
const progressWrap = el('progressWrap');
const progressBarInner = el('progressBarInner');
const progressText = el('progressText');
const emptyState = el('emptyState');
const resultsTable = el('resultsTable');
const resultsBody = el('resultsBody');
const statusLeft = el('statusLeft');
const statusRight = el('statusRight');
const optRecursive = el('optRecursive');
const optLangEng = el('optLangEng');
const optLangSlv = el('optLangSlv');
const optOcrQuality = el('optOcrQuality');
const optMatchCase = el('optMatchCase');
const optWholeWord = el('optWholeWord');
const optRegex = el('optRegex');
const optSearchName = el('optSearchName');
const optSearchPath = el('optSearchPath');
const optSearchContent = el('optSearchContent');
const optNoPersistText = el('optNoPersistText');
const optWorkerCount = el('optWorkerCount');
const btnAddFolder = el('btnAddFolder');
const extraFoldersList = el('extraFoldersList');

// ---------- IndexedDB: shranjevanje ročaja (handle) zadnje mape ----------

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function checkLastFolder() {
  try {
    const handle = await idbGet('lastFolder');
    if (handle) {
      btnReopenLast.disabled = false;
      btnReopenLast.title = 'Zadnja mapa: ' + handle.name;
    }
  } catch (e) { logEvent('debug', 'Ni shranjene zadnje mape (IndexedDB) – v redu ob prvem zagonu.', e); }
}

// ---------- Pomožne splošne funkcije ----------

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function fmtDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setStatus(left, right) {
  if (left !== undefined) statusLeft.textContent = left;
  if (right !== undefined) statusRight.textContent = right;
}

function setProgress(active, pct, text) {
  progressWrap.classList.toggle('active', active);
  if (pct !== undefined) progressBarInner.style.width = pct + '%';
  if (text !== undefined) progressText.textContent = text;
}

// Popravek (QA krog 2, 2026-09-24 – Test H, glej scratchpad/test_qa_round2.js): `setBusy()` prej NI
// dotikal `btnAddFolder` ("+ Dodaj mapo"), za razliko od ostalih treh gumbov za delo z mapo
// (Izberi mapo…/Odpri zadnjo mapo/Ponovno preglej), ki jih pravilno onemogoči med aktivnim pregledom.
// Posledica: med aktivnim "Ponovno preglej" (sproženim NEPOSREDNO prek lastnega gumba, ne prek
// odpiranja mape) je "+ Dodaj mapo" ostal VIZUALNO klikljiv, čeprav bi ga klik interno zavrnil (guard
// `scanning` v addExtraFolder() – glej komentar tam) – ni šlo za podatkovno/funkcionalno napako
// (ni prišlo do podvajanja ali izgube podatkov), a vidno nedosledno uporabniško izkušnjo glede na
// preostale tri gumbe. Popravljeno za doslednost.
function setBusy(isBusy) {
  scanning = isBusy;
  btnPickFolder.disabled = isBusy;
  btnReopenLast.disabled = isBusy || btnReopenLast.title === '';
  btnRescan.disabled = isBusy || !dirHandle;
  btnStop.disabled = !isBusy;
  if (btnAddFolder) btnAddFolder.disabled = isBusy || !dirHandle;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Dnevnik dogodkov/napak ----------
// level: 'info' (normalen potek), 'warn' (neuspeh dela funkcije, a aplikacija nadaljuje),
// 'error' (nepričakovana/nezaznana napaka), 'debug' (pričakovan/neškodljiv rob primer).
// Namen: da noben del vmesnika ne "obmolkne" brez sledi – tudi če uporabnik ne opazi
// vrstice stanja ali nima odprte konzole brskalnika (F12), lahko odpre gumb "Dnevnik"
// in/ali izvozi celoten dnevnik v .txt datoteko za poročanje/odpravo napake.
function logEvent(level, message, detail) {
  const entry = {
    time: new Date().toISOString(),
    level: level || 'info',
    message: String(message == null ? '' : message),
    detail: detail ? String(detail && detail.stack ? detail.stack : detail) : '',
  };
  debugLog.push(entry);
  if (debugLog.length > MAX_LOG_ENTRIES) debugLog.shift();
  if (entry.level === 'warn' || entry.level === 'error') {
    debugErrorCount++;
    updateDebugBadge();
  }
  if (debugOverlay && debugOverlay.classList.contains('active')) renderDebugPanel();
}

// Popravek QA najdbe #8 (2026-09-22, DRUGI KROG – FAZA 1, glej HISTORY_AI_AGENT.txt): nastavitev
// "ne shranjuj OCR besedila na disk" je bila mišljena kot splošno zasebnostno stikalo, a dnevnik
// (dostopen prek gumba "Dnevnik" IN prek izvoza dnevnika za poročanje napak) je VEDNO razkril polna
// imena/poti datotek in map, ne glede na to nastavitev – prebrano BESEDILO slike je bilo torej
// zaščiteno, ime/pot datoteke (ki lahko že sama po sebi razkriva občutljivo vsebino, npr.
// "izvidi/kri_Novak_Janez.png") pa ne. Ko je nastavitev vklopljena, logPath() namesto polne poti
// vrne samo pripono in stabilno zaporedno številko znotraj TE seje (dovolj za sledenje/
// razhroščevanje – "katera od N slik je odpovedala" – brez razkritja dejanskih imen/map).
function logPath(relPath) {
  if (!optNoPersistText || !optNoPersistText.checked) return relPath;
  if (!redactedPathIds.has(relPath)) redactedPathIds.set(relPath, redactedPathIds.size + 1);
  const m = /\.[^./\\]+$/.exec(relPath);
  const ext = m ? m[0] : '';
  return `[skrita pot #${redactedPathIds.get(relPath)}${ext}]`;
}

function updateDebugBadge() {
  if (!debugBadge) return;
  if (debugErrorCount > 0) {
    debugBadge.style.display = 'inline-block';
    debugBadge.textContent = debugErrorCount > 99 ? '99+' : String(debugErrorCount);
  } else {
    debugBadge.style.display = 'none';
  }
}

function renderDebugPanel() {
  if (!debugLogBody) return;
  if (debugLog.length === 0) {
    debugLogBody.innerHTML = '<div style="padding:20px;color:var(--text-dim)">Dnevnik je prazen – še ni bilo zabeleženih dogodkov ali napak v tem zavihku.</div>';
  } else {
    // najnovejši dogodki na vrhu, da jih ni treba iskati s scrollanjem
    debugLogBody.innerHTML = debugLog.slice().reverse().map((e) => {
      const t = e.time.replace('T', ' ').replace('Z', '');
      return `<div class="logRow log-${e.level}">`
        + `<span class="logTime">${t}</span>`
        + `<span class="logLevel">${e.level.toUpperCase()}</span>`
        + `<span class="logMsg">${escapeHtml(e.message)}${e.detail ? `<pre class="logDetail">${escapeHtml(e.detail)}</pre>` : ''}</span>`
        + `</div>`;
    }).join('');
  }
  if (debugCountText) {
    debugCountText.textContent = `${debugLog.length} vnosov (od tega ${debugErrorCount} opozoril/napak od zadnjega "Počisti")`;
  }
}

function exportDebugLog() {
  const lines = debugLog.map((e) => {
    let line = `[${e.time}] ${e.level.toUpperCase()}: ${e.message}`;
    if (e.detail) line += '\n    ' + e.detail.replace(/\n/g, '\n    ');
    return line;
  });
  const header = 'OCR Iskalnik slik - dnevnik za poročanje napak\n'
    + `Izvoženo: ${new Date().toISOString()}\n`
    + `Brskalnik (user agent): ${navigator.userAgent}\n`
    + `Izbrana mapa: ${dirHandle ? dirHandle.name : '(ni izbrana)'}\n`
    + `Dodatne mape: ${extraFolders.length > 0 ? extraFolders.map((c) => c.handle.name).join(', ') : '(brez)'}\n`
    + `Velikost OCR worker poola: ${getWorkerPoolSize()}\n`
    + `Slik v indeksu: ${currentFiles.length}\n`
    + `Število vnosov v dnevniku: ${debugLog.length}\n`
    + '='.repeat(70) + '\n';
  const content = header + (lines.length ? lines.join('\n') + '\n' : '(dnevnik je prazen)\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ocr-index-app-dnevnik-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  logEvent('info', 'Dnevnik izvožen v .txt datoteko (' + debugLog.length + ' vnosov).');
}

function clearDebugLog() {
  debugLog = [];
  debugErrorCount = 0;
  updateDebugBadge();
  renderDebugPanel();
  logEvent('info', 'Dnevnik ročno počiščen.');
}

// Ovije funkcijo (sinhrono ali asinhrono, uporabljeno v addEventListener) tako, da
// NOBENA nepričakovana napaka ne obmolkne brez sledi: ujame jo, zapiše v dnevnik IN
// jo pokaže v vrstici stanja, namesto da bi uporabnik videl le "nič se ni zgodilo".
// Pričakovane/obravnavane napake (ki jih funkcije same že lovijo s svojim try/catch
// in lastnim sporočilom) to ne spremeni – guard() ujame samo tisto, kar bi sicer
// ušlo mimo obstoječe obravnave napak.
function guard(fn, label) {
  return function (...args) {
    let result;
    try {
      result = fn.apply(this, args);
    } catch (e) {
      logEvent('error', `Nepričakovana napaka (${label}): ` + (e && e.message ? e.message : String(e)), e);
      setStatus(`Nepričakovana napaka (${label}) – podrobnosti v dnevniku (gumb "Dnevnik").`);
      return;
    }
    if (result && typeof result.then === 'function') {
      result.catch((e) => {
        logEvent('error', `Nepričakovana napaka (${label}): ` + (e && e.message ? e.message : String(e)), e);
        setStatus(`Nepričakovana napaka (${label}) – podrobnosti v dnevniku (gumb "Dnevnik").`);
      });
    }
    return result;
  };
}

// Zadnja varnostna mreža: ujameta vse, kar bi sicer ušlo mimo guard() in obstoječih
// try/catch blokov (npr. napaka v kodi, ki se izvede zunaj kakega dogodka, ali
// zavrnjena obljuba (promise), ki je nihče eksplicitno ne lovi). Brez tega bi taka
// napaka pristala SAMO v konzoli brskalnika (F12) in uporabnik ne bi videl ničesar.
window.addEventListener('error', (e) => {
  logEvent('error', 'Neulovljena JS napaka: ' + (e.message || '(brez sporočila)')
    + (e.filename ? ` (${e.filename}:${e.lineno || '?'})` : ''), e.error);
  setStatus('Prišlo je do nepričakovane napake – podrobnosti v dnevniku (gumb "Dnevnik").');
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  const msg = reason && reason.message ? reason.message : String(reason);
  logEvent('error', 'Neulovljena zavrnitev obljube (unhandled promise rejection): ' + msg, reason);
  setStatus('Prišlo je do nepričakovane napake – podrobnosti v dnevniku (gumb "Dnevnik").');
});

// ---------- Sprehod po mapi (rekurzivno) ----------

// Popravek (2026-09-24, dodatne mape – glej makeFolderCtx()/rescan()): funkcija zdaj sprejme
// EKSPLICITEN parameter `ctx` ("kontekst" mape – primarni `primaryCtx` iz rescan() ali element
// `extraFolders`), ki ga vsak najden vnos ponese s sabo kot `_folderCtx` (za usmerjanje shranjevanja
// nazaj v PRAVO mapo – glej saveForCtx()) in `_indexDataRef` (neposredna referenca na TA `indexData`
// objekt – za hitro iskanje v buildRows()/reOcrSingle() brez ugibanja, kateri mapi vrstica pripada).
// `folder` (prikazani stolpec "Mapa") ostane za PRIMARNO mapo POPOLNOMA nespremenjen (samo relativna
// podmapa, brez predpone) – za nazaj združljivost/nespremenjen izgled, kadar uporabnik ne uporablja
// dodatnih map. Za DODATNO mapo se prikaz predpiše z imenom njene korenske mape (npr.
// "DrugaMapa/podmapa"), da je v skupni tabeli jasno razvidno, iz katere mape vrstica izvira.
async function walkDirectory(handle, relPath, recursive, out, ctx) {
  for await (const [name, entryHandle] of handle.entries()) {
    if (stopRequested) return;
    const entryRel = relPath ? `${relPath}/${name}` : name;
    if (entryHandle.kind === 'file') {
      const ext = extOf(name);
      if (IMAGE_EXT.has(ext)) {
        const folder = ctx.isPrimary ? (relPath || '/') : (relPath ? `${ctx.handle.name}/${relPath}` : ctx.handle.name);
        out.push({
          relPath: entryRel, name, folder, handle: entryHandle,
          _folderCtx: ctx, _indexDataRef: ctx.indexData, _folderLabel: ctx.isPrimary ? null : ctx.handle.name,
        });
      }
    } else if (entryHandle.kind === 'directory' && recursive) {
      if (name.startsWith('.')) continue;
      await walkDirectory(entryHandle, entryRel, recursive, out, ctx);
    }
  }
}

// ---------- Indeks: branje/pisanje ocr-index.json v izbrano mapo ----------

// Popravek (QA najdbi #6 in #7, 2026-09-22 – glej HISTORY_AI_AGENT.txt): prej se je VSAKA napaka pri
// branju ocr-index.json (poškodovan/neveljaven JSON, nepričakovana oblika polja "files" ipd.) beležila
// samo na najnižji ravni "debug" (brez značke na gumbu "Dnevnik", brez vidnega sporočila) – uporabnik ni
// imel NOBENEGA načina izvedeti, da je bil cel prejšnji indeks (lahko ure OCR dela) tiho zavržen. Zdaj
// ločimo dva primera: (a) datoteka SPLOH NE OBSTAJA – to je pričakovano ob prvem pregledu mape, ostane
// raven "debug"; (b) datoteka OBSTAJA, a je ni bilo mogoče prebrati/razčleniti ALI ima nepričakovano
// obliko (npr. "files" ni navaden objekt) – to JE dejanska izguba podatkov in je zdaj glasno opozorjeno
// (alert + raven "warn", ki dvigne rdečo značko na gumbu "Dnevnik") – vrstica stanja bi bila premalo
// vidna, ker jo rescan() takoj nato prepiše s "Preiskujem mapo …".
// Popravek (2026-09-24, dodatne mape – glej makeFolderCtx()/rescan()): funkcija zdaj sprejme
// EKSPLICITEN parameter `handle` (privzeto = glavni `dirHandle`, torej za VSE obstoječe klice
// brez argumenta popolnoma nespremenjeno obnašanje) – to omogoča ponovno uporabo iste, že
// temeljito testirane logike branja za VSAKO dodatno mapo posebej, ne le za glavno.
async function loadIndexFile(handle = dirHandle) {
  let fileExisted = false;
  try {
    const fh = await handle.getFileHandle(INDEX_FILENAME);
    fileExisted = true;
    const file = await fh.getFile();
    const text = await file.text();
    const parsed = JSON.parse(text);
    const filesOk = parsed && typeof parsed.files === 'object' && parsed.files !== null && !Array.isArray(parsed.files);
    if (filesOk) return parsed;
    logEvent('warn', 'ocr-index.json obstaja, a ima nepričakovano obliko (manjka ali ni veljavno polje "files") – prejšnji indeks je bil ZAVRŽEN.');
    alert('Opozorilo: obstoječi ocr-index.json ima nepričakovano obliko, zato je bil prejšnji indeks zavržen – slike bodo znova obdelane z OCR. Podrobnosti so v dnevniku (gumb "Dnevnik").');
  } catch (e) {
    if (fileExisted) {
      logEvent('warn', 'ocr-index.json obstaja, a ga ni bilo mogoče prebrati/razčleniti (' + (e && e.message) + ') – prejšnji indeks je bil ZAVRŽEN.', e);
      alert('Opozorilo: obstoječega ocr-index.json ni bilo mogoče prebrati (morda poškodovan), zato je bil prejšnji indeks zavržen – slike bodo znova obdelane z OCR. Podrobnosti so v dnevniku (gumb "Dnevnik").');
    } else {
      logEvent('debug', 'ocr-index.json ne obstaja – prvi pregled te mape, začenjam nov indeks.', e);
    }
  }
  return { version: 2, generatedAt: null, files: {} };
}

// Vrne PLITVO/globinsko kopijo indeksa, primerno za zapis na disk, kadar je
// vklopljena nastavitev "ne shranjuj OCR besedila na disk" (najdba #10 iz QA
// pregleda 2026-09-22, glej HISTORY_AI_AGENT.txt, razdelek 9): besedilo
// (`text`) se v tem primeru NE zapiše v ocr-index.json – ostane le v
// pomnilniku (`indexData`), dokler je zavihek odprt, iskanje po vsebini pa
// znotraj te seje deluje naprej nemoteno. Vsak zapis dobi oznako
// `redacted: true`, da lahko `rescan()` ob naslednjem odpiranju mape (ko je
// nastavitev spet izklopljena) prepozna, da je treba besedilo znova prebrati
// z OCR (glej "backfill" logiko spodaj).
function redactTextForSave(data) {
  const out = { version: data.version, generatedAt: data.generatedAt, files: {} };
  for (const [relPath, entry] of Object.entries(data.files)) {
    out.files[relPath] = { ...entry, text: '', redacted: true };
  }
  return out;
}

// Popravek QA najdbe #4 (2026-09-22, DRUGI KROG – FAZA 1, odločitev iz "grill" intervjuja, glej
// HISTORY_AI_AGENT.txt): če je ISTA mapa hkrati odprta v DVEH zavihkih/oknih, vsak zavihek hrani
// SVOJO kopijo `indexData` v pomnilniku – brez kakršnegakoli preverjanja bi zadnji zapis tiho
// prepisal spremembe (lahko ure OCR dela) drugega zavihka. File System Access API nima vgrajenega
// mehanizma za zaznavanje takega konflikta (ni "compare-and-swap" zapisa), zato ga simuliramo:
// PRED vsakim zapisom na disk preberemo trenutni "generatedAt" ŽE NA DISKU in ga primerjamo s
// tistim, ki ga je TA zavihek nazadnje prebral/zapisal (`lastKnownGeneratedAt`). Neujemanje pomeni,
// da je datoteko v vmesnem času spremenil nekdo drug – uporabnika GLASNO opozorimo. Zapisa NAMENOMA
// ne blokiramo (to bi lahko onemogočilo normalno delo enega samega zavihka po lažnem alarmu, npr.
// če je bila datoteka ročno urejena) – uporabnik le izve, da TA zapis prepiše tuje spremembe.
// Popravek (2026-09-24, dodatne mape): izvirna logika je zdaj v `saveIndexFileCore()`, ki sprejme
// EKSPLICITEN `handle`/`data`/`ctxState` namesto branja/pisanja globalnih `dirHandle`/`indexData`/
// `lastKnownGeneratedAt`/`conflictWarnedGeneratedAt` – to omogoča IDENTIČNO (enako temeljito
// testirano) logiko zaznavanja konfliktov tudi za vsako dodatno mapo posebej, v njenem LASTNEM
// `ctxState` objektu (glej makeFolderCtx()), ne da bi karkoli prepisovala v glavni mapi. `ctxState`
// je navaden objekt z lastnostma `lastKnownGeneratedAt`/`conflictWarnedGeneratedAt`, ki ju ta
// funkcija BERE IN PIŠE (mutira) – klicatelj poskrbi, da isti objekt uporabi tudi ob naslednjem klicu.
// Popravek (QA krog 2026-09-24, najdba "status po neuspelem zapisu"): funkcija zdaj VRNE
// `true`/`false` (uspeh/neuspeh zapisa), namesto da bi klicatelj slepo predpostavil uspeh. Prej so
// reOcrSingle()/rescan() PO klicu te funkcije nastavili svoje LASTNO sporočilo o uspehu (npr.
// "Natančen OCR končan: ..."), ki je TAKOJ PREPISALO opozorilo `setStatus(...)`, nastavljeno TU ob
// neuspehu – uporabnik bi torej videl SAMO sporočilo o uspehu, čeprav zapis na disk dejansko NI
// uspel (edini sled je bil dvignjen rdeč indikator na gumbu "Dnevnik", kar ni dovolj vidno).
async function saveIndexFileCore(handle, data, ctxState, noPersistText) {
  try {
    try {
      const existingFh = await handle.getFileHandle(INDEX_FILENAME);
      const existingParsed = JSON.parse(await (await existingFh.getFile()).text());
      const diskGeneratedAt = existingParsed && existingParsed.generatedAt;
      if (ctxState.lastKnownGeneratedAt !== null && diskGeneratedAt && diskGeneratedAt !== ctxState.lastKnownGeneratedAt
          && ctxState.conflictWarnedGeneratedAt !== diskGeneratedAt) {
        ctxState.conflictWarnedGeneratedAt = diskGeneratedAt;
        logEvent('warn', `Zaznan mogoč konflikt v mapi "${handle.name}": ocr-index.json je bil na disku spremenjen (${diskGeneratedAt}) po tem, ko ga je ta zavihek nazadnje prebral/zapisal (${ctxState.lastKnownGeneratedAt}) – verjetno je ista mapa odprta tudi v drugem zavihku/oknu. Ta zapis bo ZDAJ PREPISAL tiste spremembe. Priporočilo: uporabljajte samo EN zavihek/okno na mapo hkrati.`);
      }
    } catch (e) {
      // Datoteka morda še ne obstaja (prvi zapis v to mapo) ali je bila medtem izbrisana/poškodovana –
      // to NI namen tega preverjanja (namen je le zaznati sočasno UREJANJE), zato tiho ignoriramo.
    }
    const fh = await handle.getFileHandle(INDEX_FILENAME, { create: true });
    const writable = await fh.createWritable();
    data.generatedAt = new Date().toISOString();
    const toWrite = noPersistText ? redactTextForSave(data) : data;
    await writable.write(JSON.stringify(toWrite, null, 0));
    await writable.close();
    ctxState.lastKnownGeneratedAt = data.generatedAt;
    return true;
  } catch (e) {
    console.error('Napaka pri shranjevanju indeksa:', e);
    logEvent('error', `Napaka pri shranjevanju ocr-index.json (mapa "${handle.name}"): ` + e.message, e);
    setStatus('Opozorilo: indeksa ni bilo mogoče zapisati nazaj v mapo (' + e.message + ')');
    return false;
  }
}

// Ovoj za GLAVNO mapo – ohranja IDENTIČEN podpis (brez argumentov) kot pred to spremembo, tako
// da so vsi obstoječi klicatelji (rescan(), reOcrSingle()) popolnoma nespremenjeni/združljivi.
// Vrne `true`/`false` (glej saveIndexFileCore() zgoraj).
async function saveIndexFile() {
  const ctxState = { lastKnownGeneratedAt, conflictWarnedGeneratedAt };
  const ok = await saveIndexFileCore(dirHandle, indexData, ctxState, optNoPersistText.checked);
  lastKnownGeneratedAt = ctxState.lastKnownGeneratedAt;
  conflictWarnedGeneratedAt = ctxState.conflictWarnedGeneratedAt;
  return ok;
}

// Shrani indeks ENE DODATNE mape (glej extraFolders) – `ctx` je element iz `extraFolders`
// (objekt, torej mutacije `ctx.lastKnownGeneratedAt`/`ctx.conflictWarnedGeneratedAt` znotraj
// saveIndexFileCore() samodejno "ostanejo" na pravem mestu za naslednji klic). Vrne `true`/`false`.
async function saveExtraFolder(ctx) {
  return saveIndexFileCore(ctx.handle, ctx.indexData, ctx, optNoPersistText.checked);
}

// Usmeri shranjevanje v PRAVO funkcijo glede na to, iz katere mape `ctx` izvira – `primaryCtx`
// (glej rescan()) ima `isPrimary: true` in gre prek `saveIndexFile()` (ohranja obstoječe globalne
// spremenljivke), vsak element `extraFolders` pa prek `saveExtraFolder(ctx)`. Vrne `true`/`false`.
async function saveForCtx(ctx) {
  return ctx.isPrimary ? saveIndexFile() : saveExtraFolder(ctx);
}

// Shrani VSE trenutno aktivne mape (primarno + vse dodatne) – uporabljeno pri vmesnem shranjevanju
// med OCR poolom (glej rescan()) in ob koncu pregleda, da nobena od dotaknjenih map ne ostane
// nezapisana, tudi če je bila obdelana samo ena od več datotek v njej v tem "obhodu". Vrne `true`,
// SAMO če so USPELE VSE mape (kliče vse, tudi če ena spodleti, da neuspeh ene ne prepreči zapisa
// preostalih) – klicatelj (rescan()) uporabi vrnjeno vrednost za opozorilo v končnem sporočilu.
async function saveAllFolders(ctxs) {
  let allOk = true;
  for (const ctx of ctxs) {
    const ok = await saveForCtx(ctx);
    if (!ok) allOk = false;
  }
  return allOk;
}

// Poskrbi, da ima dodatna mapa naložen svoj `indexData` (ob prvem rescan() po dodajanju/obnovitvi
// mape je `ctx.indexData` še `null` – glej makeFolderCtx()) – ponovna uporaba iste, temeljito
// testirane loadIndexFile() logike kot za primarno mapo.
async function ensureExtraFolderLoaded(ctx) {
  if (ctx.indexData === null) {
    ctx.indexData = await loadIndexFile(ctx.handle);
    ctx.lastKnownGeneratedAt = ctx.indexData.generatedAt || null;
    ctx.conflictWarnedGeneratedAt = null;
  }
}

// Prebere izbrano velikost worker poola iz #optWorkerCount (če element obstaja in ima veljavno
// vrednost), sicer pade nazaj na DEFAULT_WORKER_POOL_SIZE. Trda zgornja meja 8 velja NE GLEDE na to,
// kaj element vsebuje (varovalka pred nesmiselno/pokvarjeno vrednostjo v DOM-u).
function getWorkerPoolSize() {
  const raw = optWorkerCount && optWorkerCount.value;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1) return Math.min(n, 8);
  return DEFAULT_WORKER_POOL_SIZE;
}

// ---------- Tesseract worker (ločen predpomnilnik za "fast" in "accurate") ----------

// Pretvori relativno pot v POPOLN (absolutni) URL glede na trenutni dokument.
// Razlog (odkrito 2026-09-22 na podlagi izvoženega dnevnika napak – glej
// HISTORY_AI_AGENT.txt, razdelek 9): ko je stran odprta prek file:// (dvoklik
// na index.html, brez strežnika), ima Tesseract.js privzeto vklopljen
// "workerBlobURL" način – worker se ustvari iz vmesnega Blob URL-ja z
// vsebino `importScripts("<relativna pot>")`. Blob URL na file:// straneh
// dobi "null" izvor (origin), zato se RELATIVNA pot znotraj njega ne more
// pravilno razrešiti glede na dejansko mapo aplikacije in nalaganje
// worker.min.js spodleti (NetworkError: "failed to execute importScripts").
// Če pa je pot že POPOLNA (absolutni file:// ali http(s):// URL), do te
// težave ne pride, ker se ničesar ne razrešuje relativno na "null" izvor.
function absAssetUrl(relPath) {
  return new URL(relPath, document.baseURI).href;
}

// Prepozna znano sporočilo napake pri nalaganju OCR mehanizma (worker/core/wasm)
// in doda kratek, razumljiv namig – uporabno tudi kot varovalka, če bi se v
// katerem od brskalnikov/različic izkazalo, da absAssetUrl() ne zadošča.
function friendlyOcrErrorHint(e) {
  const msg = String((e && e.message) || e || '');
  if (/importScripts|Worker|wasm/i.test(msg)) {
    return ' (Namig: OCR mehanizem se ni naložil – preverite, da mapa "assets" ni bila ločena od'
      + ' index.html, da pot do mape ne vsebuje nenavadnih znakov, in poskusite stran znova odpreti'
      + ' – po možnosti iz mape brez presledkov/šumnikov v imenu poti.)';
  }
  return '';
}

// Ovije poljubno Promise s trdo časovno omejitvijo (QA najdba, 2026-09-22, ČETRTI KROG – glej
// OCR_WORKER_TIMEOUT_MS zgoraj in HISTORY_AI_AGENT.txt): če se izvirna Promise ne razreši ne
// zavrne v `ms` milisekundah, withTimeout() namesto nje zavrne z jasnim, razumljivim sporočilom
// (`label` pove, KATERA operacija je obtičala) – uporabljeno pri obeh dejanskih klicnih mestih
// getWorker() (spodaj in v runOcr()), da noben del vmesnika ne more obviseti brez sledi/povratne
// informacije, tudi če bi znotraj worker-ja prišlo do neulovljene napake, ki sicer nikoli ne
// doseže `catch` klicatelja (dokazano v QA testiranju: `fetch()` napaka znotraj Tesseract.js
// worker-ja na file:// izvoru Promise pusti trajno "viseti").
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Časovna omejitev (${(ms / 1000).toFixed(0)} s) pri: ${label}`)), ms)),
  ]);
}

// Popravek QA najdbe #11 (2026-09-22, DRUGI KROG – FAZA 1, glej HISTORY_AI_AGENT.txt): prej se je
// `workers[key]` nastavil ŠELE PO uspešno razrešenem Tesseract.createWorker() (torej PO `await`).
// Če sta dva klica getWorker() z istim ključem (profil+jeziki) stekla znotraj tega okna – npr.
// serijski pregled mape in hkraten posamičen "Natančno" OCR ukaz na drugi vrstici – bi OBA videla
// `workers[key]` še kot `undefined` in OBA zagnala SVOJ Tesseract.createWorker(): eden od dveh
// dejansko zagnanih worker-jev bi ostal "osirotel" (worker teče v ozadju, a ga noben del kode več
// ne uporablja, ker ga je drugi klic v predpomnilniku prepisal) – nepotrebna poraba pomnilnika/CPU
// brez kakršnekoli vidne napake. Zdaj se v predpomnilnik SINHRONO (pred prvim `await`) shrani sam
// Promise (ne šele razrešen worker) – drugi hkratni klic z istim ključem zato takoj dobi ISTO
// Promise namesto da bi zagnal svoj worker. Če se Promise zavrne (napaka pri nalaganju), se
// neuspeli vnos odstrani iz predpomnilnika, da naslednji klic dobi svež poskus namesto trajno
// "pokvarjenega" predpomnjenega zavrnjenega Promise-a.
// Popravek (2026-09-24, worker pool – glej rescan()/DEFAULT_WORKER_POOL_SIZE zgoraj): dodan parameter
// `slot` (privzeto 0), vključen v ključ predpomnilnika – prej je bil en sam worker predpomnjen na
// kombinacijo profil+jeziki, kar je pomenilo, da bi VEČ hkratnih klicev getWorker() z isto kombinacijo
// (npr. vzporedni OCR pool) dobilo ISTO worker instanco in se torej znotraj nje SERIJSKO vrstilo –
// brez dejanske vzporednosti. Z `slot` vsak "prostor" v poolu dobi SVOJO ločeno Tesseract worker
// instanco (resnično ločen Web Worker/nit), zato lahko dejansko teče vzporedno. Posamični "Natančno"
// OCR (reOcrSingle()) in prvi worker v poolu (slot 0) si predpomnilnik delita, kar je namerno – ni
// smisla zagnati dodatnega workerja samo zanj.
async function getWorker(profile, langs, slot = 0) {
  const key = profile + '|' + langs.join('+') + '|' + slot;
  if (workers[key]) return workers[key];
  const workerPromise = Tesseract.createWorker(langs.join('+'), 1, {
    workerPath: absAssetUrl('assets/worker.min.js'),
    corePath: absAssetUrl('assets/tesseract-core-simd-lstm.wasm.js'),
    langPath: absAssetUrl(`assets/tessdata/${profile}`),
    gzip: true,
    logger: () => {},
  });
  workers[key] = workerPromise;
  workerPromise.catch(() => { if (workers[key] === workerPromise) delete workers[key]; });
  return workerPromise;
}

// ---------- Predobdelava slike za natančen OCR način ----------
// Poveča majhne slike, pretvori v sivine in raztegne kontrast – pomaga pri
// drobnem besedilu v uporabniških vmesnikih na posnetkih zaslona.

async function preprocessImageForOCR(fileObj) {
  const bitmap = await createImageBitmap(fileObj);
  const maxDim = Math.max(bitmap.width, bitmap.height);
  const scale = maxDim < 1800 ? Math.min(3, 1800 / maxDim) : 1;
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close && bitmap.close();

  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const gray = new Float32Array(w * h);
  let min = 255, max = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = Math.min(255, Math.max(0, Math.round((gray[p] - min) * 255 / range)));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || fileObj), 'image/png'));
}

async function runOcr(fileObj, profile, langs, slot = 0) {
  // Popravek C (QA najdba, 2026-09-22, ČETRTI KROG) – glej withTimeout()/OCR_WORKER_TIMEOUT_MS
  // zgoraj. Ta klic pokrije tudi pot iz reOcrSingle() ("Natančno" na posamezni vrstici), če
  // ustrezen worker (profil+jeziki+slot) še ni bil predhodno naložen/predpomnjen.
  const w = await withTimeout(getWorker(profile, langs, slot), OCR_WORKER_TIMEOUT_MS, 'nalaganje OCR mehanizma');
  const input = profile === 'accurate' ? await preprocessImageForOCR(fileObj) : fileObj;
  const { data } = await w.recognize(input);
  return data.text || '';
}

// ---------- Glavni potek: izbira mape / rescan ----------

// Popravek dirkalnega stanja (QA najdba #5, 2026-09-22 – glej HISTORY_AI_AGENT.txt): pickFolder() in
// reopenLastFolder() prej nista onemogočila svojih gumbov PRED prvim `await` – hiter zaporedni klik na
// "Izberi mapo…" in nato takoj na "Odpri zadnjo mapo" (ali dva zaporedna klika na isti gumb) je lahko
// sprožil DVE vzporedni operaciji, ki obe pišeta v isti globalni dirHandle/indexData in obe kličeta
// afterFolderSelected()/rescan() – brez ikakršnega opozorila uporabniku. Zdaj oba gumba onemogočimo
// TAKOJ, sinhrono (pred prvim await), IN dodatno preverimo skupno zastavico `folderOpBusy` (enak vzorec
// kot že obstoječa `scanning`/`singleOcrBusy`), da je druga operacija zavrnjena z jasnim sporočilom,
// tudi če bi se gumb iz kakega drugega razloga vseeno sprožil (npr. tipkovnica).
//
// DOPOLNITEV (QA najdba #22, 2026-09-22, TRETJI KROG – glej HISTORY_AI_AGENT.txt): prvotni POPRAVEK 4 je
// ščitil samo btnPickFolder/btnReopenLast, NE PA btnRescan – med ozkim, časovno odvisnim oknom (po tem,
// ko `dirHandle` že kaže na NOVO mapo, a preden `afterFolderSelected()` prek `loadIndexFile()` dejansko
// naloži NJEN indeks) je bil "Ponovno preglej" še vedno klikljiv in bi lahko stekel proti novi mapi s
// STARIM (prejšnje mape) `indexData`/`currentFiles`. Zdaj `folderOpBusy` onemogoči tudi `btnRescan` za
// celotno trajanje operacije odpiranja mape, IN `rescan()` sam eksplicitno preveri `folderOpBusy` (enaka
// "defense in depth" zasnova, kot jo `rescan()` že uporablja za `singleOcrBusy`) – tudi če bi gumb iz
// kakega drugega razloga vseeno ostal klikljiv.
async function pickFolder() {
  if (!window.showDirectoryPicker) {
    alert('Ta brskalnik ne podpira dostopa do datotečnega sistema (File System Access API).\nUporabite Chrome ali Edge.');
    return;
  }
  if (folderOpBusy) {
    logEvent('warn', '"Izberi mapo…" preklicano – druga operacija odpiranja mape je že v teku.');
    setStatus('Počakajte, da se zaključi odpiranje mape, nato poskusite znova.');
    return;
  }
  folderOpBusy = true;
  btnPickFolder.disabled = true;
  btnReopenLast.disabled = true;
  btnRescan.disabled = true;
  if (btnAddFolder) btnAddFolder.disabled = true;
  try {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      logEvent('debug', 'Izbira mape preklicana s strani uporabnika (ali dovoljenje zavrnjeno).', e);
      return; // uporabnik je preklical izbiro
    }
    logEvent('info', 'Mapa izbrana: ' + dirHandle.name);
    try {
      await idbSet('lastFolder', dirHandle);
    } catch (e) {
      // Neusodna napaka: bližnjica "Odpri zadnjo mapo" ob naslednjem zagonu ne bo na voljo,
      // sama izbrana mapa pa se kljub temu normalno obdela naprej.
      logEvent('warn', 'Mape ni bilo mogoče shraniti kot "zadnjo mapo" (IndexedDB): ' + e.message, e);
    }
    // Popravek (2026-09-24, dodatne mape): "Izberi mapo…" pomeni NOVO primarno mapo – seznam
    // dodatnih map iz PREJŠNJE seje/mape se NE prenese samodejno naprej (verjetno ne pripadajo novi
    // primarni mapi vsebinsko). Za obnovitev ob NADALJEVANJU iste seje glej "Odpri zadnjo mapo"
    // (reopenLastFolder()/restoreExtraFolders()) spodaj.
    if (extraFolders.length > 0) {
      logEvent('info', `Izbrana je NOVA primarna mapa – prejšnjih ${extraFolders.length} dodatnih map(a) je bilo odstranjenih iz prikaza (datoteke v njih ostajajo nedotaknjene). Po potrebi jih znova dodajte prek "+ Dodaj mapo".`);
    }
    extraFolders = [];
    await persistExtraFolders();
    renderExtraFoldersList();
    await afterFolderSelected();
  } finally {
    folderOpBusy = false;
    // rescan() (znotraj afterFolderSelected()) je ob normalnem zaključku že samo poskrbel za pravilno
    // (ponovno omogočeno) stanje gumbov prek setBusy(); to je varnostna mreža za primer preklica/napake
    // PRED to točko, ko setBusy() sploh še ni bil poklican. Formula za btnRescan je enaka kot v setBusy().
    btnPickFolder.disabled = scanning;
    btnReopenLast.disabled = scanning || btnReopenLast.title === '';
    btnRescan.disabled = scanning || !dirHandle;
    if (btnAddFolder) btnAddFolder.disabled = scanning || !dirHandle;
  }
}

async function reopenLastFolder() {
  if (folderOpBusy) {
    logEvent('warn', '"Odpri zadnjo mapo" preklicano – druga operacija odpiranja mape je že v teku.');
    setStatus('Počakajte, da se zaključi odpiranje mape, nato poskusite znova.');
    return;
  }
  folderOpBusy = true;
  btnPickFolder.disabled = true;
  btnReopenLast.disabled = true;
  btnRescan.disabled = true;
  if (btnAddFolder) btnAddFolder.disabled = true;
  try {
    let handle;
    try {
      handle = await idbGet('lastFolder');
    } catch (e) {
      logEvent('error', 'Napaka pri branju shranjene zadnje mape (IndexedDB): ' + e.message, e);
      setStatus('Napaka pri branju shranjene zadnje mape: ' + e.message);
      return;
    }
    if (!handle) return;
    try {
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        logEvent('warn', 'Dostop do zadnje mape ni bil odobren (dovoljenje: ' + perm + ').');
        setStatus('Dostop do zadnje mape ni bil odobren.');
        return;
      }
    } catch (e) {
      logEvent('error', 'Zadnje mape ni bilo mogoče ponovno odpreti: ' + e.message, e);
      setStatus('Zadnje mape ni bilo mogoče ponovno odpreti: ' + e.message);
      return;
    }
    dirHandle = handle;
    logEvent('info', 'Zadnja mapa ponovno odprta: ' + dirHandle.name);
    // Popravek (2026-09-24, dodatne mape): "Odpri zadnjo mapo" pomeni NADALJEVANJE prejšnje seje –
    // za razliko od "Izberi mapo…" (glej pickFolder()) tu poskusimo obnoviti tudi trajno shranjen
    // seznam dodatnih map (glej restoreExtraFolders()), vsako s svojim dovoljenjem posebej.
    await restoreExtraFolders();
    await afterFolderSelected();
  } finally {
    folderOpBusy = false;
    btnPickFolder.disabled = scanning;
    btnReopenLast.disabled = scanning || btnReopenLast.title === '';
    btnRescan.disabled = scanning || !dirHandle;
    if (btnAddFolder) btnAddFolder.disabled = scanning || !dirHandle;
  }
}

async function afterFolderSelected() {
  pathBar.innerHTML = `Mapa: <b>${escapeHtml(dirHandle.name)}</b>`;
  // Opomba (QA najdba #22): btnRescan NAMENOMA ni tu sproščen (kot je bilo prej) – ostaja onemogočen
  // ves čas trajanja `folderOpBusy` (nastavljeno v pickFolder()/reopenLastFolder()); pravilno ga sprosti
  // šele rescan() sam (prek setBusy()) ali, če rescan() iz katerega koli razloga ne steče, `finally`
  // blok klicatelja (pickFolder()/reopenLastFolder()).
  setStatus('Nalagam shranjeni indeks (če obstaja) …');
  indexData = await loadIndexFile();
  // Glej QA najdbo #4/saveIndexFile(): tu zabeležimo, kateri "generatedAt" ta zavihek POZNA ob
  // odpiranju mape – izhodišče za poznejše zaznavanje konflikta z drugim zavihkom/oknom.
  lastKnownGeneratedAt = indexData.generatedAt || null;
  conflictWarnedGeneratedAt = null; // nova mapa – prejšnje opozorilo (če je bilo) ni več relevantno
  await rescan(true); // glej opombo v rescan() – ta klic je naravni zaključek TE operacije odpiranja mape
}

// ---------- Dodatne mape ("+ Dodaj mapo") ----------

// Trajno shrani (IndexedDB, glej idbSet()) SAMO seznam ročajev (handle) dodatnih map – ne njihove
// vsebine/indeksa (ta ostane v ocr-index.json v vsaki mapi posebej, glej saveExtraFolder()).
async function persistExtraFolders() {
  try {
    await idbSet('extraFolders', extraFolders.map((ctx) => ctx.handle));
  } catch (e) {
    // Neusodna napaka (enak vzorec kot pri idbSet('lastFolder', …) v pickFolder()): seznam dodatnih
    // map ob naslednjem zagonu ne bo samodejno obnovljen, trenutna seja pa deluje naprej normalno.
    logEvent('warn', 'Seznama dodatnih map ni bilo mogoče trajno shraniti (IndexedDB): ' + e.message, e);
  }
}

// Ob zagonu (prek "Odpri zadnjo mapo", glej reopenLastFolder()) poskusi obnoviti trajno shranjen
// seznam dodatnih map. Vsaka mapa dobi SVOJE dovoljenje posebej (brskalnik lahko med sejami dovoljenje
// prekliče za eno mapo, a ne za drugo) – če dovoljenje za posamezno mapo ni odobreno ali je mapa
// medtem postala nedosegljiva (premaknjena/izbrisana), TA mapa preprosto ni obnovljena (z jasnim
// opozorilom v dnevniku), ostale pa se kljub temu obnovijo naprej – "best effort", enak vzorec kot
// pri branju posamezne datoteke/mape v rescan().
async function restoreExtraFolders() {
  let handles;
  try {
    handles = await idbGet('extraFolders');
  } catch (e) {
    logEvent('debug', 'Seznama dodatnih map ni bilo mogoče prebrati (IndexedDB) – v redu, če jih (še) ni bilo shranjenih.', e);
    extraFolders = [];
    renderExtraFoldersList();
    return;
  }
  if (!Array.isArray(handles) || handles.length === 0) {
    extraFolders = [];
    renderExtraFoldersList();
    return;
  }
  const restored = [];
  for (const handle of handles) {
    try {
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        logEvent('warn', `Dostop do shranjene dodatne mape "${handle.name}" ni bil odobren (dovoljenje: ${perm}) – ta mapa NI bila obnovljena. Po potrebi jo dodajte znova ročno prek "+ Dodaj mapo".`);
        continue;
      }
      restored.push(makeFolderCtx(handle));
    } catch (e) {
      logEvent('warn', `Shranjene dodatne mape ni bilo mogoče ponovno odpreti: ${e.message} – ta mapa NI bila obnovljena. Po potrebi jo dodajte znova ročno prek "+ Dodaj mapo".`, e);
    }
  }
  extraFolders = restored;
  if (restored.length > 0) {
    logEvent('info', `Obnovljenih dodatnih map: ${restored.length}.`);
  }
  // Shrani očiščen seznam nazaj (brez tistih, ki jih ni bilo mogoče obnoviti), da naslednjič ne
  // poskušamo znova zaprositi za dovoljenje za mapo, ki je uporabnik očitno ne želi več deliti.
  await persistExtraFolders();
  renderExtraFoldersList();
}

async function addExtraFolder() {
  if (!window.showDirectoryPicker) {
    alert('Ta brskalnik ne podpira dostopa do datotečnega sistema (File System Access API).\nUporabite Chrome ali Edge.');
    return;
  }
  if (!dirHandle) {
    setStatus('Najprej izberite prvotno (glavno) mapo prek "Izberi mapo…".');
    return;
  }
  if (folderOpBusy || scanning || singleOcrBusy) {
    logEvent('warn', '"+ Dodaj mapo" preklicano – druga operacija odpiranja/pregleda mape je že v teku.');
    setStatus('Počakajte, da se zaključi trenutna operacija, nato poskusite znova.');
    return;
  }
  // Popravek (QA krog 2026-09-24, hardening): enak vzorec kot pri pickFolder()/reopenLastFolder() –
  // `folderOpBusy` se nastavi TAKOJ (pred prvim `await window.showDirectoryPicker()`, ki lahko v
  // resničnem brskalniku traja poljubno dolgo, dokler uporabnik ne izbere mape/prekliče), da hiter
  // zaporeden klik na "+ Dodaj mapo" (ali na "Izberi mapo…"/"Odpri zadnjo mapo" medtem) ne more
  // sprožiti DVEH vzporednih operacij odpiranja mape. V QA testu s SIMULIRANIM (mock) takojšnjim
  // izbirnikom mape podvajanje NI nastalo zaradi vrstnega reda mikro-nalog (dedup preverjanje je
  // "ujelo" drugi klic) – a to je krhko in odvisno od časovnih okoliščin, zato je varovalka dodana
  // za DOSLEDNOST z ostalimi operacijami odpiranja mape, ne kot popravek dokazane napake.
  folderOpBusy = true;
  btnPickFolder.disabled = true;
  btnReopenLast.disabled = true;
  btnRescan.disabled = true;
  if (btnAddFolder) btnAddFolder.disabled = true;
  try {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      logEvent('debug', 'Izbira dodatne mape preklicana s strani uporabnika (ali dovoljenje zavrnjeno).', e);
      return;
    }
    // Prepreči podvajanje: ista mapa kot primarna, ali mapa, ki je že na seznamu dodatnih.
    try {
      if (await dirHandle.isSameEntry(handle)) {
        setStatus('Ta mapa je že izbrana kot prvotna (glavna) mapa.');
        return;
      }
      for (const ctx of extraFolders) {
        if (await ctx.handle.isSameEntry(handle)) {
          setStatus('Ta mapa je že dodana na seznam dodatnih map.');
          return;
        }
      }
    } catch (e) {
      // isSameEntry() sam po sebi ni kritičen za delovanje – če primerjava spodleti, raje dovolimo
      // dodajanje (kvečjemu se v tabeli pojavi podvojena vsebina) kot da bi uporabnika brez razloga
      // blokirali pri dodajanju legitimne nove mape.
      logEvent('debug', 'Preverjanje podvajanja dodatne mape ni uspelo – nadaljujem z dodajanjem.', e);
    }
    const ctx = makeFolderCtx(handle);
    extraFolders.push(ctx);
    logEvent('info', 'Dodatna mapa dodana: ' + handle.name);
    await persistExtraFolders();
    renderExtraFoldersList();
    // POMEMBNO: `true` (ne `false`) – tako kot pri afterFolderSelected(), je TA klic naravni
    // zaključek TE operacije odpiranja mape, ki je pravkar nastavila `folderOpBusy = true` (glej
    // zgoraj) – z `false` bi rescan() lastno operacijo zavrnil s "Ponovni pregled preklican – …
    // je še v teku" (POPRAVEK odkrit med QA testiranjem hardening spremembe zgoraj).
    await rescan(true); // takoj vključi novo mapo v skupni pregled/tabelo
  } finally {
    folderOpBusy = false;
    btnPickFolder.disabled = scanning;
    btnReopenLast.disabled = scanning || btnReopenLast.title === '';
    btnRescan.disabled = scanning || !dirHandle;
    if (btnAddFolder) btnAddFolder.disabled = scanning || !dirHandle;
  }
}

// Popravek (QA krog 2026-09-24): parameter je zdaj `chipId` (glej makeFolderCtx() – `_chipId`), NE
// VEČ array indeks – indeks bi lahko postal zastarel/neveljaven, če uporabnik hitro zaporedoma
// klikne "×" na DVEH RAZLIČNIH mapah, preden se seznam/DOM osveži po prvi odstranitvi (glej komentar
// pri `nextFolderChipId` zgoraj za podroben opis dokazanega scenarija).
async function removeExtraFolder(chipId) {
  if (folderOpBusy || scanning || singleOcrBusy) {
    logEvent('warn', 'Odstranitev dodatne mape preklicana – operacija odpiranja/pregleda mape je že v teku.');
    setStatus('Počakajte, da se zaključi trenutna operacija, nato poskusite znova.');
    return;
  }
  const index = extraFolders.findIndex((c) => c._chipId === chipId);
  if (index === -1) return; // mapa je bila medtem že odstranjena (npr. drug hkraten klik) – tiho, brez napake
  const ctx = extraFolders[index];
  logEvent('info', `Dodatna mapa odstranjena iz prikaza: ${ctx.handle.name} (datoteke in ocr-index.json V SAMI MAPI ostanejo nedotaknjeni – odstrani se samo iz te aplikacije).`);
  extraFolders.splice(index, 1);
  await persistExtraFolders();
  renderExtraFoldersList();
  // Odstrani vrstice te mape iz TRENUTNEGA prikaza brez potrebe po ponovnem branju vseh map z diska.
  currentFiles = currentFiles.filter((f) => f._folderCtx !== ctx);
  renderTable();
}

function renderExtraFoldersList() {
  if (!extraFoldersList) return;
  // `data-chip-id` (ne array indeks – glej removeExtraFolder()) ostane veljaven tudi po hitrem
  // zaporednem odstranjevanju več map, PREDEN se ta funkcija ponovno pokliče za vsako od njih.
  extraFoldersList.innerHTML = extraFolders.map((ctx) => `<span class="folderChip">${escapeHtml(ctx.handle.name)}`
    + `<button class="folderChipRemove" data-chip-id="${ctx._chipId}" title="Odstrani to mapo iz prikaza (datoteke v mapi ostanejo nedotaknjene)">×</button></span>`).join('');
}

function selectedLangs() {
  const langs = [];
  if (optLangEng.checked) langs.push('eng');
  if (optLangSlv.checked) langs.push('slv');
  if (langs.length === 0) langs.push('eng');
  return langs;
}

async function rescan(fromFolderOpen) {
  if (!dirHandle || scanning) return;
  // Obramba v globino (QA najdba #22, 2026-09-22, TRETJI KROG – glej HISTORY_AI_AGENT.txt), poleg
  // onemogočenega gumba v pickFolder()/reopenLastFolder(): `fromFolderOpen` je `true` SAMO, ko rescan()
  // pokliče afterFolderSelected() kot NARAVNI zaključek TE ISTE operacije odpiranja mape (glej klic
  // spodaj) – vsak DRUG klic (npr. gumb "Ponovno preglej") med potekom `folderOpBusy` je zavrnjen, tudi
  // če bi gumb iz kakega drugega razloga vseeno ostal klikljiv.
  if (folderOpBusy && !fromFolderOpen) {
    logEvent('warn', 'Ponovni pregled preklican – odpiranje/nalaganje mape je še v teku.');
    setStatus('Počakajte, da se zaključi odpiranje mape, nato poskusite znova.');
    return;
  }
  if (singleOcrBusy) {
    // Popravek dirkalnega stanja (race condition), najdenega v QA testiranju
    // 2026-09-22 (glej HISTORY_AI_AGENT.txt): brez te preverbe bi lahko "Ponovno
    // preglej" stekel SOČASNO s posamičnim "Natančno" OCR-jem iz tabele – oba bi
    // neusklajeno pisala v isti indexData in klicala saveIndexFile(), kar bi lahko
    // povzročilo izgubo enega od zapisov ("izgubljeni zapis"/lost update).
    logEvent('warn', 'Ponovni pregled preklican – najprej se mora zaključiti "Natančno" OCR posamezne slike, ki je v teku.');
    setStatus('Počakajte, da se zaključi "Natančno" OCR posamezne slike, nato poskusite znova.');
    return;
  }
  stopRequested = false;
  document.title = ORIGINAL_TAB_TITLE; // ponastavi naslov zavihka (glej finishScan()) - nov pregled se je pravkar začel
  setBusy(true);
  setProgress(true, 0, 'Preiskujem mapo(e) …');
  setStatus('Preiskujem mapo(e) …');

  const scanStartedAt = Date.now();

  // "primaryCtx" NI shranjevalec stanja (to ostajajo globalne spremenljivke `dirHandle`/`indexData`/
  // `lastKnownGeneratedAt`/`conflictWarnedGeneratedAt` – nespremenjeno, iz razlogov nazaj združljivosti)
  // – je le ENOTNA "oznaka" primarne mape, da jo walkDirectory()/buildRows()/reOcrSingle() lahko
  // obravnavajo po ISTEM vzorcu kot vsak element `extraFolders` (glej saveForCtx()).
  const primaryCtx = { handle: dirHandle, indexData, isPrimary: true };
  // Poskrbi, da ima vsaka DODATNA mapa (po dodajanju prek "+ Dodaj mapo" ali obnovitvi ob zagonu –
  // glej restoreExtraFolders()) naložen svoj indeks, preden jo pregledamo.
  for (const ctx of extraFolders) {
    try {
      await ensureExtraFolderLoaded(ctx);
    } catch (e) {
      logEvent('error', `Indeksa dodatne mape "${ctx.handle.name}" ni bilo mogoče naložiti: ` + e.message + ' – ta mapa bo za ta pregled preskočena.', e);
    }
  }
  const activeCtxs = [primaryCtx, ...extraFolders.filter((ctx) => ctx.indexData !== null)];
  const extraCount = activeCtxs.length - 1;
  logEvent('info', `Pregled mape(e) začet (${extraCount > 0 ? `${extraCount + 1} map skupaj` : '1 mapa'}, rekurzivno: ${optRecursive.checked ? 'da' : 'ne'}, jeziki: ${selectedLangs().join('+')}, OCR: ${optOcrQuality.value}).`);

  currentFiles = [];
  try {
    await walkDirectory(dirHandle, '', optRecursive.checked, currentFiles, primaryCtx);
  } catch (e) {
    logEvent('error', 'Napaka pri branju mape: ' + e.message, e);
    setStatus('Napaka pri branju mape: ' + e.message);
    setBusy(false);
    setProgress(false);
    return;
  }
  // Napaka pri branju ENE dodatne mape ne sme prekiniti CELOTNEGA pregleda (primarne mape in
  // ostalih dodatnih map) – tako kot pri branju posamezne datoteke (glej metapodatke spodaj), gre
  // za "best effort": prizadeta mapa za ta pregled preprosto manjka v tabeli, uporabnik pa je o
  // razlogu glasno obveščen prek dnevnika.
  for (const ctx of extraFolders) {
    if (ctx.indexData === null) continue; // ensureExtraFolderLoaded() je že zabeležil napako zgoraj
    if (stopRequested) break;
    try {
      await walkDirectory(ctx.handle, '', optRecursive.checked, currentFiles, ctx);
    } catch (e) {
      logEvent('error', `Napaka pri branju dodatne mape "${ctx.handle.name}": ` + e.message + ' – ta mapa bo za ta pregled preskočena.', e);
    }
  }
  if (stopRequested) { finishScan('Ustavljeno.'); return; }

  // Dodeli vsaki vrstici unikaten `_uid` (preprost naraščajoč indeks znotraj TE generacije
  // `currentFiles`) – potreben, ker `relPath` sam po sebi NI VEČ nujno unikaten, odkar je lahko
  // aktivnih več map hkrati (ista relativna pot se lahko pojavi v dveh RAZLIČNIH mapah). Uporabljajo
  // ga openImageRow()/reOcrSingle() (glej klice iz renderTable()) za zanesljivo iskanje PRAVE
  // vrstice, ne glede na to, iz katere mape izvira.
  currentFiles.forEach((f, i) => { f._uid = i; });

  // Pridobi metapodatke (velikost, čas spremembe) za vsako datoteko – enako za vse mape, saj deluje
  // izključno prek `f.handle` (ne referencira nobene globalne spremenljivke).
  for (const f of currentFiles) {
    try {
      const file = await f.handle.getFile();
      f.size = file.size;
      f.mtime = file.lastModified;
      f._fileObj = file;
    } catch (e) {
      f.size = 0; f.mtime = 0; f._error = 'Napaka branja: ' + e.message;
      logEvent('warn', `Datoteke ni bilo mogoče prebrati (${logPath(f.relPath)}): ` + e.message, e);
    }
  }

  // Ugotovi, katere datoteke je treba (znova) OCR-ati: nove, spremenjene ali prej neuspešne.
  // Datotek, ki so bile že ročno obdelane v natančnem načinu, ne obdelamo znova kar samodejno
  // (da hitri "Ponovno preglej" ostane hiter) – razen če se je datoteka dejansko spremenila.
  // Popravek (2026-09-24, dodatne mape): `prev`/pisanje zdaj gre prek `f._indexDataRef` (LASTEN
  // indeks vsake mape) namesto golega globalnega `indexData` – `seenByCtx` sledi "videnim" potem
  // LOČENO za vsako mapo (isti relPath se lahko ponovi v dveh RAZLIČNIH mapah, ne sme priti do
  // navzkrižnega brisanja/mešanja med njima).
  const toProcess = [];
  const seenByCtx = new Map();
  let backfillCount = 0;
  for (const f of currentFiles) {
    let seen = seenByCtx.get(f._folderCtx);
    if (!seen) { seen = new Set(); seenByCtx.set(f._folderCtx, seen); }
    seen.add(f.relPath);
    const prev = f._indexDataRef.files[f.relPath];
    // "Backfill" (dopolnitev za nazaj): če je bil zapis prej shranjen z izklopljenim
    // besedilom (nastavitev "ne shranjuj OCR besedila na disk", glej saveIndexFile()/
    // redactTextForSave()) in je uporabnik to nastavitev medtem znova izklopil, ga je
    // treba obravnavati enako kot neobdelano sliko, da se besedilo znova prebere z OCR
    // in tokrat dejansko zapiše v ocr-index.json.
    const needsBackfill = prev && prev.redacted && !optNoPersistText.checked;
    if (!prev || prev.size !== f.size || prev.mtime !== f.mtime || prev.error || needsBackfill) {
      toProcess.push(f);
      if (needsBackfill) backfillCount++;
    }
  }
  if (backfillCount > 0) {
    logEvent('info', `Nastavitev "ne shranjuj OCR besedila na disk" je izklopljena – za ${backfillCount} slik(o) bo besedilo znova prebrano z OCR, da se zapiše v ocr-index.json.`);
  }
  // Odstrani iz indeksa datoteke, ki jih ni več – ločeno za vsako mapo (glej seenByCtx zgoraj).
  for (const ctx of activeCtxs) {
    const seen = seenByCtx.get(ctx) || new Set();
    for (const relPath of Object.keys(ctx.indexData.files)) {
      if (!seen.has(relPath)) delete ctx.indexData.files[relPath];
    }
  }

  setStatus(`Najdenih ${currentFiles.length} slik${extraCount > 0 ? ` (${extraCount + 1} map)` : ''}. Za OCR: ${toProcess.length}.`);
  let done = 0; // deljeno med OCR zanko spodaj in finishScan() sporočilom ob morebitni ustavitvi
  // Popravek (QA krog 2026-09-24): sledi, ali je KATERIKOLI vmesni/končni zapis na disk med tem
  // pregledom spodletel (glej saveAllFolders() – zdaj vrača true/false) – uporabljeno spodaj, da
  // končno sporočilo ("Pregled končan.") NE zavaja, če je bila dejansko kakšna mapa nezapisana.
  let anySaveFailed = false;

  if (toProcess.length > 0) {
    const langs = selectedLangs();
    const profile = optOcrQuality.value === 'accurate' ? 'accurate' : 'fast';
    // Popravek (2026-09-24, worker pool – glej DEFAULT_WORKER_POOL_SIZE/getWorker()/getWorkerPoolSize()
    // zgoraj): velikost poola dodatno omejimo na št. datotek za obdelavo – ni smisla pripraviti npr.
    // 6 worker-jev za 2 sliki.
    const poolSize = Math.max(1, Math.min(getWorkerPoolSize(), toProcess.length));
    setProgress(true, 0, `Nalagam OCR mehanizem (${langs.join('+').toUpperCase()}, ${profile === 'accurate' ? 'natančno' : 'hitro'}${poolSize > 1 ? `, ${poolSize} vzporedno` : ''}) …`);
    try {
      // Popravek C (QA najdba, 2026-09-22, ČETRTI KROG) – glej withTimeout()/OCR_WORKER_TIMEOUT_MS
      // zgoraj: brez tega bi ta klic v nekaterih okoljih (dokazano: file:// v Chromium) lahko
      // obvisel v neskončnost, ne da bi kdaj dosegel spodnji catch. Vsi worker-ji v poolu se
      // pripravijo VZPOREDNO (Promise.all) – ne zaporedno, da priprava sama ne izniči prihranka časa.
      await Promise.all(Array.from({ length: poolSize }, (_, slot) => withTimeout(
        getWorker(profile, langs, slot), OCR_WORKER_TIMEOUT_MS, `nalaganje OCR mehanizma (worker ${slot + 1}/${poolSize})`,
      )));
    } catch (e) {
      logEvent('error', `Napaka pri nalaganju OCR mehanizma (profil ${profile}, jeziki ${langs.join('+')}): ` + e.message, e);
      setStatus('Napaka pri nalaganju OCR mehanizma: ' + e.message + friendlyOcrErrorHint(e));
      setBusy(false); setProgress(false);
      return;
    }

    // Vzporedno OCR obdelovanje (worker pool): `cursor` je SKUPEN kazalec na naslednjo neobdelano
    // datoteko v `toProcess`, ki si ga vseh `poolSize` "delavcev" (poolWorker) deli. Branje in
    // povečanje `cursor` (`const i = cursor; cursor++;`) je NAMENOMA sinhrono, brez `await` vmes –
    // JavaScript izvaja vso sinhrono kodo na EDINI glavni niti (tudi znotraj `async` funkcij, dokler
    // ne naleti na `await`), zato med branjem in pisanjem `cursor` ne more "poseči" noben drug
    // sočasen `poolWorker` klic – ni potrebe po ločenem zaklepanju (mutex), ki ga JS niti nima.
    let cursor = 0;
    const total = toProcess.length;
    async function poolWorker(slot) {
      while (true) {
        if (stopRequested) return;
        if (cursor >= total) return;
        const i = cursor;
        cursor++;
        const f = toProcess[i];
        try {
          const text = await runOcr(f._fileObj, profile, langs, slot);
          f._indexDataRef.files[f.relPath] = {
            size: f.size, mtime: f.mtime, text, ocrAt: new Date().toISOString(), error: null, mode: profile,
          };
        } catch (e) {
          f._indexDataRef.files[f.relPath] = {
            size: f.size, mtime: f.mtime, text: '', ocrAt: new Date().toISOString(), error: String(e.message || e), mode: profile,
          };
          logEvent('error', `OCR napaka pri sliki (${logPath(f.relPath)}, profil ${profile}): ` + (e.message || e), e);
        }
        done++;
        setProgress(true, Math.round((done / total) * 100),
          `OCR (${done}/${total}${poolSize > 1 ? `, ${poolSize} vzporedno` : ''}, ${profile === 'accurate' ? 'natančno' : 'hitro'})`);
        // Vmesno shranjevanje na vsakih 15 datotek (SKUPNO, ne na worker), da se ob prekinitvi ne
        // izgubi delo – shrani VSE aktivne mape, ne le tisto, ki jo je obdelal TA worker.
        if (done % 15 === 0 && !(await saveAllFolders(activeCtxs))) anySaveFailed = true;
        // Tabelo med OCR osvežujemo le občasno (ne ob vsaki datoteki), da UI ostane odziven
        // tudi pri več sto/tisoč slikah – napredek prikazuje vrstica napredka zgoraj.
        if (done % 5 === 0 || done === total) renderTable();
      }
    }
    await Promise.all(Array.from({ length: poolSize }, (_, slot) => poolWorker(slot)));
  }

  if (!(await saveAllFolders(activeCtxs))) anySaveFailed = true;
  const durationSec = ((Date.now() - scanStartedAt) / 1000).toFixed(1);
  logEvent('info', `Pregled končan v ${durationSec}s – ${currentFiles.length} slik skupaj, ${toProcess.length} obdelanih z OCR.`);
  // Popravek (grillme-custom, 2026-09-23 – FAZA 2, glej HISTORY_AI_AGENT.txt): prej je sporočilo ob
  // ustavitvi ("Ustavljeno – delni rezultati so shranjeni.") povedalo SAMO, da so delni rezultati
  // shranjeni, ne pa TUDI, koliko slik je bilo dejansko obdelanih pred ustavitvijo – ta podatek je bil
  // sicer na kratko viden v vrstici napredka med samim OCR-jem, a je po ustavitvi izginil. Zdaj je
  // natančno število (doneCount/toProcessTotal) del samega sporočila o ustavitvi.
  // Popravek (QA krog 2026-09-24): če je KATERIKOLI zapis na disk med tem pregledom spodletel
  // (glej `anySaveFailed` zgoraj), to zdaj DODATNO piše v končno sporočilo – prej bi "Pregled
  // končan."/"Ustavljeno – delni rezultati so shranjeni." zavajajoče trdilo uspeh, tudi če je bila
  // dejansko katera od map nezapisana (edini sled je bil samo rdeč indikator na gumbu "Dnevnik").
  const saveWarning = anySaveFailed ? ' OPOZORILO: zapis na disk ni uspel za eno ali več map – glej "Dnevnik".' : '';
  finishScan(stopRequested
    ? `Ustavljeno – delni rezultati so shranjeni (obdelanih ${done}/${toProcess.length}).${saveWarning}`
    : `Pregled končan.${saveWarning}`);
}

function finishScan(msg) {
  // Popravek (grillme-custom, 2026-09-23 - FAZA 2, glej HISTORY_AI_AGENT.txt): naslov zavihka se ob
  // zaključku (dolgega) pregleda spremeni, da je zaznaven tudi, če je uporabnik medtem preklopil na
  // drug zavihek/aplikacijo - vrne se na izvirni naslov ob naslednjem začetku novega pregleda (glej
  // rescan()).
  document.title = (stopRequested ? '⏸ Ustavljeno – ' : '✓ Končano – ') + ORIGINAL_TAB_TITLE;
  setBusy(false);
  setProgress(false);
  setStatus(msg, `${currentFiles.length} slik v indeksu`);
  renderTable();
}

function stopScan() {
  stopRequested = true;
  logEvent('info', 'Uporabnik je zahteval ustavitev pregleda.');
  setStatus('Ustavljam po trenutni datoteki …');
}

// ---------- Posamični "Natančno" OCR za eno vrstico ----------

// Popravek (2026-09-24, dodatne mape): parameter je zdaj `uid` (glej rescan() – `f._uid`, unikaten
// znotraj TRENUTNEGA `currentFiles`), NE VEČ `relPath` – z več aktivnimi mapami se lahko ista
// relativna pot pojavi v DVEH RAZLIČNIH mapah hkrati, zato bi `currentFiles.find((x) => x.relPath
// === relPath)` lahko našel/urejal NAPAČNO vrstico (vedno PRVO ujemanje po vrstnem redu v seznamu).
async function reOcrSingle(uid, btnEl) {
  const f = currentFiles.find((x) => x._uid === uid);
  if (!f) return;
  const relPath = f.relPath; // za sporočila/dnevnik – dejanska pot ZNOTRAJ njene lastne mape
  if (scanning) {
    logEvent('warn', `"Natančno" preklicano (${logPath(relPath)}) – najprej se mora zaključiti pregled mape, ki je v teku.`);
    setStatus('Počakajte, da se zaključi pregled mape, nato poskusite znova.');
    return;
  }
  if (singleOcrBusy) {
    // Zaščita pred dvojnim klikom/sočasnim sprožanjem ISTE ali DRUGE vrstice: gumb bi se
    // sicer po vsakem vmesnem renderTable() poklicu (npr. med tipkanjem v iskalno polje)
    // videti spet "omogočen" (glej QA #6), čeprav prejšnji "Natančno" še ni končan.
    const prevF = currentFiles.find((x) => x._uid === singleOcrUid);
    logEvent('warn', `"Natančno" preklicano (${logPath(relPath)}) – druga slika (${logPath(prevF ? prevF.relPath : '?')}) se še obdeluje.`);
    setStatus('Počakajte, da se zaključi "Natančno" OCR prejšnje slike, nato poskusite znova.');
    return;
  }
  singleOcrBusy = true;
  singleOcrUid = uid;
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '…'; }
  // Onemogoči tudi "Ponovno preglej" (in izbiro mape), da je izključenost vidna
  // uporabniku, ne le interno – prej je gumb ostal videti klikljiv (glej QA #6).
  btnRescan.disabled = true;
  btnPickFolder.disabled = true;
  btnReopenLast.disabled = true;
  if (btnAddFolder) btnAddFolder.disabled = true;
  setStatus(`Natančen OCR: ${relPath} …`);
  try {
    const fileObj = f._fileObj || await f.handle.getFile();
    const langs = selectedLangs();
    const text = await runOcr(fileObj, 'accurate', langs);
    f._indexDataRef.files[relPath] = {
      size: f.size, mtime: f.mtime, text, ocrAt: new Date().toISOString(), error: null, mode: 'accurate',
    };
    // Popravek (QA krog 2026-09-24): saveForCtx() zdaj vrne uspeh/neuspeh – če zapis na disk NI uspel
    // (npr. mapa je med sejo postala nedosegljiva), to POVEMO uporabniku TUKAJ, namesto da bi
    // spodnje sporočilo o uspehu prepisalo opozorilo, ki ga je saveIndexFileCore() že nastavil.
    const saveOk = await saveForCtx(f._folderCtx);
    setStatus(saveOk
      ? `Natančen OCR končan: ${relPath}`
      : `Natančen OCR končan (besedilo prepoznano), a zapisa na disk NI bilo mogoče izvesti – glej "Dnevnik": ${relPath}`);
  } catch (e) {
    logEvent('error', `Napaka pri natančnem (accurate) OCR posamezne slike (${logPath(relPath)}): ` + e.message, e);
    setStatus('Napaka pri natančnem OCR: ' + e.message + friendlyOcrErrorHint(e));
  } finally {
    singleOcrBusy = false;
    singleOcrUid = null;
    btnRescan.disabled = !dirHandle || scanning;
    btnPickFolder.disabled = scanning;
    btnReopenLast.disabled = scanning || btnReopenLast.title === '';
    if (btnAddFolder) btnAddFolder.disabled = scanning || !dirHandle;
    renderTable();
  }
}

// ---------- Iskalna sintaksa (podobno Everything: AND/OR/NOT, wildcard, ext:/path:/size:/dm:/content:) ----------

function wildcardToRegexSource(str) {
  const esc = str.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return esc.replace(/\*/g, '.*').replace(/\?/g, '.');
}

// Skupni "ne ujema se ničesar" rezultat, uporabljen pri vseh trdih omejitvah spodaj
// (predolg izraz / preveč nadomestnih znakov / nevarno gnezden regex) – ista oblika kot
// neveljaven regex, da preostala koda (highlight, filter) ni potrebno posebej obravnavati.
const NO_MATCH_TEST = { test: () => false, regex: null };

// TRDA OMEJITEV proti ReDoS V REGEX NAČINU (QA najdba #1, 2026-09-22, DRUGI KROG – glej
// HISTORY_AI_AGENT.txt): PRVA različica te zaščite (glej zgodovino) je ščitila samo GNEZDENE
// neomejene ponovitve (npr. "(a+)+") in je bila v naslednjem QA krogu (isti dan) DOKAZANO
// nezadostna – vsi trije neodvisni QA podagenti so empirično potrdili DVA ločena obhoda, oba z
// dejansko izmerjeno zamrznitvijo zavihka za 40+ s:
//   (1) "[^](a+)+" – napaka pri razčlenjevanju razreda znakov: pri VEDNO vklopljeni zastavici 'u'
//       (glej flags spodaj) je PRVI ']' po '[' ali '[^' VEDNO zaključek razreda (za razliko od
//       starejšega ne-u načina) – prejšnja različica je to narobe preskočila kot "dobeseden znak"
//       in s tem "pregledala" mimo ostanka vzorca, ne da bi ga sploh analizirala.
//   (2) "a*a*a*a*a*a*a*a*a*a*b" (10+ SOSEDNJIH, NE gnezdenih neomejenih ponovitev na isti/prekrivajoč
//       se del besedila) in podobno "(a+)(a+)(a+)...(a+)b" (več LOČENIH skupin) – druga, LOČENA
//       družina katastrofalnega vračanja nazaj, ki je gnezdenju namenjena evristika strukturno ni
//       mogla zaznati, ker sploh ne gleda SKUPNEGA števila neomejenih ponovitev v celem vzorcu.
// Ta (druga) različica zato: (a) PRAVILNO razčlenjuje razred znakov pod 'u' zastavico (glej [ spodaj);
// (b) poleg gnezdenja DODATNO šteje SKUPNO število neomejenih ponovitev (+, *, {n,} in tudi posamezen
// '?', ki lahko v dolgi verigi prav tako povzroči eksponentno vejitev) v CELEM vzorcu in zavrne vzorec,
// če preseže MAX_REGEX_UNBOUNDED_QUANTIFIERS – isto trdo, NE časovno omejitev kot doslej, in isti
// prag (5) kot že uveljavljen MAX_WILDCARDS_PER_TERM, zaradi doslednosti. Namenoma konzervativna
// (lahko zavrne tudi kak redek neškodljiv vzorec, npr. z veliko ločenimi + na različnih delih) – v
// prid varnosti pred zmrznitvijo vmesnika. Preverjeno z več kot 30 ročnimi/avtomatiziranimi testi
// (znani nevarni IN znani neškodljivi vzorci) – glej HISTORY_AI_AGENT.txt za podroben seznam.
const MAX_REGEX_UNBOUNDED_QUANTIFIERS = 5;

function hasUnsafeRegexNesting(src) {
  let i = 0;
  const n = src.length;
  const stack = []; // za vsako odprto "(" skupino: ali njena VSEBINA vsebuje neomejeno ponovitev/alternacijo
  let totalUnbounded = 0; // SKUPNO število neomejenih ponovitev v CELEM vzorcu (ne le gnezdenih)
  let dangerFound = false;
  while (i < n && !dangerFound) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; } // preskoči ubežno zaporedje (npr. \( \+ \d)
    if (c === '[') {
      // Preskoči cel razred znakov – znotraj [...] * + { ? niso kvantifikatorji. Ta regex VEDNO
      // uporablja zastavico 'u' (glej flags v makeTextTest), zato je PRVI ']' po '[' ali '[^' VEDNO
      // zaključek razreda (npr. "[]" = prazen razred, "[^]" = katerikoli znak) – BREZ starejše
      // ne-u izjeme "vodilni ']' je dobeseden znak", ki je v prejšnji različici povzročila obhod (1).
      i++;
      if (src[i] === '^') i++;
      while (i < n && src[i] !== ']') { if (src[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '(') { stack.push({ rep: false, alt: false }); i++; continue; }
    if (c === '|') {
      if (stack.length > 0) stack[stack.length - 1].alt = true;
      i++;
      continue;
    }
    if (c === ')') {
      const frame = stack.pop() || { rep: false, alt: false };
      i++;
      let unboundedFollows = false;
      let optionalOnly = false;
      if (src[i] === '+' || src[i] === '*') { unboundedFollows = true; i++; }
      else if (src[i] === '{') {
        const m = /^\{\d*,\d*\}/.exec(src.slice(i));
        if (m) { unboundedFollows = true; i += m[0].length; }
      } else if (src[i] === '?') { optionalOnly = true; i++; }
      if (unboundedFollows || optionalOnly) totalUnbounded++;
      // NEVARNO (obhod tipa "gnezdenje"): skupina, ki je ŽE vsebovala neomejeno ponovitev ALI
      // alternacijo, je SAMA znova neomejeno ponovljena – klasičen vzorec eksponentnega backtrackinga.
      if (unboundedFollows && (frame.rep || frame.alt)) { dangerFound = true; break; }
      // "prenesi" tveganje navzgor (za primere gnezdenja skozi več ravni, npr. ((a+)?)+)
      const bubble = frame.rep || frame.alt || unboundedFollows;
      if (stack.length > 0) stack[stack.length - 1].rep = stack[stack.length - 1].rep || bubble;
      continue;
    }
    if (c === '+' || c === '*') {
      totalUnbounded++;
      if (stack.length > 0) stack[stack.length - 1].rep = true;
      i++;
      continue;
    }
    if (c === '{') {
      const m = /^\{\d*,\d*\}/.exec(src.slice(i));
      if (m && m[0].includes(',')) {
        totalUnbounded++;
        if (stack.length > 0) stack[stack.length - 1].rep = true;
      }
      i += (m ? m[0].length : 1);
      continue;
    }
    if (c === '?') {
      // Posamezen bare '?' ni nevaren (npr. "colou?r"), a MNOGO takih na en vzorec (tudi
      // razpršenih, ne nujno zaporednih) je znan LOČEN vir eksponentnega ReDoS – obhod (2) zgoraj,
      // varianta z verigo neodvisnih izbirnih znakov (npr. "a?a?a?...aaaa"). Zato šteje v ISTO
      // skupno trdo mejo kot +/*/{n,}.
      totalUnbounded++;
      if (stack.length > 0) stack[stack.length - 1].rep = true;
      i++;
      continue;
    }
    i++;
  }
  return dangerFound || totalUnbounded > MAX_REGEX_UNBOUNDED_QUANTIFIERS;
}

function makeTextTest(rawValue, settings) {
  let value = rawValue;
  let isPhrase = false;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
    isPhrase = true;
  }

  // TRDA OMEJITEV 1: dolžina izraza (velja za vse načine – fraza/regex/wildcard).
  // Prepreči tudi ogromne prilepljene nize, ki bi po nepotrebnem gradili velike regexe.
  if (value.length > MAX_SEARCH_TERM_LENGTH) {
    if (lastBadWildcardSrc !== value) {
      lastBadWildcardSrc = value;
      logEvent('warn', `Izraz je predolg (${value.length} znakov, dovoljeno največ ${MAX_SEARCH_TERM_LENGTH}) – ignoriran.`);
    }
    return NO_MATCH_TEST;
  }

  let src;
  if (settings.regex) {
    // TRDA OMEJITEV proti ReDoS v regex načinu (QA najdba #1, 2026-09-22, glej DRUGI KROG v
    // HISTORY_AI_AGENT.txt) – glej hasUnsafeRegexNesting() zgoraj. Zavrne bodisi gnezdene neomejene
    // ponovitve (npr. "(x+)+", "(a|aa)+") BODISI prevelikO SKUPNO število neomejenih ponovitev v
    // vzorcu (npr. mnogo ločenih "a*a*a*..." ali "?" v verigi), tudi brez gnezdenja.
    if (hasUnsafeRegexNesting(value)) {
      if (lastUnsafeRegexSrc !== value) {
        lastUnsafeRegexSrc = value;
        logEvent('warn', `Regularni izraz vsebuje potencialno nevarno (gnezdeno ali preštevilno) ponovitev/alternacijo (npr. oblike "(x+)+", "(a|aa)+" ali mnogo ločenih "*"/"+"/"?"): "${value}" – izraz ignoriran, da se prepreči zamrznitev vmesnika. Poenostavite vzorec (odstranite gnezdeno ponovitev ali zmanjšajte število neomejenih ponovitev na največ ${MAX_REGEX_UNBOUNDED_QUANTIFIERS}).`);
      }
      return NO_MATCH_TEST;
    }
    src = value;
  } else if (isPhrase) {
    src = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  } else {
    // TRDA OMEJITEV 2: največje dovoljeno število nadomestnih znakov (*/?) v enem
    // izrazu. Razlog: wildcardToRegexSource() vsak '*' pretvori v '.*' – več
    // zaporednih '.*' proti besedilu, ki se NE ujema v celoti, sproži katastrofalen
    // regex "backtracking" (dokazano v QA testiranju: zamrznitev cele strani za
    // desetine sekund že pri ~30 zaporednih '*'). To NI omejitev pri fraznem ("...")
    // ali regex iskanju, ker tam do te specifične pretvorbe ne pride.
    const wildcardCount = (value.match(/[*?]/g) || []).length;
    if (wildcardCount > MAX_WILDCARDS_PER_TERM) {
      if (lastBadWildcardSrc !== value) {
        lastBadWildcardSrc = value;
        logEvent('warn', `Preveč nadomestnih znakov (* ali ?) v enem izrazu: "${value}" (${wildcardCount}, dovoljeno največ ${MAX_WILDCARDS_PER_TERM}) – izraz ignoriran, da se prepreči zamrznitev vmesnika.`);
      }
      return NO_MATCH_TEST;
    }
    src = wildcardToRegexSource(value);
  }
  if (settings.wholeWord && !settings.regex) {
    src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  }
  const flags = (settings.matchCase ? '' : 'i') + 'u';
  let regex = null;
  try {
    regex = new RegExp(src, flags);
  } catch (e) {
    regex = null; // neveljaven regex/wildcard izraz – ne ujema ničesar (uporabnik dobi opozorilo spodaj)
    // Med tipkanjem se ta funkcija kliče zelo pogosto (ob vsakem pritisku tipke) – da dnevnik
    // ne poplavi z identičnimi vnosi, zabeležimo samo, če se je "slab" izraz spremenil.
    if (lastBadRegexSrc !== src) {
      lastBadRegexSrc = src;
      logEvent('warn', `Neveljaven regularni izraz v iskalnem nizu (ni bilo ujemanja): "${src}" – ${e.message}`);
    }
  }
  return { test: (str) => (regex ? regex.test(str) : false), regex };
}

function parseSizeToken(v) {
  const units = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
  function parseOne(s) {
    const m = s.trim().match(/^([\d.]+)\s*(b|kb|mb|gb)?$/i);
    if (!m) return null;
    const num = parseFloat(m[1]);
    const u = (m[2] || 'b').toLowerCase();
    return num * (units[u] || 1);
  }
  v = v.trim();
  let m = v.match(/^(>=|<=|>|<)(.+)$/);
  if (m) {
    const op = m[1]; const bytes = parseOne(m[2]);
    if (bytes == null) return null;
    return (sz) => (op === '>' ? sz > bytes : op === '<' ? sz < bytes : op === '>=' ? sz >= bytes : sz <= bytes);
  }
  if (v.includes('-')) {
    const [a, b] = v.split('-');
    const lo = parseOne(a), hi = parseOne(b);
    if (lo == null || hi == null) return null;
    return (sz) => sz >= lo && sz <= hi;
  }
  const bytes = parseOne(v);
  if (bytes == null) return null;
  return (sz) => sz >= bytes;
}

function parseDmToken(v) {
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  v = v.trim().toLowerCase();
  const now = new Date();
  const today0 = startOfDay(now);
  const oneDay = 86400000;
  let range = null;

  if (v === 'today') range = [today0, today0 + oneDay];
  else if (v === 'yesterday') range = [today0 - oneDay, today0];
  else if (v === 'thisweek' || v === 'lastweek') {
    const dayIdx = (now.getDay() + 6) % 7; // ponedeljek = 0
    let monday = today0 - dayIdx * oneDay;
    if (v === 'lastweek') monday -= 7 * oneDay;
    range = [monday, monday + 7 * oneDay];
  } else if (v === 'thismonth' || v === 'lastmonth') {
    const y = now.getFullYear(); const mo = now.getMonth() + (v === 'lastmonth' ? -1 : 0);
    range = [new Date(y, mo, 1).getTime(), new Date(y, mo + 1, 1).getTime()];
  } else if (v === 'thisyear') {
    range = [new Date(now.getFullYear(), 0, 1).getTime(), new Date(now.getFullYear() + 1, 0, 1).getTime()];
  } else {
    const m = v.match(/^(>=|<=|>|<)(.+)$/);
    if (m) {
      const t = Date.parse(m[2]);
      if (isNaN(t)) return null;
      const op = m[1];
      return (mtime) => (op === '>' ? mtime > t : op === '<' ? mtime < t : op === '>=' ? mtime >= t : mtime <= t);
    }
    if (/^\d{4}$/.test(v)) {
      range = [new Date(+v, 0, 1).getTime(), new Date(+v + 1, 0, 1).getTime()];
    } else if (/^\d{4}-\d{2}$/.test(v)) {
      const [y, mo] = v.split('-').map(Number);
      range = [new Date(y, mo - 1, 1).getTime(), new Date(y, mo, 1).getTime()];
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const s = startOfDay(new Date(v));
      range = [s, s + oneDay];
    } else {
      return null;
    }
  }
  if (!range) return null;
  return (mtime) => mtime >= range[0] && mtime < range[1];
}

function tokenizeQuery(query) {
  const tokens = [];
  let cur = '';
  let inQuotes = false;
  const push = () => { if (cur.length) { tokens.push(cur); cur = ''; } };
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (c === '"') { inQuotes = !inQuotes; cur += c; continue; }
    if (!inQuotes && /\s/.test(c)) { push(); continue; }
    if (!inQuotes && c === '|') { push(); tokens.push('|'); continue; }
    cur += c;
  }
  // Popravek QA najdbe #9 (2026-09-22, DRUGI KROG – FAZA 1, glej HISTORY_AI_AGENT.txt): nezaprt
  // narekovaj (npr. iskalni niz `"abc def`) je prej pustil `inQuotes` odprt do konca niza –
  // presledki znotraj se niso razdelili na ločene izraze, dobljeni niz pa (ker se NE konča z `"`,
  // le začne z njim) v makeTextTest() sploh ni bil prepoznan kot fraza, temveč kot en sam dobesedni/
  // nadomestni ("wildcard") izraz z vključenim narekovajem – iskanje je tiho "prenehalo delovati",
  // brez kakršnegakoli opozorila uporabniku. Zdaj manjkajoči zaključni narekovaj SAMODEJNO dodamo
  // (najverjetnejša uporabnikova namera – fraza do konca vnosa) IN uporabnika enkratno (dedupl.)
  // opozorimo, da lahko po potrebi popravi vnos.
  if (inQuotes) {
    cur += '"';
    if (lastUnclosedQuoteQuery !== query) {
      lastUnclosedQuoteQuery = query;
      logEvent('warn', `Iskalni niz vsebuje nezaprt narekovaj (") – zaključni narekovaj je bil samodejno dodan na konec (obravnavano kot fraza do konca vnosa).`);
    }
  }
  push();
  return tokens;
}

function groupByOr(tokens) {
  const groups = [[]];
  for (const t of tokens) {
    if (t === '|') groups.push([]);
    else groups[groups.length - 1].push(t);
  }
  return groups.filter((g) => g.length > 0);
}

const PREFIX_RE = /^(ext|path|name|content|ocr|size|dm):(.*)$/i;

function compileTerm(rawTerm, settings) {
  let term = rawTerm;
  let negate = false;
  if (term.startsWith('!')) { negate = true; term = term.slice(1); }
  if (!term) return null;

  const pm = term.match(PREFIX_RE);
  let testFn = null;

  if (pm) {
    const key = pm[1].toLowerCase();
    const value = pm[2];
    if (key === 'ext') {
      const exts = value.replace(/^"|"$/g, '').split(/[;,]/).map((s) => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
      testFn = (row) => exts.includes(extOf(row.name));
    } else if (key === 'path') {
      const m = makeTextTest(value, settings);
      testFn = (row) => m.test(row.folder);
    } else if (key === 'name') {
      const m = makeTextTest(value, settings);
      testFn = (row) => m.test(row.name);
    } else if (key === 'content' || key === 'ocr') {
      const m = makeTextTest(value, settings);
      testFn = (row) => m.test(row.text);
    } else if (key === 'size') {
      const cmp = parseSizeToken(value);
      testFn = cmp ? (row) => cmp(row.size) : () => false;
    } else if (key === 'dm') {
      const cmp = parseDmToken(value);
      testFn = cmp ? (row) => cmp(row.mtime) : () => false;
    }
  } else {
    // Če navaden izraz (brez predpone) vsebuje ločilo poti ("/" ali "\"), ga – kot v Everything –
    // obravnavamo kot del RELATIVNE POTI (mapa + ime datoteke) znotraj izbrane mape, ne kot navadno
    // besedilo. Primer: "projekti/2024" ali "projekti\2024" najde datoteke pod to (pod)mapo.
    const unwrapped = (term.length >= 2 && term.startsWith('"') && term.endsWith('"')) ? term.slice(1, -1) : term;
    if (/[\\/]/.test(unwrapped)) {
      const normalized = unwrapped.replace(/\\/g, '/');
      const rebuilt = term.startsWith('"') ? `"${normalized}"` : normalized;
      const m = makeTextTest(rebuilt, settings);
      testFn = (row) => m.test(row.relPath);
    } else {
      const m = makeTextTest(term, settings);
      testFn = (row) => (settings.searchName && m.test(row.name))
        || (settings.searchPath && m.test(row.folder))
        || (settings.searchContent && m.test(row.text));
    }
  }

  if (!testFn) return null;
  return negate ? (row) => !testFn(row) : testFn;
}

function parseQuery(query, settings) {
  const trimmed = query.trim();
  if (!trimmed) return () => true;
  if (trimmed.length > MAX_QUERY_LENGTH) {
    if (lastTooLongQuery !== trimmed) {
      lastTooLongQuery = trimmed;
      logEvent('warn', `Iskalni niz je predolg (${trimmed.length} znakov, dovoljeno največ ${MAX_QUERY_LENGTH}) – razčlenjevanje preskočeno, iskanje ne bo ujemalo ničesar.`);
    }
    return () => false;
  }
  const tokens = tokenizeQuery(trimmed);
  const orGroups = groupByOr(tokens).map((group) => group.map((t) => compileTerm(t, settings)).filter(Boolean));
  const validGroups = orGroups.filter((g) => g.length > 0);
  if (validGroups.length === 0) return () => true;
  return (row) => validGroups.some((group) => group.every((fn) => fn(row)));
}

function buildHighlightRegexes(qRaw, settings) {
  const trimmed = qRaw.trim();
  if (!trimmed) return [];
  if (trimmed.length > MAX_QUERY_LENGTH) return []; // glej isto omejitev/opozorilo v parseQuery()
  const tokens = tokenizeQuery(trimmed);
  const regexes = [];
  for (const rawTerm of tokens) {
    if (rawTerm === '|') continue;
    let term = rawTerm;
    if (term.startsWith('!')) continue; // izločitvenih izrazov ne označujemo
    const pm = term.match(PREFIX_RE);
    let value = null;
    if (pm) {
      const key = pm[1].toLowerCase();
      if (key === 'content' || key === 'ocr') value = pm[2];
    } else {
      const unwrapped = (term.length >= 2 && term.startsWith('"') && term.endsWith('"')) ? term.slice(1, -1) : term;
      const isPathLike = /[\\/]/.test(unwrapped);
      if (settings.searchContent && !isPathLike) value = term;
    }
    if (value == null || !value.length) continue;
    const built = makeTextTest(value, settings);
    if (built.regex) regexes.push(built.regex);
  }
  return regexes;
}

function currentSearchSettings() {
  return {
    matchCase: optMatchCase.checked,
    wholeWord: optWholeWord.checked,
    regex: optRegex.checked,
    searchName: optSearchName.checked,
    searchPath: optSearchPath.checked,
    searchContent: optSearchContent.checked,
  };
}

// ---------- Izris tabele ----------

function buildRows() {
  const rows = [];
  for (const f of currentFiles) {
    // Popravek (2026-09-24, dodatne mape): iskanje zapisa gre zdaj prek `f._indexDataRef` (LASTEN
    // indeks mape, iz katere ta vrstica izvira – glej walkDirectory()/rescan()) namesto golega
    // globalnega `indexData`, ki je predstavljal SAMO primarno mapo.
    const entry = f._indexDataRef.files[f.relPath];
    const error = (entry && entry.error) || f._error || null;
    const hasEntry = !!entry;
    const mode = entry ? entry.mode : null;
    // Numerično polje samo za razvrščanje po stolpcu "Status" (glej index.html
    // data-key="statusRank"): napaka najprej (najbolj pereče), nato neobdelano
    // ("čaka"), nato hitro obdelano, nazadnje natančno obdelano.
    let statusRank;
    if (error) statusRank = 0;
    else if (!hasEntry) statusRank = 1;
    else if (mode === 'accurate') statusRank = 3;
    else statusRank = 2;
    rows.push({
      uid: f._uid,
      relPath: f.relPath,
      name: f.name,
      folder: f.folder,
      size: f.size || 0,
      mtime: f.mtime || 0,
      text: (entry && entry.text) || '',
      error,
      mode,
      hasEntry,
      statusRank,
    });
  }
  return rows;
}

function highlightSnippet(text, regexes) {
  for (const re of regexes) {
    let m;
    try { m = re.exec(text); } catch (e) { m = null; logEvent('debug', 'Napaka pri iskanju odlomka za označevanje (highlight): ' + e.message, e); }
    if (m && m[0] !== undefined) {
      const idx = m.index;
      const len = m[0].length || 1;
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + len + 60);
      const before = (start > 0 ? '…' : '') + escapeHtml(text.slice(start, idx));
      const match = escapeHtml(text.slice(idx, idx + len));
      const after = escapeHtml(text.slice(idx + len, end)) + (end < text.length ? '…' : '');
      return `${before}<mark>${match}</mark>${after}`;
    }
  }
  return '';
}

function applyFilterAndSort() {
  const qRaw = searchBox.value;
  const settings = currentSearchSettings();
  let matchFn;
  try {
    matchFn = parseQuery(qRaw, settings);
    setStatus(undefined);
  } catch (e) {
    matchFn = () => true;
    logEvent('warn', 'Napaka pri razčlenjevanju iskalnega niza "' + qRaw + '": ' + e.message, e);
    setStatus('Napaka v iskalnem izrazu – prikazani vsi rezultati: ' + e.message);
  }

  const all = buildRows();
  filteredRows = all.filter(matchFn);

  filteredRows.sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase(); }
    if (av < bv) return -1 * sortDir;
    if (av > bv) return 1 * sortDir;
    return 0;
  });

  return { qRaw, settings };
}

function renderTable() {
  const { qRaw, settings } = applyFilterAndSort();
  const highlightRegexes = buildHighlightRegexes(qRaw, settings);
  const hasAny = currentFiles.length > 0;
  emptyState.style.display = hasAny ? 'none' : 'block';
  resultsTable.style.display = hasAny ? 'table' : 'none';

  const rowsHtml = filteredRows.map((r) => {
    let statusBadge;
    if (r.error) statusBadge = `<span class="badge err" title="${escapeHtml(r.error)}">napaka</span>`;
    else if (!r.hasEntry) statusBadge = `<span class="badge pending">čaka</span>`;
    else statusBadge = `<span class="badge ok">OCR ✓</span><span class="badge mode">${r.mode === 'accurate' ? 'natančno' : 'hitro'}</span>`;

    const snippet = highlightRegexes.length ? highlightSnippet(r.text, highlightRegexes) : escapeHtml(r.text.slice(0, 90)).trim();
    // Popravek (2026-09-24, dodatne mape): `data-uid` (glej buildRows()/rescan() – `f._uid`) namesto
    // `data-path`/relPath za IDENTIFIKACIJO vrstice (openImageRow()/reOcrSingle()) – relPath sam po
    // sebi ni več nujno unikaten, odkar je lahko aktivnih več map hkrati. "Kopiraj pot" (copyPathRow)
    // pa NAMENOMA ostane vezan na dejansko pot (encPath), saj samo kopira BESEDILO poti, brez iskanja
    // po currentFiles – tam ne gre za identifikacijo vrstice, ampak za vsebino gumba.
    const uid = r.uid;
    const encPath = encodeURIComponent(r.relPath);
    const isBusyRow = singleOcrBusy && r.uid === singleOcrUid;
    const accurateBtnHtml = isBusyRow
      ? `<button class="small btnAccurate" data-uid="${uid}" disabled title="Natančen OCR te slike je v teku …">…</button>`
      : `<button class="small btnAccurate" data-uid="${uid}" title="Ponovno preberi to sliko z natančnejšim (počasnejšim) OCR in izboljšano sliko">Natančno</button>`;

    return `<tr data-uid="${uid}">
      <td class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
      <td class="folder" title="${escapeHtml(r.folder)}">${escapeHtml(r.folder)}</td>
      <td class="size">${fmtSize(r.size)}</td>
      <td class="modified">${r.mtime ? fmtDate(r.mtime) : '—'}</td>
      <td class="status">${statusBadge}</td>
      <td class="snippet">${snippet || '<span style="opacity:.5">(brez besedila)</span>'}</td>
      <td class="actions">
        <button class="small btnOpen" data-uid="${uid}" title="Odpri sliko v novem zavihku">Odpri</button>
        ${accurateBtnHtml}
        <button class="small btnCopyPath" data-path="${encPath}" title="Kopiraj relativno pot slike v odložišče">Kopiraj pot</button>
      </td>
    </tr>`;
  }).join('');

  resultsBody.innerHTML = rowsHtml;
  setStatus(undefined, `${filteredRows.length} / ${currentFiles.length} prikazanih`);
}

async function openImageRow(uid) {
  // Popravek (2026-09-24, dodatne mape): iskanje po `_uid` namesto `relPath` – glej reOcrSingle().
  const f = currentFiles.find((x) => x._uid === uid);
  if (!f) return;
  try {
    const file = f._fileObj || await f.handle.getFile();
    const url = URL.createObjectURL(file);
    window.open(url, '_blank');
    // Popravek uhajanja pomnilnika (QA najdba #2, 2026-09-22): URL.revokeObjectURL() se prej ni klical
    // NIKOLI – vsak "Odpri"/dvoklik je trajno zadržal sliko v pomnilniku za celo življenjsko dobo
    // zavihka. Enak vzorec kot pri exportDebugLog() (zamik 5 s), da ima novoodprti zavihek dovolj časa
    // naložiti sliko, preden se URL prekliče – po nalaganju slika v novem zavihku URL-ja ne potrebuje več.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    logEvent('error', `Slike ni bilo mogoče odpreti (${logPath(f.relPath)}): ` + e.message, e);
    alert('Slike ni bilo mogoče odpreti: ' + e.message);
  }
}

// Gumb "Kopiraj pot" (dogovorjeno z uporabnikom, 2026-09-24): brskalnik iz varnostnih razlogov
// ne razkriva resnične poti slike na disku in nima API-ja za "odpri/pokaži mapo v Raziskovalcu"
// (File System Access API namerno ne izpostavlja poti zunaj peskovnika). Kot alternativa
// kopiramo RELATIVNO pot slike (glede na izbrano korensko mapo) v odložišče, da jo uporabnik
// sam prilepi v naslovno vrstico Raziskovalca Windows.
async function copyPathRow(relPath, btnEl) {
  try {
    await navigator.clipboard.writeText(relPath);
    if (btnEl) {
      const prevText = btnEl.textContent;
      btnEl.textContent = 'Kopirano ✓';
      setTimeout(() => { btnEl.textContent = prevText; }, 1500);
    }
  } catch (e) {
    logEvent('error', `Poti ni bilo mogoče kopirati v odložišče (${logPath(relPath)}): ` + e.message, e);
    setStatus('Poti ni bilo mogoče kopirati v odložišče: ' + e.message);
  }
}

// ---------- Dogodki ----------
// Vsi klici, ki jih sproži uporabnik, so speljani skozi guard() (glej definicijo
// zgoraj) – tako se NOBEN klik/vnos ne konča "v tišini", če pride do nepričakovane
// napake: uporabnik dobi sporočilo v vrstici stanja, podrobnosti pa pristanejo v
// dnevniku (gumb "Dnevnik"), ne glede na to, ali ima odprto konzolo brskalnika.

btnPickFolder.addEventListener('click', guard(pickFolder, 'izbira mape'));
btnReopenLast.addEventListener('click', guard(reopenLastFolder, 'odpri zadnjo mapo'));
if (btnAddFolder) btnAddFolder.addEventListener('click', guard(addExtraFolder, 'dodaj mapo'));
if (extraFoldersList) {
  extraFoldersList.addEventListener('click', guard((e) => {
    const removeBtn = e.target.closest('.folderChipRemove');
    if (removeBtn) removeExtraFolder(Number(removeBtn.dataset.chipId));
  }, 'odstrani dodatno mapo'));
}
// Ovito v puščično funkcijo (QA najdba #22, 2026-09-22, TRETJI KROG), da se klikovni DOM Event NE
// posreduje kot argument `fromFolderOpen` funkciji rescan() – gumbov klik mora VEDNO iti skozi
// zaščito `folderOpBusy` v rescan(), medtem ko interni klic iz afterFolderSelected() to zavestno obide.
btnRescan.addEventListener('click', guard(() => rescan(), 'ponovno preglej'));
btnStop.addEventListener('click', guard(stopScan, 'ustavi pregled'));
btnToggleOptions.addEventListener('click', guard(() => searchOptionsPanel.classList.toggle('active'), 'možnosti iskanja'));
btnHelp.addEventListener('click', guard(() => helpOverlay.classList.add('active'), 'pomoč'));
btnHelpClose.addEventListener('click', guard(() => helpOverlay.classList.remove('active'), 'pomoč (zapri)'));
helpOverlay.addEventListener('click', guard((e) => { if (e.target === helpOverlay) helpOverlay.classList.remove('active'); }, 'pomoč (klik zunaj)'));

btnDebug.addEventListener('click', guard(() => { renderDebugPanel(); debugOverlay.classList.add('active'); }, 'dnevnik'));
btnDebugClose.addEventListener('click', guard(() => debugOverlay.classList.remove('active'), 'dnevnik (zapri)'));
debugOverlay.addEventListener('click', guard((e) => { if (e.target === debugOverlay) debugOverlay.classList.remove('active'); }, 'dnevnik (klik zunaj)'));
btnDebugExport.addEventListener('click', guard(exportDebugLog, 'izvoz dnevnika'));
btnDebugClear.addEventListener('click', guard(clearDebugLog, 'počisti dnevnik'));

document.addEventListener('keydown', guard((e) => {
  if (e.key === 'Escape') {
    helpOverlay.classList.remove('active');
    debugOverlay.classList.remove('active');
  }
}, 'tipkovnica (Escape)'));

searchBox.addEventListener('input', guard(renderTable, 'iskanje'));
[optMatchCase, optWholeWord, optRegex, optSearchName, optSearchPath, optSearchContent].forEach((cb) => {
  cb.addEventListener('change', guard(renderTable, 'možnosti iskanja'));
});
optNoPersistText.addEventListener('change', guard(() => {
  logEvent('info', optNoPersistText.checked
    ? 'Nastavitev "ne shranjuj OCR besedila na disk" je bila VKLOPLJENA – od naslednjega shranjevanja naprej besedilo ne bo zapisano v ocr-index.json.'
    : 'Nastavitev "ne shranjuj OCR besedila na disk" je bila IZKLOPLJENA – ob naslednjem "Ponovno preglej" bo besedilo za prizadete slike znova prebrano in zapisano v ocr-index.json.');
}, 'zasebnost (ne shranjuj besedila)'));

resultsBody.addEventListener('click', guard((e) => {
  // Popravek (2026-09-24, dodatne mape): "Odpri"/"Natančno" (in dvoklik spodaj) zdaj uporabljajo
  // `data-uid` (glej renderTable()) namesto `data-path`/relPath – glej reOcrSingle()/openImageRow().
  // "Kopiraj pot" ostaja na `data-path`, ker samo kopira besedilo poti, ne išče po currentFiles.
  const openBtn = e.target.closest('.btnOpen');
  if (openBtn) { openImageRow(Number(openBtn.dataset.uid)); return; }
  const accBtn = e.target.closest('.btnAccurate');
  if (accBtn) { reOcrSingle(Number(accBtn.dataset.uid), accBtn); return; }
  const copyBtn = e.target.closest('.btnCopyPath');
  if (copyBtn) { copyPathRow(decodeURIComponent(copyBtn.dataset.path), copyBtn); return; }
}, 'klik v tabeli'));

resultsBody.addEventListener('dblclick', guard((e) => {
  const tr = e.target.closest('tr');
  if (tr) openImageRow(Number(tr.dataset.uid));
}, 'dvoklik v tabeli'));

document.querySelectorAll('thead th[data-key]').forEach((th) => {
  th.addEventListener('click', guard(() => {
    const key = th.dataset.key;
    if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
    document.querySelectorAll('thead th').forEach((t) => t.classList.remove('sorted'));
    th.classList.add('sorted');
    th.dataset.dir = sortDir === 1 ? '▲' : '▼';
    renderTable();
  }, 'razvrščanje stolpca'));
});

if (!window.showDirectoryPicker) {
  setStatus('Ta brskalnik ne podpira potrebnega API-ja. Uporabite Chrome ali Edge.');
  btnPickFolder.disabled = true;
  logEvent('warn', 'Brskalnik ne podpira File System Access API (window.showDirectoryPicker manjka) – potreben je Chrome ali Edge.');
}

// Popravek B (QA najdba, 2026-09-22, ČETRTI KROG – glej HISTORY_AI_AGENT.txt): stran, odprta
// neposredno prek file:// (dvoklik na index.html), dobi nepregleden ("null") izvor, zaradi česar
// Chromium (Chrome/Edge) OCR worker-ju (Tesseract.js) blokira dostop do lokalnih datotek – dosledno
// potrjeno s testiranjem, ni odvisno od poti/kode aplikacije. Namesto da uporabnik to izve šele
// pozno (šele ob poskusu OCR-ja, prek kriptične napake brskalnika), ga opozorimo TAKOJ ob zagonu.
// Iskanje po IMENU/POTI datotek deluje naprej normalno tudi prek file:// – prizadet je SAMO OCR.
if (location.protocol === 'file:') {
  logEvent('warn', 'Aplikacija je odprta neposredno prek file:// (dvoklik na datoteko). OCR mehanizem '
    + '(Tesseract.js Worker) v Chrome/Edge v tem načinu ne deluje zanesljivo zaradi varnostne omejitve '
    + 'brskalnika pri nalaganju datotek znotraj Worker-ja – iskanje po IMENU/POTI datotek bo delovalo, '
    + 'OCR indeksiranje VSEBINE pa najverjetneje ne bo (ali bo po 20 s prijavilo časovno omejitev). Za '
    + 'zanesljivo delovanje zaženite aplikacijo prek priloženega zaganjalnika ("zazeni-windows.bat" ali '
    + '"zazeni-macos.command" – glej README.txt, razdelek "KAKO ZAGNATI"), ki namesto neposrednega '
    + 'odpiranja datoteke požene majhen lokalen strežnik.');
  setStatus('Opozorilo: aplikacija je odprta prek file:// – OCR morda ne bo deloval zanesljivo (glej gumb "Dnevnik").');
}

// Popravek (2026-09-24, worker pool): privzeto izbrano št. worker-jev v #optWorkerCount nastavimo
// tu, iz JS (DEFAULT_WORKER_POOL_SIZE, glede na navigator.hardwareConcurrency) – v HTML tega ni
// mogoče vnaprej zapisati kot "selected", ker je odvisno od računalnika, na katerem se aplikacija
// odpre. Nastavitev NI trajno shranjena med sejami (za razliko od extraFolders) – vsak zagon znova
// izračuna smiseln privzetek za TA konkreten računalnik.
if (optWorkerCount) optWorkerCount.value = String(DEFAULT_WORKER_POOL_SIZE);

logEvent('info', 'Aplikacija naložena (Tesseract.js 5.1.1). Dnevnik je pripravljen.');
checkLastFolder();
