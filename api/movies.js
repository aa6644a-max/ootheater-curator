/**
 * Vercel Serverless Function — 영화 검색 프록시
 *
 * 검색 모드 (q 또는 director 있을 때):
 *   KMDb query 풀텍스트 검색 (primary) → KOFIC 교차보완 (secondary)
 *   → KMDb의 전체 필드 검색으로 영화제 키워드·감독·배우까지 커버
 *
 * 브라우징 모드 (q/director 없을 때):
 *   KOFIC 연도범위 검색 (primary) → KMDb 상세정보 보완 (secondary)
 */

const KOFIC_BASE = "https://www.kobis.or.kr/kobisopenapi/webservice/rest/movie/searchMovieList.json";
const KMDB_BASE  = "https://api.koreafilm.or.kr/openapi-data2/wisenut/search_api/search_json2.jsp";

/* ── KMDb 결과 → 공통 레코드 변환 ─────────────── */
function parseKMDb(item, koficMatch = null) {
  const directorList = item.directors?.director || [];
  const director = directorList.map(d => d.directorNm).filter(Boolean).join(", ");

  const posters   = item.posters || "";
  const plots     = item.plots?.plot || [];
  const kwRaw     = item.keywords || "";
  const stllsRaw  = item.stlls || "";
  const actorList = item.actors?.actor || [];
  const rt        = parseInt(item.runtime);

  return {
    id:         koficMatch?.movieCd || item.DOCID || item.movieId || "",
    title:      (item.title || "").replace(/!HS|!HE/g, "").trim(),
    director:   director,
    year:       item.prodYear || "",
    status:     koficMatch?.prdtStatNm || "",
    type:       koficMatch?.typeNm    || "",
    genre:      (item.genre || koficMatch?.repGenreNm || "").split(",")[0].trim(),
    runtime:    isNaN(rt) ? null : rt,
    poster_url: posters ? posters.split("|")[0] : null,
    plot:       plots.find(p => p.plotLang === "한국어")?.plotText || plots[0]?.plotText || "",
    keywords:   kwRaw ? kwRaw.split("|").map(k => k.trim()).filter(Boolean) : [],
    actors:     actorList.slice(0, 8).map(a => a.actorNm).filter(Boolean),
    stills:     stllsRaw ? stllsRaw.split("|").slice(0, 8).filter(Boolean) : [],
  };
}

/* ── KOFIC 결과 → 공통 레코드 변환 ────────────── */
function parseKOFIC(m) {
  return {
    id:         m.movieCd || "",
    title:      (m.movieNm || "").trim(),
    director:   m.directors?.[0]?.peopleNm?.trim() || "",
    year:       m.prdtYear || "",
    status:     m.prdtStatNm || "",
    type:       m.typeNm || "",
    genre:      m.repGenreNm || "",
    runtime:    null,
    poster_url: null,
    plot:       "",
    keywords:   [],
    actors:     [],
    stills:     [],
  };
}

/* ── KMDb 풀텍스트 검색 ──────────────────────── */
async function kmdbQuery(q, director, kmdbKey, listCount = 20) {
  const params = new URLSearchParams({
    ServiceKey:  kmdbKey,
    startCount:  "0",
    listCount:   String(listCount),
    detail:      "Y",
    collection:  "kmdb_new2",
  });
  // query는 전체 필드 풀텍스트. title은 제목 한정.
  // 둘 다 보내면 AND 조건 → 제목 검색 시 더 정확.
  if (q)        params.set("query", q);
  if (director) params.set("director", director);

  try {
    const res  = await fetch(`${KMDB_BASE}?${params}`);
    const data = await res.json();
    return data?.Data?.[0]?.Result || [];
  } catch {
    return [];
  }
}

/* ── KOFIC 제목 검색 (보완용) ────────────────── */
async function koficSearch(q, director, koficKey) {
  const params = new URLSearchParams({
    key:         koficKey,
    curPage:     "1",
    itemPerPage: "20",
  });
  if (q)        params.set("movieNm",    q);
  if (director) params.set("directorNm", director);

  try {
    const res  = await fetch(`${KOFIC_BASE}?${params}`);
    const data = await res.json();
    return (data.movieListResult?.movieList || [])
      .filter(m => (m.repNationNm || "").includes("한국"));
  } catch {
    return [];
  }
}

/* ── 제목+연도로 KOFIC 매칭 ─────────────────── */
function matchKofic(kmdbItem, koficList) {
  const kmdbTitle = (kmdbItem.title || "").replace(/!HS|!HE/g, "").trim();
  const kmdbYear  = parseInt(kmdbItem.prodYear) || 0;
  return koficList.find(k => {
    const titleMatch = k.movieNm?.trim() === kmdbTitle;
    const yearMatch  = Math.abs(parseInt(k.prdtYear) - kmdbYear) <= 1;
    return titleMatch && yearMatch;
  }) || null;
}

/* ── 핸들러 ─────────────────────────────────── */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const {
    q = "", director = "",
    page = "1", yearFrom = "", yearTo = "", genre = ""
  } = req.query;

  const koficKey = process.env.KOFIC_API_KEY || "";
  const kmdbKey  = process.env.KMDB_API_KEY  || "";

  /* ════ 검색 모드: KMDb primary ════════════════ */
  if (q || director) {
    // KMDb 풀텍스트 검색과 KOFIC 검색을 병렬 실행
    const [kmdbItems, koficList] = await Promise.all([
      kmdbQuery(q, director, kmdbKey, 20),
      koficSearch(q, director, koficKey),
    ]);

    if (!kmdbItems.length && !koficList.length) {
      return res.json({ results: [], total: 0, page: 1 });
    }

    // KMDb 결과 기반으로 레코드 구성 (KOFIC으로 공식 정보 보완)
    const seen    = new Set();
    const results = [];

    for (const item of kmdbItems) {
      const koficMatch = matchKofic(item, koficList);
      const record     = parseKMDb(item, koficMatch);
      if (!record.title) continue;
      const key = `${record.title}__${record.year}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(record);
    }

    // KMDb에 없는 KOFIC 결과도 추가 (제목이 겹치지 않는 것만)
    for (const m of koficList) {
      const key = `${m.movieNm?.trim()}__${m.prdtYear}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(parseKOFIC(m));
    }

    return res.json({ results, total: results.length, page: 1 });
  }

  /* ════ 브라우징 모드: KOFIC primary ═══════════ */
  const koficParams = new URLSearchParams({
    key:         koficKey,
    curPage:     page,
    itemPerPage: "20",
    prdtStartYear: yearFrom || "2020",
    prdtEndYear:   yearTo   || "2026",
  });
  if (genre) koficParams.set("genreNm", genre);

  let koficMovies = [], total = 0;
  try {
    const koficRes  = await fetch(`${KOFIC_BASE}?${koficParams}`);
    const koficData = await koficRes.json();
    const all       = koficData.movieListResult?.movieList || [];
    total           = parseInt(koficData.movieListResult?.totCnt || "0");
    koficMovies     = all.filter(m => (m.repNationNm || "").includes("한국"));
  } catch (err) {
    return res.status(502).json({ error: "KOFIC API 오류", detail: err.message });
  }

  // KMDb로 상세정보 보완
  const results = await Promise.all(
    koficMovies.map(async (m) => {
      const record = parseKOFIC(m);
      if (!kmdbKey || !record.title) return record;
      try {
        const items = await kmdbQuery(record.title, record.director, kmdbKey, 3);
        const targetYear = parseInt(record.year) || 2026;
        for (const item of items) {
          if (Math.abs(parseInt(item.prodYear) - targetYear) > 1) continue;
          const enriched = parseKMDb(item, m);
          return { ...enriched, id: record.id, status: record.status, type: record.type };
        }
      } catch { /* 무시 */ }
      return record;
    })
  );

  res.json({ results, total, page: parseInt(page) });
};
