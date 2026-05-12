/**
 * Vercel Serverless Function — 카테고리 CRUD
 *
 * GET  /api/categories              → 카테고리 목록
 * GET  /api/categories?catId=xxx    → 카테고리 내 영화 목록
 * POST /api/categories              body: {name}           → 카테고리 생성
 * POST /api/categories?catId=xxx    body: {movie_id, movie_data} → 영화 추가
 * DELETE /api/categories?id=xxx     → 카테고리 삭제 (영화 포함)
 * DELETE /api/categories?rowId=xxx  → category_movies row 삭제
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TMDB_KEY     = process.env.TMDB_API_KEY || "";
const TMDB_IMG     = "https://image.tmdb.org/t/p/w500";

/* ── poster 없는 영화 TMDB로 보강 + Supabase 업데이트 ── */
async function enrichRow(row, sbHeaders) {
  const m = row.movie_data || {};
  if (m.poster_url || !TMDB_KEY || !m.title) return m;

  try {
    const p = new URLSearchParams({ api_key: TMDB_KEY, query: m.title, language: "ko-KR", region: "KR" });
    const res  = await fetch(`https://api.themoviedb.org/3/search/movie?${p}`);
    const data = await res.json();
    const match = (data.results || [])
      .filter(r => r.original_language === "ko")
      .find(r => Math.abs(parseInt((r.release_date || "").substring(0, 4)) - parseInt(m.year)) <= 1);

    if (!match) return m;

    const enriched = {
      ...m,
      poster_url: match.poster_path ? `${TMDB_IMG}${match.poster_path}` : m.poster_url,
      plot:       (!m.plot && match.overview) ? match.overview : m.plot,
    };

    // Supabase에 업데이트 (다음 로드부터 캐시)
    fetch(`${SUPABASE_URL}/rest/v1/category_movies?id=eq.${row.id}`, {
      method:  "PATCH",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body:    JSON.stringify({ movie_data: enriched }),
    }).catch(() => {});

    return enriched;
  } catch {
    return m;
  }
}

const sbHeaders = {
  apikey:        SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer:        "return=representation",
};

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { id, catId, rowId } = req.query;

  try {
    // ── GET ──────────────────────────────────────
    if (req.method === "GET") {
      if (catId) {
        const r    = await fetch(
          `${SUPABASE_URL}/rest/v1/category_movies?category_id=eq.${catId}&order=added_at.asc`,
          { headers: sbHeaders }
        );
        const rows = await r.json();
        if (!r.ok) return res.status(r.status).json(rows);

        // poster 없는 항목 TMDB로 보강 (병렬)
        const enrichedRows = await Promise.all(
          rows.map(async row => ({ ...row, movie_data: await enrichRow(row, sbHeaders) }))
        );
        return res.status(200).json(enrichedRows);
      }

      // 카테고리 목록 + 영화 수
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/categories?order=created_at.asc&select=id,name,created_at,category_movies(count)`,
        { headers: sbHeaders }
      );
      const raw = await r.json();
      const data = raw.map(c => ({
        id:          c.id,
        name:        c.name,
        created_at:  c.created_at,
        movie_count: c.category_movies?.[0]?.count ?? 0,
      }));
      return res.status(r.status).json(data);
    }

    // ── POST ─────────────────────────────────────
    if (req.method === "POST") {
      const body = req.body || {};

      if (catId) {
        // 영화 추가 (중복 시 무시)
        const r = await fetch(`${SUPABASE_URL}/rest/v1/category_movies`, {
          method:  "POST",
          headers: { ...sbHeaders, Prefer: "resolution=ignore-duplicates,return=representation" },
          body:    JSON.stringify({
            category_id: catId,
            movie_id:    body.movie_id,
            movie_data:  body.movie_data,
          }),
        });
        const data = await r.json();
        if (!r.ok) return res.status(r.status).json(data);
        if (!Array.isArray(data) || data.length === 0) {
          return res.status(409).json({ message: "이미 추가된 영화입니다." });
        }
        return res.status(r.status).json(data);
      }

      // 카테고리 생성
      if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: "SUPABASE_URL 또는 SUPABASE_KEY 환경변수가 설정되지 않았습니다." });
      }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/categories`, {
        method:  "POST",
        headers: sbHeaders,
        body:    JSON.stringify({ name: body.name }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);
      return res.status(r.status).json(data);
    }

    // ── DELETE ───────────────────────────────────
    if (req.method === "DELETE") {
      if (rowId) {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/category_movies?id=eq.${rowId}`,
          { method: "DELETE", headers: sbHeaders }
        );
        return res.status(r.status).end();
      }

      if (id) {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/categories?id=eq.${id}`,
          { method: "DELETE", headers: sbHeaders }
        );
        return res.status(r.status).end();
      }
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
