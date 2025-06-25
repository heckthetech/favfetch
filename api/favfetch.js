// Force Node.js runtime by exporting config
export const config = {
  runtime: 'nodejs',
};

const customFavicons = {
  'web.whatsapp.com': '/whatsapp.png',
  'messenger.com': '/messenger.png'
  // add more here
};

export default async function handler(req, res) {
  const domain = req.query.fetch;
  if (!domain) {
    res.status(400).send('Missing fetch param');
    return;
  }

  // Check if domain matches custom favicon overrides
  for (const key in customFavicons) {
    if (domain.includes(key)) {
      // Serve the custom image as base64 data URI
      try {
        // Assuming these files are in the public folder (Next.js)
        const fs = require('fs');
        const path = require('path');
        const filePath = path.join(process.cwd(), 'public', customFavicons[key].replace(/^\//, ''));

        const fileBuffer = fs.readFileSync(filePath);
        // Infer mime type from extension
        const ext = path.extname(filePath).toLowerCase();
        let mime = 'image/png';
        if (ext === '.ico') mime = 'image/x-icon';
        else if (ext === '.svg') mime = 'image/svg+xml';
        else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
        else if (ext === '.gif') mime = 'image/gif';

        const base64 = fileBuffer.toString('base64');
        const dataURI = `data:${mime};base64,${base64}`;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'text/plain');
        res.status(200).send(dataURI);
        return;
      } catch (err) {
        console.error('Error reading custom favicon:', err);
        res.status(500).send('Custom favicon error');
        return;
      }
    }
  }

  // Otherwise fetch from Google as usual
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
