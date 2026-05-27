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
const TMDB_KEY     = process.env.TMDB_API_KEY  || "";
const KMDB_KEY     = process.env.KMDB_API_KEY  || "";
const KOFIC_KEY    = process.env.KOFIC_API_KEY || "";
const TMDB_IMG     = "https://image.tmdb.org/t/p/w500";
const KMDB_BASE    = "https://api.koreafilm.or.kr/openapi-data2/wisenut/search_api/search_json2.jsp";
const KOFIC_BASE   = "https://www.kobis.or.kr/kobisopenapi/webservice/rest/movie/searchMovieList.json";

const fixUrl  = u => u.replace(/^http:\/\//i, "https://").replace(/\/img\//g, "/thm/");
const cleanStr = s => (s || "").replace(/!HS\s?|!HE\s?/g, "").trim();
const ENRICH_TTL = 7 * 24 * 60 * 60 * 1000; // 7일

/* ── 카테고리 영화 데이터 자동 보강 + Supabase 캐시 업데이트 ── */
async function enrichRow(row, sbHeaders) {
  const m = { ...(row.movie_data || {}) };
  if (!m.title) return m;

  let changed = false;

  // URL 수정은 API 호출 없이 항상 즉시 적용
  if (m.poster_url) {
    const fixed = fixUrl(m.poster_url);
    if (fixed !== m.poster_url) { m.poster_url = fixed; changed = true; }
  }
  if (m.stills?.length) {
    const fixed = m.stills.map(fixUrl);
    if (fixed.some((u, i) => u !== m.stills[i])) { m.stills = fixed; changed = true; }
  }

  // 7일 이내 보강 완료된 경우 → API 호출 없이 리턴
  const fresh = m.enriched_at && (Date.now() - new Date(m.enriched_at).getTime() < ENRICH_TTL);
  if (fresh) {
    if (changed) {
      fetch(`${SUPABASE_URL}/rest/v1/category_movies?id=eq.${row.id}`, {
        method:  "PATCH",
        headers: { ...sbHeaders, Prefer: "return=minimal" },
        body:    JSON.stringify({ movie_data: m }),
      }).catch(() => {});
    }
    return m;
  }

  // TTL 만료 → 전체 필드 최신화 (누락 여부와 무관하게 항상 갱신)

  // TMDB — 포스터, 줄거리, tmdb_id 갱신
  if (TMDB_KEY) {
    try {
      const p = new URLSearchParams({ api_key: TMDB_KEY, query: m.title, language: "ko-KR", region: "KR" });
      const res  = await fetch(`https://api.themoviedb.org/3/search/movie?${p}`);
      const data = await res.json();
      const match = (data.results || [])
        .filter(r => r.original_language === "ko")
        .find(r => Math.abs(parseInt((r.release_date || "").substring(0, 4)) - parseInt(m.year)) <= 1);
      if (match) {
        if (match.poster_path) { m.poster_url = `${TMDB_IMG}${match.poster_path}`; changed = true; }
        if (match.overview)    { m.plot = match.overview; changed = true; }
        if (match.id)          { m.tmdb_id = match.id;   changed = true; }
      }
    } catch {}
  }

  // KMDb — 스틸컷, 키워드, 감독, 러닝타임, 줄거리(TMDB 없을 때) 갱신
  if (KMDB_KEY) {
    try {
      const p = new URLSearchParams({
        ServiceKey: KMDB_KEY, detail: "Y", collection: "kmdb_new2",
        title: m.title, startCount: "0", listCount: "5",
      });
      const firstDir = (m.director || "").split(",")[0].trim();
      if (firstDir) p.set("director", firstDir);
      const r    = await fetch(`${KMDB_BASE}?${p}`);
      const data = await r.json();
      const results = data?.Data?.[0]?.Result || [];
      const hit = results.find(item =>
        !m.year || Math.abs(parseInt(item.prodYear) - parseInt(m.year)) <= 1
      );
      if (hit) {
        if (hit.stlls) {
          const stills = hit.stlls.split("|").slice(0, 8).filter(Boolean).map(fixUrl);
          if (stills.length) { m.stills = stills; changed = true; }
        }
        if (hit.keywords) {
          const kws = hit.keywords.split("|").map(cleanStr).filter(Boolean);
          if (kws.length) { m.keywords = kws; changed = true; }
        }
        if (!m.poster_url && hit.posters) {
          const poster = fixUrl(hit.posters.split("|")[0]);
          if (poster) { m.poster_url = poster; changed = true; }
        }
        if (!m.plot && hit.plots?.plot) {
          const plots = hit.plots.plot;
          const plotText = plots.find(p => p.plotLang === "한국어")?.plotText || plots[0]?.plotText || "";
          if (plotText) { m.plot = cleanStr(plotText); changed = true; }
        }
        const directorList = hit.directors?.director || [];
        const director = directorList.map(d => cleanStr(d.directorNm)).filter(Boolean).join(", ");
        if (director) { m.director = director; changed = true; }
        const rt = parseInt(hit.runtime);
        if (!isNaN(rt) && rt > 0) { m.runtime = rt; changed = true; }
      }
    } catch {}
  }

  // KOFIC — 개봉상태(status), 장르(genre), 타입(type) 갱신
  if (KOFIC_KEY) {
    try {
      const p = new URLSearchParams({ key: KOFIC_KEY, curPage: "1", itemPerPage: "5", movieNm: m.title });
      const firstDir = (m.director || "").split(",")[0].trim();
      if (firstDir) p.set("directorNm", firstDir);
      const r    = await fetch(`${KOFIC_BASE}?${p}`);
      const data = await r.json();
      const list = (data.movieListResult?.movieList || [])
        .filter(item => (item.repNationNm || "").includes("한국"));
      const hit = list.find(item =>
        !m.year || Math.abs(parseInt(item.prdtYear) - parseInt(m.year)) <= 1
      ) || list[0];
      if (hit) {
        if (hit.prdtStatNm) { m.status = hit.prdtStatNm; changed = true; }
        if (hit.repGenreNm) { m.genre  = hit.repGenreNm; changed = true; }
        if (hit.typeNm)     { m.type   = hit.typeNm;     changed = true; }
      }
    } catch {}
  }

  // 보강 완료 시각 기록
  m.enriched_at = new Date().toISOString();
  changed = true;

  // 변경 사항 Supabase에 비동기 캐시 업데이트
  fetch(`${SUPABASE_URL}/rest/v1/category_movies?id=eq.${row.id}`, {
    method:  "PATCH",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body:    JSON.stringify({ movie_data: m }),
  }).catch(() => {});

  return m;
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

        // 데이터 보강 (병렬) — enrichRow 내부에서 7일 TTL 캐시 적용
        const enrichedRows = await Promise.all(
          rows.map(async row => ({ ...row, movie_data: await enrichRow(row, sbHeaders) }))
        );
        res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
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
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
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
