import express from 'express';
import cors from 'cors';
import { optimizeRoute } from '../services/geminiService';

type ImagePayload = { base64: string; mimeType: string };

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));

const port = process.env.PORT ? Number(process.env.PORT) : 8788;

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/optimize', async (req, res) => {
  try {
    const { stopsText, stops, images, preferences } = req.body ?? {};

    let stopsInput: string | undefined = typeof stopsText === 'string' && stopsText.trim()
      ? stopsText
      : undefined;

    if (!stopsInput && Array.isArray(stops)) {
      const toLine = (s: any) => {
        if (typeof s === 'string') return s;
        if (s && typeof s === 'object') {
          const label = s.label ?? s.name ?? s.id ?? 'Stop';
          if (typeof s.x === 'number' && typeof s.y === 'number') {
            return `${label}, ${s.x}, ${s.y}`;
          }
          return String(label);
        }
        return String(s);
      };
      stopsInput = stops.map(toLine).join('\n');
    }

    if (!stopsInput) {
      return res.status(400).json({ error: 'stopsText or stops array is required' });
    }

    const contextImages: ImagePayload[] = Array.isArray(images)
      ? images
          .filter(
            (img: any) =>
              img &&
              typeof img.base64 === 'string' &&
              img.base64.trim().length > 0 &&
              typeof img.mimeType === 'string'
          )
          .map((img: any) => ({ base64: img.base64, mimeType: img.mimeType }))
      : [];

    const result = await optimizeRoute(stopsInput, contextImages, preferences);

    const nodeMap = new Map(result.nodes.map(n => [n.id, n]));
    const toCoords = (path: string[]) =>
      path
        .map(id => nodeMap.get(id))
        .filter(Boolean)
        .map(n => [n!.x, n!.y]);

    const feature = (path: string[], label: string) => ({
      type: 'Feature',
      properties: { label },
      geometry: { type: 'LineString', coordinates: toCoords(path) },
    });

    const geojson = {
      type: 'FeatureCollection',
      features: [
        feature(result.baselinePath, 'baseline'),
        feature(result.optimizedPath, 'optimized'),
      ],
    };

    res.json({
      ok: true,
      meta: { generatedAt: new Date().toISOString() },
      result,
      geojson,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Unknown error' });
  }
});

app.listen(port, () => {
  console.log(`[reasonroute-api] listening on http://localhost:${port}`);
});
