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
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/category_movies?category_id=eq.${catId}&order=added_at.asc`,
          { headers: sbHeaders }
        );
        return res.status(r.status).json(await r.json());
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
