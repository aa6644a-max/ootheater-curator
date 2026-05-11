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

/* ── KMDb !HS !HE 하이라이트 태그 제거 ────────── */
const clean = s => (s || "").replace(/!HS\s?|!HE\s?/g, "").trim();

/* ── KMDb 썸네일 URL → 원본 해상도 URL 변환 ─── */
const fullRes = url => url ? url.replace(/\/thm\//g, "/img/") : url;

/* ── KMDb 결과 → 공통 레코드 변환 ─────────────── */
function parseKMDb(item, koficMatch = null) {
  const directorList = item.directors?.director || [];
  const director = directorList.map(d => clean(d.directorNm)).filter(Boolean).join(", ");

  const posters   = item.posters || "";
  const plots     = item.plots?.plot || [];
  const kwRaw     = item.keywords || "";
  const stllsRaw  = item.stlls || "";
  const actorList = item.actors?.actor || [];
  const rt        = parseInt(item.runtime);

  const plotText = plots.find(p => p.plotLang === "한국어")?.plotText || plots[0]?.plotText || "";

  return {
    id:         koficMatch?.movieCd || item.DOCID || item.movieId || "",
    title:      clean(item.title),
    director:   director,
    year:       item.prodYear || "",
    status:     koficMatch?.prdtStatNm || "",
    type:       koficMatch?.typeNm    || "",
    genre:      clean((item.genre || koficMatch?.repGenreNm || "").split(",")[0]),
    runtime:    isNaN(rt) ? null : rt,
    poster_url: posters ? fullRes(posters.split("|")[0]) : null,
    plot:       clean(plotText),
    keywords:   kwRaw ? kwRaw.split("|").map(k => clean(k)).filter(Boolean) : [],
    actors:     actorList.slice(0, 8).map(a => clean(a.actorNm)).filter(Boolean),
    stills:     stllsRaw ? stllsRaw.split("|").slice(0, 8).filter(Boolean).map(fullRes) : [],
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

/* ── KMDb 단일 검색 ──────────────────────────── */
async function kmdbFetch(params, kmdbKey) {
  params.set("ServiceKey", kmdbKey);
  params.set("detail",     "Y");
  params.set("collection", "kmdb_new2");
  try {
    const res  = await fetch(`${KMDB_BASE}?${params}`);
    const data = await res.json();
    return data?.Data?.[0]?.Result || [];
  } catch {
    return [];
  }
}

/* ── KMDb 검색 (title 우선, 없으면 query 폴백) ── */
async function kmdbQuery(q, director, kmdbKey, listCount = 20, searchBy = "query") {
  const base = { startCount: "0", listCount: String(listCount) };

  if (director && !q) {
    // 감독 검색
    const p = new URLSearchParams({ ...base, director });
    return kmdbFetch(p, kmdbKey);
  }

  if (searchBy === "title" && q) {
    // 1차: title 파라미터로 정확 검색
    const p1 = new URLSearchParams({ ...base, title: q });
    if (director) p1.set("director", director);
    const titleResults = await kmdbFetch(p1, kmdbKey);

    // 2차: title 결과 없으면 query(전체필드)로 재시도
    if (!titleResults.length) {
      const p2 = new URLSearchParams({ ...base, query: q });
      if (director) p2.set("director", director);
      return kmdbFetch(p2, kmdbKey);
    }

    // title 결과 있으면 query도 병렬 실행 후 합산 (title 결과 먼저)
    const p2 = new URLSearchParams({ ...base, query: q });
    if (director) p2.set("director", director);
    const queryResults = await kmdbFetch(p2, kmdbKey);

    // title 결과를 앞에, query 추가분을 뒤에 (DOCID 기준 중복 제거)
    const seen = new Set(titleResults.map(r => r.DOCID));
    const extra = queryResults.filter(r => !seen.has(r.DOCID));
    return [...titleResults, ...extra];
  }

  // query 모드 (기본)
  const p = new URLSearchParams({ ...base, query: q });
  if (director) p.set("director", director);
  return kmdbFetch(p, kmdbKey);
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
    page = "1", yearFrom = "", yearTo = "", genre = "",
    searchBy = "query",   // "title" | "query"
  } = req.query;

  const koficKey = process.env.KOFIC_API_KEY || "";
  const kmdbKey  = process.env.KMDB_API_KEY  || "";

  /* ════ 검색 모드: KMDb primary ════════════════ */
  if (q || director) {
    // KMDb 풀텍스트 검색과 KOFIC 검색을 병렬 실행
    const [kmdbItems, koficList] = await Promise.all([
      kmdbQuery(q, director, kmdbKey, 50, searchBy),
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
