const STUDIO_URL = "https://api.studio.thegraph.com/query/1742338/ach/version/latest";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = process.env.GRAPH_QUERY_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "Missing GRAPH_QUERY_TOKEN server environment variable" });
  }

  try {
    const upstream = await fetch(STUDIO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(req.body ?? {}),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    return res.send(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown subgraph proxy error";
    return res.status(502).json({ error: message });
  }
}
