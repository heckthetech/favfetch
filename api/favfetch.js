export const config = {
  runtime: 'nodejs',
};

/*
  Favfetch.js.
  - Fetches image bytes (custom mapping or Google s2/favicons).
  - Compute transparent ratio and avg luminance of non-transparent pixels.
  - If >=50% transparent -> flatten onto white or black depending on avg luminance.
  - Re-encode flattened PNG and return data:image/png;base64,...
  - Reports to author for:
      * 404/4xx responses (no favicon)
      * Any time a PNG was flattened (transparent -> background filled)
      * server errors
  - Supports bracketed fetch param: ?fetch={http://example.com/path}
  */

// Simple in-memory dedupe (resets on cold start / redeploy — intended)
const reportedDomains = new Set();

import zlib from 'zlib';
import { createHash } from 'crypto';

const customFavicons = {
  'web.whatsapp.com': 'https://heckthetech.github.io/favfetch/api/whatsapp.webp',
  'whatsapp://': 'https://heckthetech.github.io/favfetch/api/whatsapp.webp',
  'tg://': 'https://www.google.com/s2/favicons?sz=256&domain=web.telegram.org',
  'coolnewtab://': 'https://heckthetech.github.io/favfetch/api/cntgl.webp',
  'steam://': 'https://heckthetech.github.io/favfetch/api/steaml.gif',
  'com.epicgames.launcher://': 'https://heckthetech.github.io/favfetch/api/epicl.webp',
  'messenger.com': 'https://heckthetech.github.io/favfetch/api/messenger.webp',
  'facebook.com/messages':'https://heckthetech.github.io/favfetch/api/facebookmessages.webp',
  'youtube.com/watch?v=dQw4w9WgXcQ': 'https://heckthetech.github.io/favfetch/api/rick.gif',
  'youtu.be/dQw4w9WgXcQ': 'https://heckthetech.github.io/favfetch/api/rick.gif',
  'rickastley.co.uk': 'https://heckthetech.github.io/favfetch/api/rick.gif',
  'aparsclassroom.com': 'https://heckthetech.github.io/favfetch/api/acs.webp',
  'mail.google.com': 'https://heckthetech.github.io/favfetch/api/gmail.webp',
  'drive.google.com': 'https://heckthetech.github.io/favfetch/api/gdrive.webp',
  'docs.google.com': 'https://heckthetech.github.io/favfetch/api/gdocs.webp',
  'excel.cloud.microsoft': 'https://heckthetech.github.io/favfetch/api/msexcel.webp',
  'gilmannewport.portalced.com': 'https://heckthetech.github.io/favfetch/api/gilm.webp',
  'bingx.com': 'https://heckthetech.github.io/favfetch/api/bingx.webp',
  '1337x': 'https://heckthetech.github.io/favfetch/api/13xx.webp',
  'rtdslive.com': 'https://heckthetech.github.io/favfetch/api/rtds.webp',
  'robininsights.github.io': 'https://heckthetech.github.io/favfetch/api/robininsights.webp',
  'github.com': 'https://heckthetech.github.io/favfetch/api/github.webp',
  'heckthetech.github.io/ecplay': 'https://heckthetech.github.io/favfetch/api/chronaplay.webp',
  'photos.google.com': 'https://heckthetech.github.io/favfetch/api/photos.webp',
  'epicgames.com': 'https://heckthetech.github.io/favfetch/api/epic.webp',
  'medico.com.bd': 'https://heckthetech.github.io/favfetch/api/userrequested/medico.webp',
  'pinterest.com': 'https://heckthetech.github.io/favfetch/api/userrequested/Pinterest.webp'
};


// thresholds
const ALPHA_THRESHOLD = 128;
const TRANSPARENT_RATIO_THRESHOLD = 0.5;
const LUMINANCE_THRESHOLD = 128;
const FORMSPREE_ENDPOINT = 'https://formspree.io/f/mwpqvkey';

// Helpers: read big-endian uint32
function readUInt32BE(buf, offset) {
  return buf.readUInt32BE(offset);
}

// CRC32 implementation (fast table)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      if (c & 1) c = 0xedb88320 ^ (c >>> 1);
      else c = c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(typeStr, dataBuf) {
  const typeBuf = Buffer.from(typeStr, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf ? dataBuf.length : 0, 0);
  const crcInput = Buffer.concat([typeBuf, dataBuf || Buffer.alloc(0)]);
  const crc = crc32(crcInput);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([lenBuf, typeBuf, dataBuf || Buffer.alloc(0), crcBuf]);
}

// Minimal PNG parser for common PNGs (non-interlaced, bitDepth=8).
function parsePNG(buf) {
  try {
    // Check PNG signature
    const PNG_SIG = Buffer.from([137,80,78,71,13,10,26,10]);
    if (buf.length < 8 || !buf.slice(0,8).equals(PNG_SIG)) return null;

    let offset = 8;
    let ihdr = null;
    let idatParts = [];
    let plte = null;
    let trns = null;
    let ended = false;

    while (offset < buf.length) {
      if (offset + 8 > buf.length) break;
      const len = readUInt32BE(buf, offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);
      const dataStart = offset + 8;
      const dataEnd = dataStart + len;
      if (dataEnd + 4 > buf.length) break;
      const data = buf.slice(dataStart, dataEnd);
      const crc = readUInt32BE(buf, dataEnd);
      offset = dataEnd + 4;

      if (type === 'IHDR') {
        ihdr = {
          width: readUInt32BE(data, 0),
          height: readUInt32BE(data, 4),
          bitDepth: data[8],
          colorType: data[9],
          compression: data[10],
          filter: data[11],
          interlace: data[12]
        };
      } else if (type === 'PLTE') {
        plte = data; // palette entries (3 * n)
      } else if (type === 'tRNS') {
        trns = data; // transparency for palette or gray
      } else if (type === 'IDAT') {
        idatParts.push(data);
      } else if (type === 'IEND') {
        ended = true;
        break;
      }
    }

    if (!ihdr || !ended) return null;
    if (ihdr.compression !== 0 || ihdr.filter !== 0) return null;
    if (ihdr.bitDepth !== 8) return null; // we support only 8-bit depth

    if (ihdr.interlace !== 0) return null; // no interlaced support

    const compressed = Buffer.concat(idatParts);
    const raw = zlib.inflateSync(compressed); // may throw

    // Determine channels and pixels per scanline
    let channels;
    switch (ihdr.colorType) {
      case 6: channels = 4; break; // RGBA
      case 2: channels = 3; break; // RGB
      case 0: channels = 1; break; // Gray
      case 3: channels = 1; break; // Palette (indexed)
      default: return null;
    }

    const width = ihdr.width, height = ihdr.height;
    const bytesPerPixel = channels;
    const expectedRowBytes = width * bytesPerPixel;
    const out = Buffer.alloc(width * height * 4); // RGBA output

    // Unfilter per PNG spec
    let pos = 0; // position in raw
    const prevLine = Buffer.alloc(expectedRowBytes);
    const curLine = Buffer.alloc(expectedRowBytes);

    for (let y = 0; y < height; y++) {
      if (pos >= raw.length) return null;
      const filterType = raw[pos++];
      if (pos + expectedRowBytes > raw.length) return null;
      // copy line bytes
      for (let i = 0; i < expectedRowBytes; i++, pos++) {
        curLine[i] = raw[pos];
      }
      // apply filter
      if (filterType === 0) {
        // none: do nothing
      } else if (filterType === 1) {
        // sub
        for (let i = 0; i < expectedRowBytes; i++) {
          const a = (i - bytesPerPixel) >= 0 ? curLine[i - bytesPerPixel] : 0;
          curLine[i] = (curLine[i] + a) & 0xff;
        }
      } else if (filterType === 2) {
        // up
        for (let i = 0; i < expectedRowBytes; i++) {
          const b = prevLine[i] || 0;
          curLine[i] = (curLine[i] + b) & 0xff;
        }
      } else if (filterType === 3) {
        // average
        for (let i = 0; i < expectedRowBytes; i++) {
          const a = (i - bytesPerPixel) >= 0 ? curLine[i - bytesPerPixel] : 0;
          const b = prevLine[i] || 0;
          curLine[i] = (curLine[i] + Math.floor((a + b) / 2)) & 0xff;
        }
      } else if (filterType === 4) {
        // paeth
        function paeth(a, b, c) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          if (pa <= pb && pa <= pc) return a;
          if (pb <= pc) return b;
          return c;
        }
        for (let i = 0; i < expectedRowBytes; i++) {
          const a = (i - bytesPerPixel) >= 0 ? curLine[i - bytesPerPixel] : 0;
          const b = prevLine[i] || 0;
          const c = (i - bytesPerPixel) >= 0 ? prevLine[i - bytesPerPixel] : 0;
          curLine[i] = (curLine[i] + paeth(a, b, c)) & 0xff;
        }
      } else {
        return null;
      }

      // convert to RGBA in out buffer
      for (let x = 0; x < width; x++) {
        const inIdx = x * bytesPerPixel;
        const outIdx = (y * width + x) * 4;
        if (ihdr.colorType === 6) {
          out[outIdx] = curLine[inIdx];
          out[outIdx + 1] = curLine[inIdx + 1];
          out[outIdx + 2] = curLine[inIdx + 2];
          out[outIdx + 3] = curLine[inIdx + 3];
        } else if (ihdr.colorType === 2) {
          out[outIdx] = curLine[inIdx];
          out[outIdx + 1] = curLine[inIdx + 1];
          out[outIdx + 2] = curLine[inIdx + 2];
          out[outIdx + 3] = 255;
        } else if (ihdr.colorType === 0) {
          const g = curLine[inIdx];
          out[outIdx] = g; out[outIdx + 1] = g; out[outIdx + 2] = g; out[outIdx + 3] = 255;
        } else if (ihdr.colorType === 3) {
          // palette index
          const idx = curLine[inIdx];
          if (!plte) return null;
          const palIdx = idx * 3;
          if (palIdx + 2 >= plte.length) return null;
          out[outIdx] = plte[palIdx];
          out[outIdx + 1] = plte[palIdx + 1];
          out[outIdx + 2] = plte[palIdx + 2];
          let alpha = 255;
          if (trns && idx < trns.length) alpha = trns[idx];
          out[outIdx + 3] = alpha;
        }
      }

      // swap prevLine and curLine
      prevLine.set(curLine);
    }

    return { width, height, data: out };
  } catch (e) {
    return null;
  }
}

// Encode RGBA buffer (width,height) into PNG (colorType=6) with filter type 0 per row
function encodePNG(rgbaBuf, width, height) {
  // Build raw image with filter bytes = 0 at start of each scanline
  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const dstRow = y * rowSize;
    raw[dstRow] = 0;
    const srcRow = y * width * 4;
    rgbaBuf.copy(raw, dstRow + 1, srcRow, srcRow + width * 4);
  }

  const compressed = zlib.deflateSync(raw);
  const PNG_SIG = Buffer.from([137,80,78,71,13,10,26,10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([PNG_SIG, ihdrChunk, idatChunk, iendChunk]);
}

// Analyze RGBA buffer: compute transparency ratio and avg luminance of non-transparent pixels
function analyzeRGBA(rgbaBuf) {
  const totalPixels = rgbaBuf.length / 4;
  let transparentCount = 0;
  let lumSum = 0;
  let lumCount = 0;
  const sampleStep = 1; // favicons are small; no heavy sampling required

  for (let i = 0; i < rgbaBuf.length; i += 4 * sampleStep) {
    const r = rgbaBuf[i];
    const g = rgbaBuf[i + 1];
    const b = rgbaBuf[i + 2];
    const a = rgbaBuf[i + 3];
    if (a < ALPHA_THRESHOLD) {
      transparentCount++;
    } else {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumSum += lum;
      lumCount++;
    }
  }

  const transparentRatio = transparentCount / (totalPixels || 1);
  const avgLuma = lumCount ? (lumSum / lumCount) : 255;
  return { transparentRatio, avgLuma };
}

// Flatten RGBA pixels over background color hex '#rrggbb'
// Scales the image to 80% and centers it on the background
function flattenRGBA(rgbaBuf, width, height, bgHex) {
  const bgR = parseInt(bgHex.slice(1,3), 16);
  const bgG = parseInt(bgHex.slice(3,5), 16);
  const bgB = parseInt(bgHex.slice(5,7), 16);
  
  // Output buffer same dimensions as input
  const out = Buffer.alloc(width * height * 4);

  // 1. Fill entire buffer with background color
  for (let i = 0; i < out.length; i += 4) {
    out[i] = bgR;
    out[i+1] = bgG;
    out[i+2] = bgB;
    out[i+3] = 255;
  }

  // 2. Draw scaled image (80%) in center
  const scale = 0.8;
  const scaledW = Math.floor(width * scale);
  const scaledH = Math.floor(height * scale);
  const offX = Math.floor((width - scaledW) / 2);
  const offY = Math.floor((height - scaledH) / 2);

  for (let y = 0; y < scaledH; y++) {
    for (let x = 0; x < scaledW; x++) {
      // Nearest neighbor mapping from scaled space back to original space
      const srcX = Math.floor(x / scale);
      const srcY = Math.floor(y / scale);
      
      // Clamp coordinates to stay within bounds
      const sX = Math.min(srcX, width - 1);
      const sY = Math.min(srcY, height - 1);
      
      const srcIdx = (sY * width + sX) * 4;
      
      const r = rgbaBuf[srcIdx];
      const g = rgbaBuf[srcIdx+1];
      const b = rgbaBuf[srcIdx+2];
      const a = rgbaBuf[srcIdx+3] / 255;

      const dstX = x + offX;
      const dstY = y + offY;
      const dstIdx = (dstY * width + dstX) * 4;

      // Alpha composite over the background color (already in 'out')
      // Formula: pixel = source * alpha + bg * (1 - alpha)
      const nr = Math.round(r * a + bgR * (1 - a));
      const ng = Math.round(g * a + bgG * (1 - a));
      const nb = Math.round(b * a + bgB * (1 - a));
      
      out[dstIdx] = nr;
      out[dstIdx+1] = ng;
      out[dstIdx+2] = nb;
      out[dstIdx+3] = 255;
    }
  }

  return out;
}

// utility: buffer -> dataURI string
function bufferToDataURI(buf, mime) {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Report small JSON to Formspree
async function reportToFormspree(payload) {
  try {
    // use global fetch (Node 18+ runtime/supported serverless runtimes)
    await fetch(FORMSPREE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    // don't block user response; just log
    console.warn('Formspree report failed:', e && e.message);
  }
}

export default async function handler(req, res) {
  let rawParam = req.query.fetch;
  const region = req.query.region || null;

  if (!rawParam) {
    res.status(400).send('Missing fetch param');
    return;
  }

  rawParam = String(rawParam);

  // If the client wrapped the fetch value in { ... }, extract inner value.
  // Example: ?fetch={http://www.unknownwebsite.com/}&silent=true
  let extracted = rawParam;
  if (extracted.startsWith('{')) {
    const closeIdx = extracted.lastIndexOf('}');
    if (closeIdx > 0) {
      extracted = extracted.slice(1, closeIdx);
    } else {
      // malformed but attempt: drop the leading '{'
      extracted = extracted.slice(1);
    }
  }

  // silent param controls whether to post to Formspree
  const silent = req.query.silent === 'true' || req.query.silent === '1';

  // Keep a preserved-case version for custom key matching
  let rawOriginal = extracted; // preserved
  // lowercased for domain parsing/matching
  let raw = rawOriginal.toLowerCase();
  let domain = raw;

  if (raw.startsWith('whatsapp://')) {
    domain = 'whatsapp://';
  } else if (raw.startsWith('http://') || raw.startsWith('https://')) {
    domain = raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  } else if (raw.includes('://')) {
    // other protocols like mailto:, tg:// etc — use the protocol or fallback
    domain = raw.split('://')[0];
  } else {
    // raw might be a plain domain with optional path, try to strip path
    domain = raw.split('/')[0];
  }

  // Match custom favicons using original (case-sensitive) string OR the normalized domain
  const matchedKey = Object.keys(customFavicons).find(
    (key) => rawOriginal.includes(key) || domain.includes(key)
  );

  let iconPath = null;
  if (matchedKey) iconPath = customFavicons[matchedKey];

  try {
    let buffer, mime, sourceName;

    if (iconPath) {
      sourceName = 'custom';
      if (iconPath.startsWith('http')) {
        const r = await fetch(iconPath);
        if (!r.ok) throw new Error('Remote fetch failed for custom icon');
        const arr = await r.arrayBuffer();
        buffer = Buffer.from(arr);
        mime = r.headers.get('content-type') || 'image/png';
      } else {
        const fs = require('fs');
        const path = require('path');
        const filePath = path.join(process.cwd(), 'public', iconPath.replace(/^\//, ''));
        buffer = fs.readFileSync(filePath);
        const ext = require('path').extname(filePath).toLowerCase();
        mime = { '.ico':'image/x-icon', '.svg':'image/svg+xml', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.png':'image/png', '.webp':'image/webp' }[ext] || 'image/png';
      }
    } else {
      // New Logic: Fetch from best source (replicates c.js strategy)
      // Sources to race/check
      const sources = [
        { url: `https://logo.clearbit.com/${domain}?size=512`, name: 'clearbit' },
        { url: `https://www.google.com/s2/favicons?sz=256&domain=${domain}`, name: 'google' },
        { url: `https://icons.duckduckgo.com/ip3/${domain}.ico`, name: 'ddg' }
      ];

      let winningResponse = null;
      let winningSource = null;

      // Parallel fetch
      const promises = sources.map(async (src) => {
        try {
          const r = await fetch(src.url);
          // Only use responses that are strictly 200-299 OK.
          // This prevents using 404 pages that might contain images (fallbacks).
          if (r.ok) {
              const contentType = r.headers.get('content-type');
              if (contentType && (contentType.startsWith('image/') || contentType === 'application/octet-stream')) {
                return { r, src };
              }
          }
        } catch(e) {}
        return null;
      });

      const results = await Promise.all(promises);

      // Prioritize results based on source order (effectively mimics "best quality")
      // Priority: Unavatar > Clearbit > Google > DDG
      // We look for the first non-null result in the order of the 'sources' array
      for (let i = 0; i < sources.length; i++) {
          const found = results[i]; // results index matches sources index
          if (found) {
              winningResponse = found.r;
              winningSource = found.src.name;
              break;
          }
      }

      if (!winningResponse) {
          // All failed, report if not silent
           if (!silent && !reportedDomains.has(domain)) {
              await reportToFormspree({
                event: 'all_sources_failed',
                source: 'all',
                domain,
                original: rawOriginal,
                region,
                timestamp: new Date().toISOString()
              });
              reportedDomains.add(domain);
            }
            res.status(404).send('Favicon fetch failed');
            return;
      }

      const arr = await winningResponse.arrayBuffer();
      buffer = Buffer.from(arr);
      mime = winningResponse.headers.get('content-type') || 'image/png';
      sourceName = winningSource;
    }

    // --- Processing Step (PNG Flattening) ---
    // If PNG, try to parse/analyze/flatten
    if (mime === 'image/png') {
        const parsed = parsePNG(buffer);
        if (parsed) {
          const { transparentRatio, avgLuma } = analyzeRGBA(parsed.data);
          if (transparentRatio >= TRANSPARENT_RATIO_THRESHOLD) {
            // Updated background color logic: #1f1f1f instead of #000000
            const bgHex = avgLuma < LUMINANCE_THRESHOLD ? '#ffffff' : '#1f1f1f';
            try {
              // Updated call: passing width and height to support resizing
              const flattened = flattenRGBA(parsed.data, parsed.width, parsed.height, bgHex);
              const pngOut = encodePNG(flattened, parsed.width, parsed.height);
              const outDataURI = bufferToDataURI(pngOut, 'image/png');

              // Report flatten event to Formspree (only if not silent and not already reported)
              if (!silent && !reportedDomains.has(domain)) {
                await reportToFormspree({
                  event: 'flattened',
                  source: sourceName,
                  domain: domain || null,
                  original: rawOriginal,
                  region,
                  transparentRatio: Number(transparentRatio.toFixed(4)),
                  avgLuma: Math.round(avgLuma),
                  timestamp: new Date().toISOString()
                });
                reportedDomains.add(domain);
              }

              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'text/plain');
              res.status(200).send(outDataURI);
              return;
            } catch (e) {
              // fallthrough to original dataURI if flattening fails
            }
          }
        }
      }

    // Default return
    const originalURI = bufferToDataURI(buffer, mime);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(originalURI);

  } catch (err) {
    console.error('favfetch error:', err && err.message);
    // minimal server error report (only if not silent)
    try {
      if (! (req.query.silent === 'true' || req.query.silent === '1')) {
        await reportToFormspree({
          event: 'server_error',
          domain: (req.query.fetch || '').toString().slice(0, 200),
          region,
          message: err && err.message,
          timestamp: new Date().toISOString()
        });
      }
    } catch (_) {}
    res.status(500).send('Server error');
  }
}
