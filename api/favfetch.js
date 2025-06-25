// Force Node.js runtime by exporting config
export const config = {
  runtime: 'nodejs',
};

export default async function handler(req, res) {
  const domain = req.query.fetch;
  if (!domain) {
    res.status(400).send('Missing fetch param');
    return;
  }

  try {
    const response = await fetch(`https://www.google.com/s2/favicons?sz=256&domain=${domain}`);
    if (!response.ok) {
      res.status(response.status).send('Favicon fetch failed');
      return;
    }

    const buffer = await response.arrayBuffer();
    const mime = response.headers.get('content-type') || 'image/png';
    const base64 = Buffer.from(buffer).toString('base64');
    const dataURI = `data:${mime};base64,${base64}`;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(dataURI);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
}
