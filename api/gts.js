export default async function handler(req, res) {
  const { x, y, start, end } = req.query;
  if (!x || !y || !start || !end) {
    return res.status(400).send('Missing params');
  }
  const url = `https://gts.nve.no/api/GridTimeSeries/${x}/${y}/${start}/${end}/rr.csv`;
  try {
    const r    = await fetch(url);
    const text = await r.text();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(text);
  } catch (e) {
    res.status(502).send('Proxy error: ' + e.message);
  }
}
