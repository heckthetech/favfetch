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
  'docs.google.com': 'https://heckthetech.github.io/favfetch/api/gdocs.webp',
  'docs.google.com': 'https://heckthetech.github.io/favfetch/api/gdocs.webp',
  'heckthetech.github.io/ecplay': 'https://heckthetech.github.io/favfetch/api/chronaplay.png',
  'excel.cloud.microsoft': 'https://heckthetech.github.io/favfetch/api/msexcel.jpg'
  // Add more here
};

// Image analysis thresholds
const ALPHA_THRESHOLD = 128; // alpha < 128 counts as transparent (0-255)
const TRANSPARENT_RATIO_THRESHOLD = 0.5; // 50%
const LUMINANCE_THRESHOLD = 128; // below -> dark => use white bg; above -> light => use black bg
const MAX_SAMPLE_PIXELS = 20000; // cap sampling to avoid heavy CPU

async function trySharp() {
  try {
    const mod = await import('sharp');
    return mod.default ?? mod;
  } catch (e) {
    console.warn('sharp not available:', e && e.message);
    return null;
  }
}

async function analyzeBufferForTransparencyAndLuma(buf, sharp) {
  // returns { transparentRatio, avgLuma } for non-transparent pixels
  // if analysis fails returns null
  try {
    // Ensure alpha channel and get raw pixels
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const width = info.width;
    const height = info.height;
    const channels = info.channels; // should be 4 after ensureAlpha
    if (!width || !height || channels < 4) return null;

    const totalPixels = width * height;
    // choose sampling step so we examine <= MAX_SAMPLE_PIXELS pixels
    let step = 1;
    if (totalPixels > MAX_SAMPLE_PIXELS) {
      step = Math.ceil(Math.sqrt(totalPixels / MAX_SAMPLE_PIXELS));
    }

    let sampled = 0;
    let transparentCount = 0;
    let lumSum = 0;
    let lumCount = 0;

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * channels;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3];
        sampled++;
        if (a < ALPHA_THRESHOLD) {
          transparentCount++;
        } else {
          // Rec.709 luminance
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          lumSum += lum;
          lumCount++;
        }
      }
    }

    const transparentRatio = transparentCount / Math.max(1, sampled);
    const avgLuma = lumCount ? (lumSum / lumCount) : 255;
    return { transparentRatio, avgLuma };
  } catch (err) {
    console.warn('analysis error:', err && err.message);
    return null;
  }
}

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
        buffer = Buffer.from(buffer);
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
          '.webp': 'image/webp'
        }[ext] || 'image/png';
      }

      // Try to analyze & possibly flatten using sharp
      const sharp = await trySharp();
      if (sharp) {
        const analysis = await analyzeBufferForTransparencyAndLuma(buffer, sharp);
        if (analysis && analysis.transparentRatio >= TRANSPARENT_RATIO_THRESHOLD) {
          // choose background color by avg luma of non-transparent pixels
          const bgHex = analysis.avgLuma < LUMINANCE_THRESHOLD ? '#ffffff' : '#000000';
          try {
            // flatten (composite over bg) and emit PNG to be safe
            const newBuf = await sharp(buffer).flatten({ background: bgHex }).png().toBuffer();
            const base64 = newBuf.toString('base64');
            const dataURI = `data:image/png;base64,${base64}`;

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'text/plain');
            res.status(200).send(dataURI);
            return;
          } catch (err) {
            console.warn('sharp flatten failed, falling back to original:', err && err.message);
            // fallthrough to send original
          }
        }
      } // else no sharp available -> skip analysis

      // If no change or analysis unavailable, serve original as dataURI
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
    const buf = Buffer.from(buffer);

    // Try analysis & flatten with sharp if available
    const sharp = await trySharp();
    if (sharp) {
      const analysis = await analyzeBufferForTransparencyAndLuma(buf, sharp);
      if (analysis && analysis.transparentRatio >= TRANSPARENT_RATIO_THRESHOLD) {
        const bgHex = analysis.avgLuma < LUMINANCE_THRESHOLD ? '#ffffff' : '#000000';
        try {
          const newBuf = await sharp(buf).flatten({ background: bgHex }).png().toBuffer();
          const base64 = newBuf.toString('base64');
          const dataURI = `data:image/png;base64,${base64}`;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'text/plain');
          res.status(200).send(dataURI);
          return;
        } catch (err) {
          console.warn('sharp flatten failed on google fallback, sending original:', err && err.message);
        }
      }
    }

    // Send original if no modification done
    const base64 = buf.toString('base64');
    const dataURI = `data:${mime};base64,${base64}`;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(dataURI);
  } catch (err) {
    console.error(`Default favicon fetch failed for ${domain}:`, err);
    res.status(500).send('Server error');
  }
}
