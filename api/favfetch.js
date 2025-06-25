export default async function handler(req, res) {
  const domain = req.query.fetch;
  if (!domain) return res.status(400).send('Missing fetch param');

  try {
    const response = await fetch(`https://www.google.com/s2/favicons?sz=256&domain=${domain}`);
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "image/png";
    const base64 = Buffer.from(buffer).toString("base64");
    const dataUri = `data:${contentType};base64,${base64}`;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "text/plain");
    res.status(200).send(dataUri);
  } catch (e) {
    res.status(500).send("Error fetching favicon");
  }
}
