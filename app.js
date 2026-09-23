/* OCR Iskalnik slik – glavna logika
 * Zahteva Chrome/Edge (File System Access API). Vsi viri (Tesseract.js, jezikovni
 * podatki) so lokalni v mapi assets/ – aplikacija ne potrebuje internetne povezave
 * in ne zahteva namestitve ali skrbniških (administratorskih) pravic v Windows.
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
let singleOcrRelPath = null;   // katera vrstica (relPath) je trenutno v obdelavi – da renderTable() med
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

function setBusy(isBusy) {
  scanning = isBusy;
  btnPickFolder.disabled = isBusy;
  btnReopenLast.disabled = isBusy || btnReopenLast.title === '';
  btnRescan.disabled = isBusy || !dirHandle;
  btnStop.disabled = !isBusy;
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

async function walkDirectory(handle, relPath, recursive, out) {
  for await (const [name, entryHandle] of handle.entries()) {
    if (stopRequested) return;
    const entryRel = relPath ? `${relPath}/${name}` : name;
    if (entryHandle.kind === 'file') {
      const ext = extOf(name);
      if (IMAGE_EXT.has(ext)) {
        out.push({ relPath: entryRel, name, folder: relPath || '/', handle: entryHandle });
      }
    } else if (entryHandle.kind === 'directory' && recursive) {
      if (name.startsWith('.')) continue;
      await walkDirectory(entryHandle, entryRel, recursive, out);
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
async function loadIndexFile() {
  let fileExisted = false;
  try {
    const fh = await dirHandle.getFileHandle(INDEX_FILENAME);
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
async function saveIndexFile() {
  try {
    try {
      const existingFh = await dirHandle.getFileHandle(INDEX_FILENAME);
      const existingParsed = JSON.parse(await (await existingFh.getFile()).text());
      const diskGeneratedAt = existingParsed && existingParsed.generatedAt;
      if (lastKnownGeneratedAt !== null && diskGeneratedAt && diskGeneratedAt !== lastKnownGeneratedAt
          && conflictWarnedGeneratedAt !== diskGeneratedAt) {
        conflictWarnedGeneratedAt = diskGeneratedAt;
        logEvent('warn', `Zaznan mogoč konflikt: ocr-index.json je bil na disku spremenjen (${diskGeneratedAt}) po tem, ko ga je ta zavihek nazadnje prebral/zapisal (${lastKnownGeneratedAt}) – verjetno je ista mapa odprta tudi v drugem zavihku/oknu. Ta zapis bo ZDAJ PREPISAL tiste spremembe. Priporočilo: uporabljajte samo EN zavihek/okno na mapo hkrati.`);
      }
    } catch (e) {
      // Datoteka morda še ne obstaja (prvi zapis v to mapo) ali je bila medtem izbrisana/poškodovana –
      // to NI namen tega preverjanja (namen je le zaznati sočasno UREJANJE), zato tiho ignoriramo.
    }
    const fh = await dirHandle.getFileHandle(INDEX_FILENAME, { create: true });
    const writable = await fh.createWritable();
    indexData.generatedAt = new Date().toISOString();
    const toWrite = optNoPersistText.checked ? redactTextForSave(indexData) : indexData;
    await writable.write(JSON.stringify(toWrite, null, 0));
    await writable.close();
    lastKnownGeneratedAt = indexData.generatedAt;
  } catch (e) {
    console.error('Napaka pri shranjevanju indeksa:', e);
    logEvent('error', 'Napaka pri shranjevanju ocr-index.json: ' + e.message, e);
    setStatus('Opozorilo: indeksa ni bilo mogoče zapisati nazaj v mapo (' + e.message + ')');
  }
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
async function getWorker(profile, langs) {
  const key = profile + '|' + langs.join('+');
  if (workers[key]) return workers[key];
  // Ker en sam brskalniški zavihek hkrati praviloma obdeluje eno vrsto OCR-ja,
  // ohranimo največ dva worker-ja (fast + accurate) v predpomnilniku, da preklop
  // med njima med posamičnim "Natančno" ukazom in serijskim pregledom ni prepočasen.
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

async function runOcr(fileObj, profile, langs) {
  // Popravek C (QA najdba, 2026-09-22, ČETRTI KROG) – glej withTimeout()/OCR_WORKER_TIMEOUT_MS
  // zgoraj. Ta klic pokrije tudi pot iz reOcrSingle() ("Natančno" na posamezni vrstici), če
  // ustrezen worker (profil+jeziki) še ni bil predhodno naložen/predpomnjen.
  const w = await withTimeout(getWorker(profile, langs), OCR_WORKER_TIMEOUT_MS, 'nalaganje OCR mehanizma');
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
    await afterFolderSelected();
  } finally {
    folderOpBusy = false;
    // rescan() (znotraj afterFolderSelected()) je ob normalnem zaključku že samo poskrbel za pravilno
    // (ponovno omogočeno) stanje gumbov prek setBusy(); to je varnostna mreža za primer preklica/napake
    // PRED to točko, ko setBusy() sploh še ni bil poklican. Formula za btnRescan je enaka kot v setBusy().
    btnPickFolder.disabled = scanning;
    btnReopenLast.disabled = scanning || btnReopenLast.title === '';
    btnRescan.disabled = scanning || !dirHandle;
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
    await afterFolderSelected();
  } finally {
    folderOpBusy = false;
    btnPickFolder.disabled = scanning;
    btnReopenLast.disabled = scanning || btnReopenLast.title === '';
    btnRescan.disabled = scanning || !dirHandle;
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
  setProgress(true, 0, 'Preiskujem mapo …');
  setStatus('Preiskujem mapo …');

  const scanStartedAt = Date.now();
  logEvent('info', `Pregled mape začet (rekurzivno: ${optRecursive.checked ? 'da' : 'ne'}, jeziki: ${selectedLangs().join('+')}, OCR: ${optOcrQuality.value}).`);

  currentFiles = [];
  try {
    await walkDirectory(dirHandle, '', optRecursive.checked, currentFiles);
  } catch (e) {
    logEvent('error', 'Napaka pri branju mape: ' + e.message, e);
    setStatus('Napaka pri branju mape: ' + e.message);
    setBusy(false);
    setProgress(false);
    return;
  }
  if (stopRequested) { finishScan('Ustavljeno.'); return; }

  // Pridobi metapodatke (velikost, čas spremembe) za vsako datoteko
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
  const toProcess = [];
  const seenPaths = new Set();
  let backfillCount = 0;
  for (const f of currentFiles) {
    seenPaths.add(f.relPath);
    const prev = indexData.files[f.relPath];
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
  // Odstrani iz indeksa datoteke, ki jih ni več
  for (const relPath of Object.keys(indexData.files)) {
    if (!seenPaths.has(relPath)) delete indexData.files[relPath];
  }

  setStatus(`Najdenih ${currentFiles.length} slik. Za OCR: ${toProcess.length}.`);
  let done = 0; // deljeno med OCR zanko spodaj in finishScan() sporočilom ob morebitni ustavitvi

  if (toProcess.length > 0) {
    const langs = selectedLangs();
    const profile = optOcrQuality.value === 'accurate' ? 'accurate' : 'fast';
    setProgress(true, 0, `Nalagam OCR mehanizem (${langs.join('+').toUpperCase()}, ${profile === 'accurate' ? 'natančno' : 'hitro'}) …`);
    try {
      // Popravek C (QA najdba, 2026-09-22, ČETRTI KROG) – glej withTimeout()/OCR_WORKER_TIMEOUT_MS
      // zgoraj: brez tega bi ta klic v nekaterih okoljih (dokazano: file:// v Chromium) lahko
      // obvisel v neskončnost, ne da bi kdaj dosegel spodnji catch.
      await withTimeout(getWorker(profile, langs), OCR_WORKER_TIMEOUT_MS, 'nalaganje OCR mehanizma');
    } catch (e) {
      logEvent('error', `Napaka pri nalaganju OCR mehanizma (profil ${profile}, jeziki ${langs.join('+')}): ` + e.message, e);
      setStatus('Napaka pri nalaganju OCR mehanizma: ' + e.message + friendlyOcrErrorHint(e));
      setBusy(false); setProgress(false);
      return;
    }

    for (const f of toProcess) {
      if (stopRequested) break;
      setProgress(true, Math.round((done / toProcess.length) * 100),
        `OCR (${done + 1}/${toProcess.length}, ${profile === 'accurate' ? 'natančno' : 'hitro'}): ${f.relPath}`);
      try {
        const text = await runOcr(f._fileObj, profile, langs);
        indexData.files[f.relPath] = {
          size: f.size, mtime: f.mtime, text, ocrAt: new Date().toISOString(), error: null, mode: profile,
        };
      } catch (e) {
        indexData.files[f.relPath] = {
          size: f.size, mtime: f.mtime, text: '', ocrAt: new Date().toISOString(), error: String(e.message || e), mode: profile,
        };
        logEvent('error', `OCR napaka pri sliki (${logPath(f.relPath)}, profil ${profile}): ` + (e.message || e), e);
      }
      done++;
      // Vmesno shranjevanje na vsakih 15 datotek, da se ob prekinitvi ne izgubi delo
      if (done % 15 === 0) await saveIndexFile();
      // Tabelo med OCR osvežujemo le občasno (ne ob vsaki datoteki), da UI ostane odziven
      // tudi pri več sto/tisoč slikah – napredek prikazuje vrstica napredka zgoraj.
      if (done % 5 === 0 || done === toProcess.length) renderTable();
    }
  }

  await saveIndexFile();
  const durationSec = ((Date.now() - scanStartedAt) / 1000).toFixed(1);
  logEvent('info', `Pregled končan v ${durationSec}s – ${currentFiles.length} slik skupaj, ${toProcess.length} obdelanih z OCR.`);
  // Popravek (grillme-custom, 2026-09-23 – FAZA 2, glej HISTORY_AI_AGENT.txt): prej je sporočilo ob
  // ustavitvi ("Ustavljeno – delni rezultati so shranjeni.") povedalo SAMO, da so delni rezultati
  // shranjeni, ne pa TUDI, koliko slik je bilo dejansko obdelanih pred ustavitvijo – ta podatek je bil
  // sicer na kratko viden v vrstici napredka med samim OCR-jem, a je po ustavitvi izginil. Zdaj je
  // natančno število (doneCount/toProcessTotal) del samega sporočila o ustavitvi.
  finishScan(stopRequested
    ? `Ustavljeno – delni rezultati so shranjeni (obdelanih ${done}/${toProcess.length}).`
    : 'Pregled končan.');
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

async function reOcrSingle(relPath, btnEl) {
  if (scanning) {
    logEvent('warn', `"Natančno" preklicano (${logPath(relPath)}) – najprej se mora zaključiti pregled mape, ki je v teku.`);
    setStatus('Počakajte, da se zaključi pregled mape, nato poskusite znova.');
    return;
  }
  if (singleOcrBusy) {
    // Zaščita pred dvojnim klikom/sočasnim sprožanjem ISTE ali DRUGE vrstice: gumb bi se
    // sicer po vsakem vmesnem renderTable() poklicu (npr. med tipkanjem v iskalno polje)
    // videti spet "omogočen" (glej QA #6), čeprav prejšnji "Natančno" še ni končan.
    logEvent('warn', `"Natančno" preklicano (${logPath(relPath)}) – druga slika (${logPath(singleOcrRelPath)}) se še obdeluje.`);
    setStatus('Počakajte, da se zaključi "Natančno" OCR prejšnje slike, nato poskusite znova.');
    return;
  }
  const f = currentFiles.find((x) => x.relPath === relPath);
  if (!f) return;
  singleOcrBusy = true;
  singleOcrRelPath = relPath;
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '…'; }
  // Onemogoči tudi "Ponovno preglej" (in izbiro mape), da je izključenost vidna
  // uporabniku, ne le interno – prej je gumb ostal videti klikljiv (glej QA #6).
  btnRescan.disabled = true;
  btnPickFolder.disabled = true;
  btnReopenLast.disabled = true;
  setStatus(`Natančen OCR: ${relPath} …`);
  try {
    const fileObj = f._fileObj || await f.handle.getFile();
    const langs = selectedLangs();
    const text = await runOcr(fileObj, 'accurate', langs);
    indexData.files[relPath] = {
      size: f.size, mtime: f.mtime, text, ocrAt: new Date().toISOString(), error: null, mode: 'accurate',
    };
    await saveIndexFile();
    setStatus(`Natančen OCR končan: ${relPath}`);
  } catch (e) {
    logEvent('error', `Napaka pri natančnem (accurate) OCR posamezne slike (${logPath(relPath)}): ` + e.message, e);
    setStatus('Napaka pri natančnem OCR: ' + e.message + friendlyOcrErrorHint(e));
  } finally {
    singleOcrBusy = false;
    singleOcrRelPath = null;
    btnRescan.disabled = !dirHandle || scanning;
    btnPickFolder.disabled = scanning;
    btnReopenLast.disabled = scanning || btnReopenLast.title === '';
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
    const entry = indexData.files[f.relPath];
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
    const encPath = encodeURIComponent(r.relPath);
    const isBusyRow = singleOcrBusy && r.relPath === singleOcrRelPath;
    const accurateBtnHtml = isBusyRow
      ? `<button class="small btnAccurate" data-path="${encPath}" disabled title="Natančen OCR te slike je v teku …">…</button>`
      : `<button class="small btnAccurate" data-path="${encPath}" title="Ponovno preberi to sliko z natančnejšim (počasnejšim) OCR in izboljšano sliko">Natančno</button>`;

    return `<tr data-path="${encPath}">
      <td class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
      <td class="folder" title="${escapeHtml(r.folder)}">${escapeHtml(r.folder)}</td>
      <td class="size">${fmtSize(r.size)}</td>
      <td class="modified">${r.mtime ? fmtDate(r.mtime) : '—'}</td>
      <td class="status">${statusBadge}</td>
      <td class="snippet">${snippet || '<span style="opacity:.5">(brez besedila)</span>'}</td>
      <td class="actions">
        <button class="small btnOpen" data-path="${encPath}" title="Odpri sliko v novem zavihku">Odpri</button>
        ${accurateBtnHtml}
      </td>
    </tr>`;
  }).join('');

  resultsBody.innerHTML = rowsHtml;
  setStatus(undefined, `${filteredRows.length} / ${currentFiles.length} prikazanih`);
}

async function openImageRow(relPath) {
  const f = currentFiles.find((x) => x.relPath === relPath);
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
    logEvent('error', `Slike ni bilo mogoče odpreti (${logPath(relPath)}): ` + e.message, e);
    alert('Slike ni bilo mogoče odpreti: ' + e.message);
  }
}

// ---------- Dogodki ----------
// Vsi klici, ki jih sproži uporabnik, so speljani skozi guard() (glej definicijo
// zgoraj) – tako se NOBEN klik/vnos ne konča "v tišini", če pride do nepričakovane
// napake: uporabnik dobi sporočilo v vrstici stanja, podrobnosti pa pristanejo v
// dnevniku (gumb "Dnevnik"), ne glede na to, ali ima odprto konzolo brskalnika.

btnPickFolder.addEventListener('click', guard(pickFolder, 'izbira mape'));
btnReopenLast.addEventListener('click', guard(reopenLastFolder, 'odpri zadnjo mapo'));
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
  const openBtn = e.target.closest('.btnOpen');
  if (openBtn) { openImageRow(decodeURIComponent(openBtn.dataset.path)); return; }
  const accBtn = e.target.closest('.btnAccurate');
  if (accBtn) { reOcrSingle(decodeURIComponent(accBtn.dataset.path), accBtn); }
}, 'klik v tabeli'));

resultsBody.addEventListener('dblclick', guard((e) => {
  const tr = e.target.closest('tr');
  if (tr) openImageRow(decodeURIComponent(tr.dataset.path));
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

logEvent('info', 'Aplikacija naložena (Tesseract.js 5.1.1). Dnevnik je pripravljen.');
checkLastFolder();
