/**
 * Vercel Serverless Function — TMDB 스틸컷 추가 로드
 * GET /api/images?tmdbId={id}
 */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { tmdbId } = req.query;
  const tmdbKey = process.env.TMDB_API_KEY || "";

  if (!tmdbId || !tmdbKey) return res.json({ stills: [] });

  try {
    const r    = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}/images?api_key=${tmdbKey}`
    );
    const data = await r.json();

    const stills = (data.backdrops || [])
      .slice(0, 20)
      .map(b => `https://image.tmdb.org/t/p/w780${b.file_path}`);

    res.json({ stills });
  } catch {
    res.json({ stills: [] });
  }
};
