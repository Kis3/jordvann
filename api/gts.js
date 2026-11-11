// Proxy mot gts.nve.no – NVE setter ingen CORS-header, så nettleseren kan ikke
// hente tidsseriene direkte.
//
//   /api/gts?theme=rr&start=…&end=…&punkter=x,y;x,y;…  → JSON, alle punktene i ETT kall
//   /api/gts?theme=rr&start=…&end=…&x=…&y=…            → CSV for ett punkt
//                                                        (rapport/historisk_rapport.html)
//
// Koordinater er UTM sone 33 (EPSG:32633), datoer yyyy-mm-dd.

const ALLOWED_ORIGINS = [
  'https://skredvarsel-fv609.vercel.app',
  'http://localhost:3000',
];

// Kun temaene tjenesten faktisk bruker – rr (døgnnedbør) og rr1h (timesnedbør)
const ALLOWED_THEMES = ['rr', 'rr1h'];
const MAKS_PUNKTER   = 200;
const TIDSAVBRUDD_MS = 20000;

const GTS = 'https://gts.nve.no/api';

export default async function handler(req, res) {
  const { x, y, start, end, punkter } = req.query;
  const theme = req.query.theme || 'rr';

  // Valider parametre før de sendes videre til gts.nve.no
  const isInt  = v => /^-?\d+$/.test(v);
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const punktliste = typeof punkter === 'string' && /^-?\d+,-?\d+(;-?\d+,-?\d+)*$/.test(punkter)
    ? punkter.split(';') : null;
  const gyldigSted = punkter !== undefined
    ? punktliste && punktliste.length <= MAKS_PUNKTER
    : isInt(x) && isInt(y);
  if (!gyldigSted || !isDate(start) || !isDate(end) || !ALLOWED_THEMES.includes(theme)) {
    return res.status(400).send(
      'Invalid params: x/y integers or punkter=x,y;x,y (max ' + MAKS_PUNKTER + '), start/end yyyy-mm-dd, theme rr|rr1h');
  }

  // CORS: kun egne origins (samme-origin-kall har ingen Origin-header og passerer)
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  try {
    const signal = AbortSignal.timeout(TIDSAVBRUDD_MS);
    const r = punktliste
      ? await fetch(`${GTS}/MultiPointTimeSeries/ByMapCoordinateCsv`, {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            Theme: theme, StartDate: start, EndDate: end, Format: 'json',
            MapCoordinateCsv: punktliste.map(p => p.replace(',', ' ')).join(', '),
          }),
        })
      : await fetch(`${GTS}/GridTimeSeries/${x}/${y}/${start}/${end}/${theme}.csv`, { signal });
    const text = await r.text();

    if (!r.ok) {
      // gts svarer 500 «key was not present» når ett av punktene ligger utenfor
      // rutenettet (hav). 422 forteller klienten at det er punktlisten som er
      // problemet, slik at den kan dele den opp og finne punktene som finnes.
      const ukjentCelle = punktliste && /not present in the dictionary/i.test(text);
      return res.status(ukjentCelle ? 422 : 502).send('gts.nve.no svarte ' + r.status);
    }

    res.setHeader('Content-Type', (punktliste ? 'application/json' : 'text/plain') + '; charset=utf-8');
    // Dagsdata endrer seg sjelden – la Vercels edge-cache svare i 1 time
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    res.status(200).send(text);
  } catch (e) {
    res.status(502).send('Proxy error: ' + e.message);
  }
}
