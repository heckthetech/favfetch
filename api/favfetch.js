// Force Node.js runtime by exporting config
export const config = {
  runtime: 'nodejs',
};

const customFavicons = {
  'web.whatsapp.com': 'https://web.whatsapp.com/favicon/2x/favicon/',
  'messenger.com': '/messenger.png',
  // Add more here
};

export default async function handler(req, res) {
  const domain = req.query.fetch;
  if (!domain) {
    res.status(400).send('Missing fetch param');
    return;
  }

  for (const key in customFavicons) {
    if (domain.includes(key)) {
      const iconPath = customFavicons[key];

      try {
        let buffer, mime;

        if (iconPath.startsWith('http')) {
          // Remote URL fetch
          const response = await fetch(iconPath);
          if (!response.ok) throw new Error('Remote fetch failed');
          buffer = await response.arrayBuffer();
          mime = response.headers.get('content-type') || 'image/png';
        } else {
          // Local file read
          const fs = require('fs');
          const path = require('path');
          const filePath = path.join(process.cwd(), 'public', iconPath.replace(/^\//, ''));
          buffer = fs.readFileSync(filePath);

          const ext = path.extname(filePath).toLowerCase();
          mime = {
            '.ico': 'image/x-icon',
            '.svg': 'image/svg+xml',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.png': 'image/png',
          }[ext] || 'image/png';
        }

        const base64 = Buffer.from(buffer).toString('base64');
        const dataURI = `data:${mime};base64,${base64}`;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'text/plain');
        res.status(200).send(dataURI);
        return;
      } catch (err) {
        console.error('Custom favicon error:', err);
        res.status(500).send('Custom favicon error');
        return;
      }
    }
  }

  // Default Google favicon fallback
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
