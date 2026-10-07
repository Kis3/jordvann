const ALLOWED_ORIGINS = [
  'https://skredvarsel-fv609.vercel.app',
  'http://localhost:3000',
];

// Kun temaene tjenesten faktisk bruker – rr (døgnnedbør) og rr1h (timesnedbør)
const ALLOWED_THEMES = ['rr', 'rr1h'];

export default async function handler(req, res) {
  const { x, y, start, end } = req.query;
  const theme = req.query.theme || 'rr';

  // Valider parametre før de settes inn i URL-en mot gts.nve.no
  const isInt  = v => /^-?\d+$/.test(v);
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!isInt(x) || !isInt(y) || !isDate(start) || !isDate(end) || !ALLOWED_THEMES.includes(theme)) {
    return res.status(400).send('Invalid params: x/y integers, start/end yyyy-mm-dd, theme rr|rr1h');
  }

  // CORS: kun egne origins (samme-origin-kall har ingen Origin-header og passerer)
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  const url = `https://gts.nve.no/api/GridTimeSeries/${x}/${y}/${start}/${end}/${theme}.csv`;
  try {
    const r    = await fetch(url);
    const text = await r.text();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    // Dagsdata endrer seg sjelden – la Vercels edge-cache svare i 1 time
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    res.status(200).send(text);
  } catch (e) {
    res.status(502).send('Proxy error: ' + e.message);
  }
}
