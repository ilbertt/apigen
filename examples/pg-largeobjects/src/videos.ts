import { relation } from './api.gen.ts';
import { db } from './db.ts';

// One row from video_chunk(): the clamped window and its bytes. int4 columns arrive as
// numbers; a bytea column arrives as a Uint8Array.
interface Chunk {
  content_type: string;
  total_size: number;
  chunk_start: number;
  chunk_length: number;
  data: Uint8Array;
}

const RANGE_RE = /^bytes=(\d+)-(\d*)$/;

// `GET /videos`            → the catalog (a normal apigen relation response).
// `GET /videos?id=eq.<n>`  → the video bytes, with HTTP range support, so a browser can
//                            point a <video> straight at the URL and seek.
//
// apigen owns the endpoint: it routes the request, applies the relation's authorization,
// and runs the select. The byte-slicing is delegated to the video_chunk() SQL function
// (lo_get on the large object). afterExecute only does what SQL can't: read the request's
// Range header and shape a 200 / 206 binary response. It keys off the *authorized row
// count*, never its columns, so a caller's `?select=` can't break the download.
export const videos = relation('videos').select({
  afterExecute: async ({ req, response }) => {
    const url = new URL(req.url);
    const idFilter = url.searchParams.get('id');
    if (!idFilter) {
      return response;
    }
    const rows = (await response.json()) as unknown[];
    if (rows.length !== 1) {
      return new Response('Not found', { status: 404 });
    }

    const id = Number(idFilter.replace(/^eq\./, ''));
    const match = RANGE_RE.exec(req.headers.get('range') ?? '');
    const start = match ? Number(match[1]) : 0;
    const length = match?.[2] ? Number(match[2]) - start + 1 : null;

    const result = await db`select * from video_chunk(${id}, ${start}, ${length})`;
    const chunk = result[0] as Chunk | undefined;
    if (!chunk) {
      return new Response('Not found', { status: 404 });
    }

    const headers: Record<string, string> = {
      'content-type': chunk.content_type,
      'accept-ranges': 'bytes',
      'content-length': String(chunk.chunk_length),
    };
    if (match) {
      const end = chunk.chunk_start + chunk.chunk_length - 1;
      headers['content-range'] = `bytes ${chunk.chunk_start}-${end}/${chunk.total_size}`;
    }
    return new Response(chunk.data, { status: match ? 206 : 200, headers });
  },
});
