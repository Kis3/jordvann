'use strict';

// ──────────────────────────────────────────────────────────────────────────
//  KONFIGURASJON
// ──────────────────────────────────────────────────────────────────────────
const SENORGE = 'https://gis3.nve.no/image/rest/services/seNorgeGrid';

const STATION = { id: 'SN57162', name: 'Førde PLU', lat: 61.457407, lon: 5.833958 };

// Overvåkningsområde – juster koordinatene her om nødvendig
const AREA_RECT = {
  bounds: [[61.4445, 5.4271], [61.3908, 5.6633]], // [NV, SØ]
  label:  'Overvåkningsområde Fv 609 Heilevang',
};

// Beredskapsplanens terskler. Første scenario der våteste celle når minPct gjelder.
const SCENARIER = [
  { no: 1, minPct: 70, threshH: 10, threshD: 40, vilkår: '70 % eller mer' }, // fuktig jord
  { no: 2, minPct: 0,  threshH: 15, threshD: 60, vilkår: 'Under 70 %' },     // tørrere jord – krever mer nedbør
];

// Vannmetningsklassene slik seNorge-rasteret (odmhbv_ssspct) faktisk tegner dem.
// Rasteret er ferdig fargelagt (RGB), så klassen leses ut av pikselfargen, og
// tegnforklaringen bruker de samme fargene som kartet.
// (229,229,229) grå = gyldig klasse «Under 60 %» (alfa 255, IKKE gjennomsiktig)
// (1,1,1) nesten svart = hav / utenfor modellen → ingen data
const SM_KLASSER = [
  { r: 204, g:   0, b:   0, label: 'Over 90 %',  midPct: 95, beskrivelse: 'mettet' },
  { r: 248, g: 196, b:   0, label: '80–90 %',    midPct: 85, beskrivelse: 'svært fuktig' },
  { r: 248, g: 252, b:   0, label: '70–80 %',    midPct: 75, beskrivelse: 'fuktig' },
  { r:  40, g: 212, b:  96, label: '60–70 %',    midPct: 65, beskrivelse: 'moderat fuktig' },
  { r: 229, g: 229, b: 229, label: 'Under 60 %', midPct: 30, beskrivelse: '' },
];
for (const k of SM_KLASSER) k.farge = `rgb(${k.r},${k.g},${k.b})`;

// Nedbørsklassene i seNorge-rasterne. ImageServeren har ingen tegnforklaring,
// så klassegrensene er målt: rasterfarge sammenholdt med gts-verdien i samme
// celle for ~2000 celler over Sør-Norge (nov. 2026 og 13.–15. mars 2026).
const RR_LEGENDE = {
  rr: [
    ['#dbdbdb', '0 mm'], ['#d9ffff', '0,1–10 mm'], ['#80ebff', '10–20 mm'],
    ['#0099ff', '20–40 mm'], ['#0019ff', '40–60 mm'], ['#000099', 'Over 60 mm'],
  ],
  rr3d: [
    ['#e5e5e5', '0 mm'], ['#d9ffff', '0,1–10 mm'], ['#b3ffff', '10–20 mm'], ['#80ebff', '20–30 mm'],
    ['#40ccff', '30–50 mm'], ['#0099ff', '50–75 mm'], ['#0019ff', '75–150 mm'], ['#000099', 'Over 150 mm'],
  ],
};

const PERIODE_BAKOVER = -30; // dager relativt til i dag
const PERIODE_FRAMOVER = 8;  // valgt dato D bruker raster D+1; prognoserastere finnes t.o.m. i dag+9
const OPPDATER_MS = 30 * 60e3; // data hentes på nytt når siden har stått åpen så lenge

const UKEDAGER = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
const MÅNEDER  = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];

// ──────────────────────────────────────────────────────────────────────────
//  HJELPERE
// ──────────────────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);

// Ekstern tekst inn i innerHTML – escapes selv om kilden er NVE
const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const nf = v => v.toLocaleString('nb-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Lokal dato som ISO-streng (yyyy-mm-dd). Ikke bruk toISOString() –
// den gir UTC-døgnet, som er dagen før mellom midnatt og kl. 01/02 norsk tid.
function toLocalISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayISO() { return toLocalISO(new Date()); }

function isoTilDato(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// ISO-dato + n dager (lokal kalender, ingen UTC- eller sommertidsfallgruver)
function addDaysISO(iso, n) {
  const d = isoTilDato(iso);
  d.setDate(d.getDate() + n);
  return toLocalISO(d);
}

// Min/maks som ISO-strenger – sammenlignes leksikografisk (fungerer for yyyy-mm-dd)
function periodeMin()  { return addDaysISO(todayISO(), PERIODE_BAKOVER); }
function periodeMaks() { return addDaysISO(todayISO(), PERIODE_FRAMOVER); }

const fmtLang = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDag  = new Intl.DateTimeFormat('nb-NO', { weekday: 'short', day: 'numeric', month: 'short' });
const storForbokstav = s => s.charAt(0).toUpperCase() + s.slice(1);

// ──────────────────────────────────────────────────────────────────────────
//  PROJ4 – WGS84 ↔ UTM sone 33N (rutenettet til seNorge og gts.nve.no)
// ──────────────────────────────────────────────────────────────────────────
proj4.defs('EPSG:32633', '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs');

// ──────────────────────────────────────────────────────────────────────────
//  TILSTAND
// ──────────────────────────────────────────────────────────────────────────
let map, areaRect;
const kartlag = { sm: null, rr: null };
let valgtDato = todayISO();
let oppdatering = 0;                 // teller – nytt nummer gir ferske kartbilder etter «Oppdater»
let sistOppdatert = 0;
let dagVedOppdatering = todayISO();

// ──────────────────────────────────────────────────────────────────────────
//  KARTLAG FRA SENORGE (ArcGIS ImageServer, fliser i EPSG:3857)
// ──────────────────────────────────────────────────────────────────────────
// Dato → mosaicRule som velger riktig dagsraster i katalogen.
// VIKTIG 1: ImageServeren er IKKE tids-aktivert – &time= ignoreres stille og
// serveren viser alltid nyeste raster (verifisert aug 2026: fire ulike
// time-verdier ga byte-identiske bilder).
// VIKTIG 2: seNorge-døgnet «D» går fra D kl 08 til D+1 kl 08 og lagres i
// rasteret STEMPLET D+1 (verifisert mot senorge.no: UI-dato D sender
// time=D+1 til WMS-en). Vi legger derfor på én dag her, slik at valgt dato
// i appen viser samme bilde som samme dato på senorge.no.
// Katalogen har ett raster per dag navngitt <lag>_YYYY_MM_DD.
// NB: Kun lag med ETT raster per døgn støttes. Timesoppløste lag (f.eks.
// rr3h, som har 8 rastere per døgn: _00, _03 … _21) ville gitt et vilkårlig
// treff på LIKE-jokertegnet – de er derfor holdt utenfor lagvalget.
function dateToMosaicRule(layerName, isoDate) {
  if (!isoDate) return null;
  const rasterDate = addDaysISO(isoDate, 1);
  const prefix = `${layerName}_${rasterDate.replace(/-/g, '_')}`;
  return encodeURIComponent(JSON.stringify({
    mosaicMethod: 'esriMosaicAttribute',
    where: `Name LIKE '${prefix}%'`,
  }));
}

// Samme adresse gir samme bilde fra nettleserens hurtiglager. Etter en
// oppdatering legges tellerverdien på, slik at reviderte rastere hentes på nytt.
function ferskhet() { return oppdatering ? `&_=${oppdatering}` : ''; }

const ArcGISImageLayer = L.GridLayer.extend({
  options: { tileSize: 256, opacity: 0.7, layerName: 'odmhbv_ssspct', dateISO: null },
  createTile(coords, done) {
    const img = document.createElement('img');
    img.alt = '';
    img.crossOrigin = 'anonymous';
    const b  = this._tileCoordsToBounds(coords);
    const sw = L.CRS.EPSG3857.project(b.getSouthWest());
    const ne = L.CRS.EPSG3857.project(b.getNorthEast());
    const sz = this.options.tileSize;
    let url  = `${SENORGE}/${this.options.layerName}/ImageServer/exportImage`
             + `?bbox=${sw.x},${sw.y},${ne.x},${ne.y}&bboxSR=3857`
             + `&size=${sz},${sz}&imageSR=3857&format=png32&transparent=true&f=image${ferskhet()}`;
    const mr = dateToMosaicRule(this.options.layerName, this.options.dateISO);
    if (mr) url += `&mosaicRule=${mr}`;
    img.onload  = () => done(null, img);
    img.onerror = e  => done(e, img);
    img.src = url;
    return img;
  },
});

function lagnavn(hvilket) {
  return hvilket === 'sm' ? 'odmhbv_ssspct' : el('rr-tema').value;
}

// (Gjen)oppretter et kartlag for valgt dato. Nedbør ligger alltid over vannmetning.
function byggLag(hvilket) {
  if (kartlag[hvilket]) map.removeLayer(kartlag[hvilket]);
  kartlag[hvilket] = new ArcGISImageLayer({
    layerName: lagnavn(hvilket),
    dateISO:   valgtDato,
    opacity:   el(`dekk-${hvilket}`).value / 100,
    zIndex:    hvilket === 'sm' ? 2 : 3,
  });
  if (el(`vis-${hvilket}`).checked) kartlag[hvilket].addTo(map);
}

function tegnLegende(id, rader) {
  el(id).innerHTML = rader
    .map(([farge, tekst]) => `<li><i style="background:${farge}"></i>${tekst}</li>`).join('');
}

function kartlagInit(startÅpen) {
  for (const hvilket of ['sm', 'rr']) {
    el(`vis-${hvilket}`).addEventListener('change', e => {
      const lag = kartlag[hvilket];
      if (lag) e.target.checked ? lag.addTo(map) : map.removeLayer(lag);
      el(`detaljer-${hvilket}`).hidden = !e.target.checked;
    });
    el(`dekk-${hvilket}`).addEventListener('input', e => {
      kartlag[hvilket]?.setOpacity(e.target.value / 100);
      el(`dekk-${hvilket}-verdi`).textContent = `${e.target.value} %`;
    });
  }
  el('rr-tema').addEventListener('change', e => {
    byggLag('rr');
    tegnLegende('legende-rr', RR_LEGENDE[e.target.value]);
  });
  el('vis-omrade').addEventListener('change', e => {
    e.target.checked ? areaRect.addTo(map) : map.removeLayer(areaRect);
  });

  tegnLegende('legende-sm', SM_KLASSER.map(k =>
    [k.farge, k.label + (k.beskrivelse ? ` – ${k.beskrivelse}` : '')]));
  tegnLegende('legende-rr', RR_LEGENDE.rr);

  // Kartlag-panelet kan foldes sammen; på smale kart starter det lukket
  const panel = el('kartlag'), veksle = el('kartlag-veksle');
  const settÅpen = åpen => {
    panel.classList.toggle('lukket', !åpen);
    veksle.setAttribute('aria-expanded', String(åpen));
  };
  veksle.addEventListener('click', () => settÅpen(panel.classList.contains('lukket')));
  settÅpen(startÅpen);
}

// ──────────────────────────────────────────────────────────────────────────
//  VARSLING – terskellogikk
// ──────────────────────────────────────────────────────────────────────────
// Scenario bestemmes av VÅTESTE celle i området.
// Beredskapsplanen: «Når EN celle innenfor avgrensingen får en vannmetningsgrad
// på 70–80 %» gjelder Scenario 1 – altså er det maksimum, ikke snittet, som styrer.
function getScenarioFromMax(maxPct) {
  if (maxPct == null) return null;
  return SCENARIER.find(s => maxPct >= s.minPct);
}

// Felles statusberegning for én dag. Brukes av BÅDE arealrapporten og
// kalenderen, slik at de aldri kan vise ulik status for samme dato.
// Nedbøren vurderes på verste celle – samme prinsipp som scenarioet.
function beregnStatus(maxPct, rrMaks, timeMaks) {
  const sc = getScenarioFromMax(maxPct);
  if (!sc || rrMaks == null) return { nivå: 'ukjent', sc };
  const excD  = rrMaks >= sc.threshD;
  const excH  = timeMaks != null && timeMaks >= sc.threshH;
  const nearD = rrMaks >= sc.threshD * 0.5;
  const nearH = timeMaks != null && timeMaks >= sc.threshH * 0.5;
  const nivå  = (excD || excH) ? 'rod' : (nearD || nearH) ? 'gul' : 'gronn';
  return { nivå, sc, excD, excH };
}

const NIVÅ_TEKST = { rod: 'Terskel overskredet', gul: 'Nærmer seg terskel', gronn: 'Under terskel' };

// Datagrunnlag for en gitt dato: observasjon eller prognose, og hvilken modell.
// Samme tjeneste som senorge.no bruker for å merke sine egne kart (åpen CORS).
// Datoen som sendes er rasterstempelet D+1, som ellers i tjenesten.
const PROGNOSE_SVC = 'https://services.xgeo.no/seNorgeMapAppServices/Services/UIService.svc/GetPrognosisStatus';
const WMS_SRC      = 'https://nf-web-e-prod01.nve.no/wms_server/wms_server.aspx';

function kortModellnavn(m) {
  if (!m) return null;
  if (/seNorge2018/i.test(m)) return 'seNorge2018 interpolerte målinger';
  if (/Meps|Metpp/i.test(m))  return 'MEPS';
  if (/ECMWF/i.test(m))       return 'ECMWF';
  return m.length > 40 ? m.slice(0, 40) + '…' : m;
}

async function getDataKilde(layerId, isoDate) {
  try {
    const [y, m, d] = addDaysISO(isoDate, 1).split('-').map(Number);
    const rfc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).toUTCString();
    const req = encodeURIComponent(JSON.stringify({
      MapLayerId: layerId, MapLayerSource: WMS_SRC, Date: rfc, Language: 'no',
    }));
    const r = await fetch(`${PROGNOSE_SVC}?request=${req}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.Model == null) return null;
    return { erPrognose: !!j.IsPrognosis, modell: j.Model, kort: kortModellnavn(j.Model) };
  } catch {
    return null; // faller tilbake på enkel dato-sammenligning
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  AREALDATA – vannmetning og nedbør for alle modellcellene i området
// ──────────────────────────────────────────────────────────────────────────
// Modellcellene i AREA_RECT, i seNorge-rutenettet (EPSG:32633, 1 km, origo
// -75000/6450000 – alt på hele tusen). Ber vi om et bilde med bbox justert
// til 1000 m og size = antall celler, blir hver piksel nøyaktig én modellcelle –
// ingen resampling. Rektangelet er rotert ~8° i UTM (meridiankonvergens så langt
// vest i sone 33), så hvert cellesenter sjekkes mot lat/lon-rektangelet.
// `indekser` peker inn i bildet, `punkter` er de samme cellenes senter [x, y].
let _arealCeller = null;
function arealCeller() {
  if (_arealCeller) return _arealCeller;
  const nv = AREA_RECT.bounds[0], so = AREA_RECT.bounds[1];
  const hjørner = [[nv[0], nv[1]], [nv[0], so[1]], [so[0], nv[1]], [so[0], so[1]]]
    .map(([la, lo]) => proj4('EPSG:4326', 'EPSG:32633', [lo, la]));
  const xs = hjørner.map(c => c[0]), ys = hjørner.map(c => c[1]);
  const x0 = Math.floor(Math.min(...xs) / 1000) * 1000, x1 = Math.ceil(Math.max(...xs) / 1000) * 1000;
  const y0 = Math.floor(Math.min(...ys) / 1000) * 1000, y1 = Math.ceil(Math.max(...ys) / 1000) * 1000;
  const nx = (x1 - x0) / 1000, ny = (y1 - y0) / 1000;
  const indekser = [], punkter = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * 1000, y = y1 - (j + 0.5) * 1000;
      const [lo, la] = proj4('EPSG:32633', 'EPSG:4326', [x, y]);
      if (la <= nv[0] && la >= so[0] && lo >= nv[1] && lo <= so[1]) {
        indekser.push(j * nx + i);
        punkter.push([x, y]);
      }
    }
  return (_arealCeller = { x0, y0, x1, y1, nx, ny, indekser, punkter });
}

// RGBA-piksel → vannmetningsklasse (null = ingen data / ukjent farge)
function matchKlasse(r, g, b, a) {
  if (a < 30) return null;                        // gjennomsiktig = utenfor domenet
  if (r < 15 && g < 15 && b < 15) return null;    // nesten svart = hav/fjorder
  if (r > 245 && g > 245 && b > 245) return null; // hvitt = uten modellverdi (ikke en legendeklasse)
  let best = null, minD = Infinity;
  for (const cls of SM_KLASSER) {
    const d = Math.sqrt((r - cls.r) ** 2 + (g - cls.g) ** 2 + (b - cls.b) ** 2);
    if (d < minD) { minD = d; best = cls; }
  }
  // 120 ≈ halvparten av minste RGB-avstand mellom to legendefarger
  return minD > 120 ? null : best;
}

// Vannmetningsfordeling over alle modellceller for én dato – ett lite bildekall.
async function hentVannmetning(iso) {
  const g = arealCeller();
  const url = `${SENORGE}/odmhbv_ssspct/ImageServer/exportImage`
    + `?bbox=${g.x0},${g.y0},${g.x1},${g.y1}&bboxSR=32633&imageSR=32633`
    + `&size=${g.nx},${g.ny}&format=png32&transparent=true&f=image${ferskhet()}`
    + `&mosaicRule=${dateToMosaicRule('odmhbv_ssspct', iso)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('vannmetning HTTP ' + resp.status);
  const bmp = await createImageBitmap(await resp.blob());
  const cv  = document.createElement('canvas');
  cv.width = g.nx; cv.height = g.ny;
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const data = ctx.getImageData(0, 0, g.nx, g.ny).data;

  const counts = Object.fromEntries(SM_KLASSER.map(c => [c.label, 0]));
  let dataCeller = 0, maxPct = null;
  for (const idx of g.indekser) {
    const k = idx * 4;
    const cls = matchKlasse(data[k], data[k + 1], data[k + 2], data[k + 3]);
    if (!cls) continue;
    counts[cls.label]++;
    dataCeller++;
    if (maxPct == null || cls.midPct > maxPct) maxPct = cls.midPct;
  }
  return { counts, dataCeller, celler: g.indekser.length, maxPct };
}

// Tidsserier for mange celler i ETT kall via proxyen (gts MultiPointTimeSeries).
// → { start: 'yyyy-mm-dd' for første verdi, stegMin, serier: [[verdi, …] per celle] }
// Verdi nr. i i en serie gjelder tidspunktet start kl 00 UTC + i · stegMin.
const GTS_NODATA = 65535;
const gyldig = v => typeof v === 'number' && !Number.isNaN(v) && v !== GTS_NODATA;

async function hentGts(punkter, start, slutt, theme) {
  const liste = punkter.map(([x, y]) => `${x},${y}`).join(';');
  const r = await fetch(`/api/gts?theme=${theme}&start=${start}&end=${slutt}&punkter=${liste}`);
  if (r.status === 422) {
    // Minst ett punkt ligger utenfor seNorge-rutenettet (hav), og gts avviser da
    // hele listen. Del den i to til de ugyldige punktene er skilt ut.
    if (punkter.length === 1) return { start, stegMin: 0, serier: [] };
    const midt = punkter.length >> 1;
    const [a, b] = await Promise.all([
      hentGts(punkter.slice(0, midt), start, slutt, theme),
      hentGts(punkter.slice(midt), start, slutt, theme),
    ]);
    return { ...(a.serier.length ? a : b), serier: [...a.serier, ...b.serier] };
  }
  if (!r.ok) throw new Error(`gts HTTP ${r.status}`);
  const j = await r.json();
  const [d, m, y] = j.StartDate.slice(0, 10).split('.');
  return { start: `${y}-${m}-${d}`, stegMin: j.TimeResolution, serier: j.CellTimeSeries.map(c => c.Data) };
}

// Døgnnedbør per seNorge-dag i perioden: Map(dagISO → { maks, middel, n }).
// Verdien stemplet S er døgnet som slutter S kl 06 UTC, altså senorge-dag S−1.
async function hentNedborSerie(start, slutt) {
  const g = await hentGts(arealCeller().punkter, addDaysISO(start, 1), addDaysISO(slutt, 1), 'rr');
  const lengde = Math.max(0, ...g.serier.map(s => s.length));
  const ut = new Map();
  for (let i = 0; i < lengde; i++) {
    const v = g.serier.map(s => s[i]).filter(gyldig);
    if (!v.length) continue;
    ut.set(addDaysISO(g.start, i - 1),
      { maks: Math.max(...v), middel: v.reduce((a, b) => a + b, 0) / v.length, n: v.length });
  }
  return ut;
}

// Maks timesnedbør per seNorge-dag: Map(dagISO → mm/t).
// Timesverdien stemplet t gjelder timen som slutter t, så den hører til dagen
// D når D 06 UTC < t ≤ D+1 06 UTC. Bare dager med (nesten) hele døgnet dekket
// tas med – ved prognosehorisonten (~2,5 døgn fram) er siste døgn ufullstendig,
// og et maks over noen få timer ville undervurdert intensiteten.
async function hentTimesSerie(start, slutt) {
  const g = await hentGts(arealCeller().punkter, start, addDaysISO(slutt, 2), 'rr1h');
  const [y, m, d] = g.start.split('-').map(Number);
  const t0 = Date.UTC(y, m - 1, d), steg = g.stegMin * 60e3;
  const lengde = Math.max(0, ...g.serier.map(s => s.length));
  const dagFor = Array.from({ length: lengde }, (_, i) =>
    new Date(t0 + i * steg - 6 * 3600e3 - 60e3).toISOString().slice(0, 10));

  const maks = new Map(), timer = new Map();
  let cellerMedData = 0;
  for (const serie of g.serier) {
    let harData = false;
    serie.forEach((v, i) => {
      if (!gyldig(v)) return;
      harData = true;
      const dag = dagFor[i];
      if (dag < start || dag > slutt) return;
      maks.set(dag, Math.max(maks.get(dag) ?? -Infinity, v));
      timer.set(dag, (timer.get(dag) || 0) + 1);
    });
    if (harData) cellerMedData++;
  }
  const ut = new Map();
  for (const [dag, v] of maks)
    if (timer.get(dag) >= 23 * cellerMedData) ut.set(dag, v);
  return ut;
}

// ── Delt hurtiglager for økten ─────────────────────────────────────────────
// Kalenderen og arealrapporten bruker samme løfter, så ingenting hentes to
// ganger. Bevisst ikke lagret mellom økter: seNorge reviderer observasjonene.
// Tømmes av oppdaterAlt().
const smLager = new Map(); // dagISO → Promise<hentVannmetning>
function vannmetningFor(iso) {
  if (!smLager.has(iso))
    smLager.set(iso, hentVannmetning(iso).catch(e => { smLager.delete(iso); throw e; }));
  return smLager.get(iso);
}

let periodeData = null; // { start, slutt, rr: Promise<Map>, time: Promise<Map> }
function periodeSerier() {
  const start = periodeMin(), slutt = periodeMaks();
  if (!periodeData || periodeData.start !== start || periodeData.slutt !== slutt) {
    const denne = periodeData =
      { start, slutt, rr: hentNedborSerie(start, slutt), time: hentTimesSerie(start, slutt) };
    // Et mislykket kall skal ikke bli liggende i hurtiglageret
    const glem = () => { if (periodeData === denne) periodeData = null; };
    denne.rr.catch(glem);
    denne.time.catch(glem);
  }
  return periodeData;
}

// ──────────────────────────────────────────────────────────────────────────
//  AREALRAPPORT – status, nedbør og vannmetning for valgt dato
// ──────────────────────────────────────────────────────────────────────────
let arealSeq = 0; // sekvensnummer – forkaster utdaterte svar ved raske datoklikk

const FEIL_HTML = tekst =>
  `<p class="melding melding-feil">${tekst} <button type="button" class="knapp" data-oppdater>Prøv igjen</button></p>`;

async function lastArealrapport() {
  const seq = ++arealSeq;
  const dato = valgtDato;
  const erHistorisk = dato < todayISO();
  const grunnlagEl = el('panel-grunnlag');
  // Foreløpig merking – erstattes med modellnavn så snart NVE har svart
  grunnlagEl.textContent = erHistorisk ? 'Observert' : 'Prognose';
  grunnlagEl.removeAttribute('title');
  el('status').classList.add('venter');
  el('vannmetning').classList.add('venter');

  const p = periodeSerier();
  const [smRes, rrRes, timeRes, kildeRes] = await Promise.allSettled([
    vannmetningFor(dato), p.rr, p.time, getDataKilde('rr', dato),
  ]);
  if (seq !== arealSeq) return; // nyere kall pågår – forkast dette svaret
  el('status').classList.remove('venter');
  el('vannmetning').classList.remove('venter');

  const sm    = smRes.status    === 'fulfilled' ? smRes.value : null;
  const rr    = rrRes.status    === 'fulfilled' ? (rrRes.value.get(dato) ?? null) : null;
  const tMaks = timeRes.status  === 'fulfilled' ? (timeRes.value.get(dato) ?? null) : null;
  const kilde = kildeRes.status === 'fulfilled' ? kildeRes.value : null;

  // Datolinje med faktisk datagrunnlag fra NVE
  const erPrognose = kilde ? kilde.erPrognose : !erHistorisk;
  grunnlagEl.textContent = (erPrognose ? 'Prognose' : 'Observert') + ' · ' + (kilde ? kilde.kort : 'seNorge 1×1 km');
  if (kilde) grunnlagEl.title = kilde.modell; // full modellbeskrivelse ved hover

  if (!sm) {
    el('status').innerHTML = FEIL_HTML('Vannmetningsdata kunne ikke hentes fra seNorge.');
    el('vannmetning').innerHTML = '';
    return;
  }
  renderVannmetning(sm);
  renderStatus(beregnStatus(sm.maxPct, rr?.maks ?? null, tMaks), sm, rr, tMaks, {
    erPrognose,
    rrFeilet:   rrRes.status === 'rejected',
    timeFeilet: timeRes.status === 'rejected',
  });
}

// Ett kriterium: høyeste verdi i området målt mot terskelen
function kriteriumHtml(navn, verdi, terskel, enhet, manglerTekst) {
  if (verdi == null)
    return `<div class="krit"><div class="krit-topp"><span>${navn}</span><span class="krit-mangler">${manglerTekst}</span></div></div>`;
  const andel = verdi / terskel;
  const nivå  = andel >= 1 ? 'rod' : andel >= 0.5 ? 'gul' : 'gronn';
  return `
    <div class="krit">
      <div class="krit-topp">
        <span>${navn}</span>
        <span class="krit-verdi"><b>${nf(verdi)}</b> av ${terskel} ${enhet}</span>
      </div>
      <div class="maaler" role="img" aria-label="${Math.round(andel * 100)} % av terskelen">
        <span class="maaler-fyll niv-${nivå}" style="width:${Math.min(100, andel * 100).toFixed(1)}%"></span>
      </div>
    </div>`;
}

function scenarioTabellHtml(aktiv) {
  const rader = SCENARIER.map(s => `
    <tr${s === aktiv ? ' class="aktiv" aria-current="true"' : ''}>
      <th scope="row">${s.no}${s === aktiv ? ' <span class="merke">gjelder</span>' : ''}</th>
      <td>${s.vilkår}</td><td>${s.threshH} mm/t</td><td>${s.threshD} mm</td>
    </tr>`).join('');
  return `
    <table class="scenarier">
      <caption>Beredskapsplanens terskler</caption>
      <thead><tr><th scope="col">Scenario</th><th scope="col">Våteste celle</th><th scope="col">Time</th><th scope="col">Døgn</th></tr></thead>
      <tbody>${rader}</tbody>
    </table>`;
}

// Varslingsstatus for hele overvåkningsområdet (status fra beregnStatus).
function renderStatus(status, sm, rr, tMaks, { erPrognose, rrFeilet, timeFeilet }) {
  const ut = el('status');
  const sc = status.sc;
  if (rrFeilet) {
    ut.innerHTML = FEIL_HTML('Nedbørsdata kunne ikke hentes fra seNorge, så status kan ikke vurderes.');
    return;
  }
  if (status.nivå === 'ukjent' || !rr) {
    ut.innerHTML = `<p class="melding">Ikke nok data til å vurdere status for denne datoen${
      !sc ? ' – ingen av modellcellene har vannmetningsdata' : !rr ? ' – nedbørsdata mangler' : ''}.</p>`
      + scenarioTabellHtml(sc);
    return;
  }

  const hva  = erPrognose ? 'Varslet' : 'Observert';
  const over = [status.excD && 'døgnnedbør', status.excH && 'timesnedbør'].filter(Boolean).join(' og ');
  const begrunnelse = {
    rod:   `${hva} ${over} er over terskelen for scenario ${sc.no}.`,
    gul:   `${hva} nedbør er over halvparten av terskelen for scenario ${sc.no}.`,
    gronn: `${hva} nedbør er under halvparten av tersklene for scenario ${sc.no}.`,
  }[status.nivå];
  const våteste = SM_KLASSER.find(c => c.midPct === sm.maxPct);
  const timeMangler = timeFeilet ? 'kunne ikke hentes'
    : erPrognose ? 'ikke varslet ennå' : 'ikke tilgjengelig';

  ut.innerHTML = `
    <div class="status status-${status.nivå}">
      <p class="status-tittel">${NIVÅ_TEKST[status.nivå]}</p>
      <p class="status-tekst">${begrunnelse}</p>
    </div>
    ${kriteriumHtml('Høyeste døgnnedbør', rr.maks, sc.threshD, 'mm')}
    ${kriteriumHtml('Høyeste timesnedbør', tMaks, sc.threshH, 'mm/t', timeMangler)}
    <p class="hjelp">
      Våteste celle har vannmetning ${våteste ? våteste.label.toLowerCase() : '–'}.
      Middel døgnnedbør over området er ${nf(rr.middel)} mm (${rr.n} modellceller, døgnet regnes kl. 08–08).
      ${tMaks != null ? '' : timeFeilet
        ? 'Timesnedbør kunne ikke hentes, så status er vurdert på døgnnedbør alene.'
        : 'Timesprognosen rekker bare ca. 2,5 døgn fram, så status er vurdert på døgnnedbør alene.'}
    </p>
    ${scenarioTabellHtml(sc)}`;
}

// Fordeling av landarealet på vannmetningsklasser
function renderVannmetning(sm) {
  const { counts, dataCeller, celler } = sm;
  const rader = SM_KLASSER.map(k => {
    const pct = dataCeller > 0 ? (counts[k.label] || 0) / dataCeller * 100 : 0;
    return `
      <div class="kls-rad">
        <i class="kls-farge" style="background:${k.farge}"></i>
        <span class="kls-navn">${k.label}</span>
        <span class="kls-spor"><span class="kls-fyll" style="width:${pct.toFixed(1)}%;background:${k.farge}"></span></span>
        <span class="kls-pct">${pct.toFixed(0)} %</span>
      </div>`;
  }).join('');
  el('vannmetning').innerHTML = rader + `
    <p class="hjelp">Andel av landarealet i hver klasse. ${dataCeller} av ${celler} modellceller (1×1&nbsp;km)
      i området har data – vann og fjell utenfor modellen er holdt utenom.</p>`;
}

// ──────────────────────────────────────────────────────────────────────────
//  VARSELKALENDER – status per dag for hele datoperioden (i dag −30 … +8)
// ──────────────────────────────────────────────────────────────────────────
const KAL_SAMTIDIGE = 6;              // maks samtidige vannmetningskall
const kalStatus = new Map();          // dagISO → { nivå, sc, rrMaks, tMaks, maxPct } | 'laster' | 'feil'
let kalMåned = null;                  // { y, m } som vises
let kalSeq = 0;

// Kjør fn over elementene med maks n samtidige
async function medBegrensning(elementer, n, fn) {
  let i = 0;
  const arbeidere = Array.from({ length: Math.min(n, elementer.length) }, async () => {
    while (i < elementer.length) await fn(elementer[i++]);
  });
  await Promise.all(arbeidere);
}

function periodeDager() {
  const dager = [];
  for (let d = periodeMin(); d <= periodeMaks(); d = addDaysISO(d, 1)) dager.push(d);
  return dager;
}

async function lastKalender() {
  const seq = ++kalSeq;
  const dager = periodeDager();
  dager.forEach(d => kalStatus.set(d, 'laster'));
  renderKalender();
  const statusEl = el('kal-status');
  statusEl.textContent = 'Henter nedbørsserier …';

  const p = periodeSerier();
  const [rrRes, tRes] = await Promise.allSettled([p.rr, p.time]);
  if (seq !== kalSeq) return;
  if (rrRes.status === 'rejected') {
    dager.forEach(d => kalStatus.set(d, 'feil'));
    statusEl.textContent = 'Nedbørsserier kunne ikke hentes – kalenderen kan ikke beregnes.';
    renderKalender();
    return;
  }
  const rrMap = rrRes.value;
  const tMap  = tRes.status === 'fulfilled' ? tRes.value : new Map();

  let ferdig = 0;
  await medBegrensning(dager, KAL_SAMTIDIGE, async dag => {
    let resultat = 'feil';
    try {
      const sm = await vannmetningFor(dag);
      const rrMaks = rrMap.get(dag)?.maks ?? null;
      const tMaks  = tMap.get(dag) ?? null;
      resultat = { ...beregnStatus(sm.maxPct, rrMaks, tMaks), rrMaks, tMaks, maxPct: sm.maxPct };
    } catch { /* dagen merkes som feil */ }
    if (seq !== kalSeq) return;
    kalStatus.set(dag, resultat);
    ferdig++;
    statusEl.textContent = ferdig < dager.length ? `Beregner … ${ferdig} av ${dager.length} dager`
      : tRes.status === 'rejected' ? 'Timesnedbør kunne ikke hentes – status er vurdert på døgnnedbør alene.' : '';
    renderKalender();
  });
}

function kalTooltip(dag, s) {
  const dato = fmtDag.format(isoTilDato(dag));
  const type = dag < todayISO() ? 'observert' : 'prognose';
  if (s === 'laster') return `${dato} · laster …`;
  if (s === 'feil' || !s) return `${dato} · kunne ikke hentes`;
  if (s.nivå === 'ukjent') return `${dato} · ${type}\nIkke nok data til å vurdere status`;
  const klasse = SM_KLASSER.find(c => c.midPct === s.maxPct)?.label.toLowerCase() ?? '–';
  return `${dato} · ${type}\n${NIVÅ_TEKST[s.nivå]} – scenario ${s.sc.no} (våteste celle ${klasse})\n`
    + `Høyeste døgnnedbør: ${nf(s.rrMaks)} mm (terskel ${s.sc.threshD})\n`
    + (s.tMaks != null ? `Høyeste timesnedbør: ${nf(s.tMaks)} mm/t (terskel ${s.sc.threshH})`
                       : 'Høyeste timesnedbør: ikke tilgjengelig');
}

// Felles månedsrutenett for begge kalenderne. Begge viser alltid SAMME måned,
// slik at lokal og regional vurdering kan sammenlignes dag for dag.
// celleFn(iso) → { klasser: [], tittel } for dager innenfor perioden.
function tegnMånedsgrid(prefiks, celleFn) {
  const { y, m } = kalMåned;
  const min = periodeMin(), max = periodeMaks(), idag = todayISO();
  const førsteUkedag = new Date(y, m, 1).getDay();       // 0 = søndag
  const forskyv = førsteUkedag === 0 ? 6 : førsteUkedag - 1;
  const dagerIMnd = new Date(y, m + 1, 0).getDate();

  let html = UKEDAGER.map(d => `<span class="kal-ukedag">${d}</span>`).join('');
  html += '<span></span>'.repeat(forskyv);
  for (let d = 1; d <= dagerIMnd; d++) {
    const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (iso < min || iso > max) {
      html += `<span class="kd kd-utenfor">${d}</span>`;
      continue;
    }
    const c  = celleFn(iso);
    const kl = ['kd', ...c.klasser];
    if (iso >= idag)       kl.push('kd-prognose');
    if (iso === idag)      kl.push('kd-idag');
    if (iso === valgtDato) kl.push('kd-valgt');
    html += `<button type="button" class="${kl.join(' ')}" data-iso="${iso}" title="${esc(c.tittel)}"`
          + `${iso === valgtDato ? ' aria-pressed="true"' : ''}>${d}</button>`;
  }
  el(`${prefiks}-grid`).innerHTML = html;
  el(`${prefiks}-tittel`).textContent = `${storForbokstav(MÅNEDER[m])} ${y}`;

  // Pilene er bare aktive når nabomåneden overlapper perioden
  const mndStart = (yy, mm) => `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
  const neste = m === 11 ? [y + 1, 0] : [y, m + 1];
  el(`${prefiks}-forrige`).disabled = mndStart(y, m) <= min;
  el(`${prefiks}-neste`).disabled   = mndStart(...neste) > max;
}

// Tegner begge kalenderne og Varsom-detaljene for valgt dato
function renderKalender() {
  if (!kalMåned) return;
  tegnMånedsgrid('kal', iso => {
    const s = kalStatus.get(iso);
    return {
      klasser: [s === 'laster' ? 'kd-laster' : (s === 'feil' || !s) ? 'kd-ukjent' : `kd-${s.nivå}`],
      tittel: kalTooltip(iso, s),
    };
  });
  tegnMånedsgrid('vk', varsomCelle);
  renderVarsomDetalj();
}

function kalNav(retning) {
  const { y, m } = kalMåned;
  kalMåned = retning < 0
    ? (m === 0  ? { y: y - 1, m: 11 } : { y, m: m - 1 })
    : (m === 11 ? { y: y + 1, m: 0 }  : { y, m: m + 1 });
  renderKalender();
}

function kalInit() {
  for (const prefiks of ['kal', 'vk']) {
    el(`${prefiks}-grid`).addEventListener('click', e => {
      const celle = e.target.closest('.kd[data-iso]');
      if (celle) velgDato(celle.dataset.iso);
    });
    el(`${prefiks}-forrige`).addEventListener('click', () => kalNav(-1));
    el(`${prefiks}-neste`).addEventListener('click', () => kalNav(1));
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  VARSOM – NVEs regionale jord-, flom- og sørpeskredvarsler
// ──────────────────────────────────────────────────────────────────────────
// Åpent API (NLOD, åpen CORS). Ett kall per kommune dekker hele perioden.
// Rektangelet berører både Sunnfjord og Askvoll (NV-hjørnet), som av og til
// har ulikt nivå – vi viser det høyeste. Varsom publiserer t.o.m. i dag +2;
// senere dager står som «Ikke vurdert» (nivå 0).
const VARSOM_API      = 'https://api01.nve.no/hydrology/forecast/landslide/v1.0.10/api/Warning/Municipality';
const VARSOM_LENKE    = 'https://www.varsom.no/flom-og-jordskred/varsling/';
const VARSOM_KOMMUNER = { 4647: 'Sunnfjord', 4645: 'Askvoll' };
const VARSOM_NIVÅ     = {
  0: { navn: 'Ikke vurdert', kode: 'ukjent' },
  1: { navn: 'Grønt nivå',   kode: 'gronn' },
  2: { navn: 'Gult nivå',    kode: 'gul' },
  3: { navn: 'Oransje nivå', kode: 'oransje' },
  4: { navn: 'Rødt nivå',    kode: 'rod' },
};
// DangerType: 4 sørpeskred, 5 jord- og flomskred, 6 jord-/sørpe-/flomskred, 7 sørpe- og flomskred
const VARSOM_SØRPE = new Set([4, 6, 7]);

const varsomData = new Map(); // dagISO → { nivå, type, typeNavn, årsaker, tekst, kommuneNivå }
let varsomStatus = 'laster';  // 'laster' | 'ok' | 'feil'
let varsomSeq = 0;

async function lastVarsom() {
  const seq = ++varsomSeq;
  const start = periodeMin(), slutt = periodeMaks();
  let status = 'ok';
  const nye = new Map();
  try {
    const svar = await Promise.all(Object.entries(VARSOM_KOMMUNER).map(async ([id, kommune]) => {
      const r = await fetch(`${VARSOM_API}/${id}/1/${start}/${slutt}`);
      if (!r.ok) throw new Error('Varsom HTTP ' + r.status);
      return { kommune, varsler: await r.json() };
    }));
    for (const { kommune, varsler } of svar) {
      for (const w of varsler) {
        const dag  = w.ValidFrom.slice(0, 10);   // varseldøgnet er kl 07–07
        const post = {
          nivå:     Number(w.ActivityLevel) || 0,
          type:     Number(w.DangerType) || null,
          typeNavn: w.DangerTypeName || '',
          årsaker:  (w.CauseList || []).map(c => c.Name),
          tekst:    w.MainText || '',
        };
        const eks = nye.get(dag);
        if (!eks) nye.set(dag, { ...post, kommuneNivå: { [kommune]: post.nivå } });
        else {
          eks.kommuneNivå[kommune] = post.nivå;
          if (post.nivå > eks.nivå) Object.assign(eks, post);
        }
      }
    }
  } catch {
    status = 'feil';
  }
  if (seq !== varsomSeq) return;
  varsomData.clear();
  for (const [dag, v] of nye) varsomData.set(dag, v);
  varsomStatus = status;
  renderKalender();
}

// Ulikt nivå mellom kommunene → «Sunnfjord gult, Askvoll grønt»
function varsomUlikhet(v) {
  const nivåer = Object.entries(v.kommuneNivå);
  if (new Set(nivåer.map(([, n]) => n)).size < 2) return '';
  return nivåer.map(([k, n]) => `${k} ${VARSOM_NIVÅ[n].navn.replace(' nivå', '').toLowerCase()}`).join(', ');
}

function varsomCelle(iso) {
  const dato = fmtDag.format(isoTilDato(iso));
  if (varsomStatus === 'laster') return { klasser: ['kd-laster'], tittel: `${dato} · laster Varsom …` };
  const v = varsomData.get(iso);
  if (!v) return { klasser: ['kd-ukjent'], tittel: `${dato} · ingen data fra Varsom` };
  const niv  = VARSOM_NIVÅ[v.nivå] || VARSOM_NIVÅ[0];
  const ulik = varsomUlikhet(v);
  return {
    // Sørpeskred er en fare den lokale kalenderen ikke modellerer – merkes i hjørnet
    klasser: [`kd-${niv.kode}`, ...(VARSOM_SØRPE.has(v.type) ? ['kd-sorpe'] : [])],
    tittel: `${dato} · Varsom: ${niv.navn}`
      + (v.typeNavn ? `\n${v.typeNavn}` : '')
      + (v.årsaker.length ? `\nÅrsak: ${v.årsaker.join(', ')}` : '')
      + (ulik ? `\nUlikt mellom kommunene: ${ulik}` : ''),
  };
}

// Detaljer for valgt dato under Varsom-kalenderen
function renderVarsomDetalj() {
  const ut = el('vk-detalj');
  if (varsomStatus === 'laster') { ut.innerHTML = ''; return; }
  if (varsomStatus === 'feil') {
    ut.innerHTML = FEIL_HTML('Varslene kunne ikke hentes fra Varsom.');
    return;
  }
  const v = varsomData.get(valgtDato);
  if (!v || v.nivå === 0) {
    ut.innerHTML = `
      <div class="varsel varsel-ukjent">
        <p class="varsel-tittel">Ikke vurdert</p>
        <p>Varsom publiserer jordskredvarsler for i dag og to dager fram.</p>
      </div>`;
    return;
  }
  const niv  = VARSOM_NIVÅ[v.nivå];
  const ulik = varsomUlikhet(v);
  ut.innerHTML = `
    <div class="varsel varsel-${niv.kode}">
      <p class="varsel-tittel">${niv.navn}${v.typeNavn ? ` – ${esc(v.typeNavn.toLowerCase())}` : ''}</p>
      ${v.årsaker.length ? `<p><b>Årsak:</b> ${esc(v.årsaker.join(', '))}</p>` : ''}
      ${v.tekst && v.nivå > 1 ? `<p>${esc(v.tekst)}</p>` : ''}
      ${v.nivå === 1 && !v.typeNavn ? '<p>Ingen varslet skredfare.</p>' : ''}
      ${ulik ? `<p><b>Ulikt mellom kommunene:</b> ${ulik}</p>` : ''}
      <p><a href="${VARSOM_LENKE}" target="_blank" rel="noopener">Se varselet på varsom.no</a></p>
    </div>`;
}

// ──────────────────────────────────────────────────────────────────────────
//  DATOVALG – én felles dato styrer kartlagene, arealrapporten og kalenderne
// ──────────────────────────────────────────────────────────────────────────
function gyldigDato(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso || '') && iso >= periodeMin() && iso <= periodeMaks();
}

function tegnDatovelger() {
  const dato = isoTilDato(valgtDato);
  el('dato-tekst').innerHTML    = `${fmtDag.format(dato)}<span class="aar"> ${dato.getFullYear()}</span>`;
  el('panel-dato').textContent  = storForbokstav(fmtLang.format(dato));
  el('dato-forrige').disabled   = valgtDato <= periodeMin();
  el('dato-neste').disabled     = valgtDato >= periodeMaks();
  el('dato-idag').disabled      = valgtDato === todayISO();
}

function velgDato(iso) {
  if (!gyldigDato(iso)) return;
  valgtDato = iso;
  const [y, m] = iso.split('-').map(Number);
  kalMåned = { y, m: m - 1 };

  tegnDatovelger();
  byggLag('sm');
  byggLag('rr');
  lastArealrapport();
  renderKalender();

  // Datoen ligger i adressen, slik at en bestemt dag kan deles som lenke
  history.replaceState(null, '', iso === todayISO() ? location.pathname : `?dato=${iso}`);
}

function datoInit() {
  el('dato-forrige').addEventListener('click', () => velgDato(addDaysISO(valgtDato, -1)));
  el('dato-neste').addEventListener('click',   () => velgDato(addDaysISO(valgtDato, 1)));
  el('dato-idag').addEventListener('click',    () => velgDato(todayISO()));
}

// ──────────────────────────────────────────────────────────────────────────
//  OPPDATERING – siden står gjerne åpen lenge, så data hentes på nytt jevnlig
// ──────────────────────────────────────────────────────────────────────────
function merkOppdatert() {
  sistOppdatert = Date.now();
  el('oppdatert-tekst').textContent = 'Oppdatert kl. '
    + new Date().toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
}

function oppdaterAlt() {
  const idag = todayISO();
  // Sto siden på «i dag» da døgnet skiftet, følger den med til ny dato
  const fulgteIdag = valgtDato === dagVedOppdatering;
  dagVedOppdatering = idag;
  oppdatering++;
  smLager.clear();
  periodeData = null;
  kalStatus.clear();

  velgDato(fulgteIdag || !gyldigDato(valgtDato) ? idag : valgtDato);
  lastKalender();
  lastVarsom();
  merkOppdatert();
}

function oppdateringInit() {
  el('oppdater').addEventListener('click', oppdaterAlt);
  // «Prøv igjen»-knapper i feilmeldinger
  document.addEventListener('click', e => { if (e.target.closest('[data-oppdater]')) oppdaterAlt(); });

  const sjekk = () => {
    if (!document.hidden && Date.now() - sistOppdatert >= OPPDATER_MS) oppdaterAlt();
  };
  setInterval(sjekk, 60e3);
  document.addEventListener('visibilitychange', sjekk);
}

// ──────────────────────────────────────────────────────────────────────────
//  OPPSTART
// ──────────────────────────────────────────────────────────────────────────
function init() {
  map = L.map('map', { zoomSnap: 0.25 });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  // Hele overvåkningsområdet synlig ved oppstart. Er kartet bredt nok, står
  // kartlag-panelet åpent og området legges til venstre for det.
  const bredtKart = el('map').offsetWidth >= 700;
  kartlagInit(bredtKart);
  map.fitBounds(AREA_RECT.bounds, {
    paddingTopLeft: [24, 24],
    paddingBottomRight: [24 + (bredtKart ? el('kartlag').offsetWidth + 10 : 0), 24],
  });

  // Kartverket gråtone – gratis og uten nøkkel. (Carto krever API-nøkkel fra
  // høsten 2026 og leverte bare «API KEY REQUIRED»-fliser.) NB: {y} før {x}.
  L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png', {
    attribution: '© Kartverket',
    maxZoom: 18,
  }).addTo(map);

  areaRect = L.rectangle(AREA_RECT.bounds, {
    color: '#12303f', weight: 2.5, fill: false, dashArray: '8 5',
  }).bindTooltip(AREA_RECT.label, { sticky: true }).addTo(map);

  L.circleMarker([STATION.lat, STATION.lon], {
    radius: 6, color: '#fff', weight: 2, fillColor: '#12303f', fillOpacity: 1,
  }).bindTooltip(`<b>${STATION.name}</b><br>${STATION.id} · nedbørsstasjon`, { direction: 'top', offset: [0, -6] })
    .addTo(map);

  kalInit();
  datoInit();
  oppdateringInit();

  // Arealrapport og kalender deler nedbørsseriene og vannmetningsbildene,
  // så dagens dato hentes bare én gang
  const fraAdresse = new URLSearchParams(location.search).get('dato');
  velgDato(gyldigDato(fraAdresse) ? fraAdresse : todayISO());
  lastKalender();
  lastVarsom();
  merkOppdatert();
}

init();
