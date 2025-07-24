// Force Node.js runtime by exporting config
export const config = {
  runtime: 'nodejs',
};

const customFavicons = {
  'web.whatsapp.com': 'https://heckthetech.github.io/favfetch/api/whatsapp.png',
  'whatsapp://': 'https://heckthetech.github.io/favfetch/api/whatsapp.png',
  'messenger.com': 'https://heckthetech.github.io/favfetch/api/messenger.png',
  'youtube.com/watch?v=dQw4w9WgXcQ': 'https://heckthetech.github.io/favfetch/api/rick.gif',
  'rickastley.co.uk': 'https://heckthetech.github.io/favfetch/api/rick.gif',
  'aparsclassroom.com': 'https://heckthetech.github.io/favfetch/api/acs.webp',
  'mail.google.com': 'https://heckthetech.github.io/favfetch/api/gmail.png',
  'drive.google.com': 'https://heckthetech.github.io/favfetch/api/gdrive.png',
  // Add more here
};

export default async function handler(req, res) {
  let raw = req.query.fetch;
  if (!raw) {
    res.status(400).send('Missing fetch param');
    return;
  }

  raw = raw.toLowerCase();
  let domain = raw;

  if (raw.startsWith('whatsapp://')) {
    domain = 'whatsapp://';
  } else if (raw.startsWith('http://') || raw.startsWith('https://')) {
    domain = raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }

  const matchedKey = Object.keys(customFavicons).find((key) => raw.includes(key) || domain.includes(key));
  if (matchedKey) {
    const iconPath = customFavicons[matchedKey];

    try {
      let buffer, mime;

      if (iconPath.startsWith('http')) {
        const response = await fetch(iconPath);
        if (!response.ok) throw new Error('Remote fetch failed');
        buffer = await response.arrayBuffer();
        mime = response.headers.get('content-type') || 'image/png';
      } else {
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
      console.error(`Custom favicon error for ${domain}:`, err);
      res.status(500).send('Custom favicon error');
      return;
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
    console.error(`Default favicon fetch failed for ${domain}:`, err);
    res.status(500).send('Server error');
  }
}
