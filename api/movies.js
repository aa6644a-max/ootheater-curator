/**
 * Vercel Serverless Function — 영화 검색 프록시
 *
 * 3-소스 병렬 구조:
 *   TMDB  (primary)   → 포스터(고화질), 줄거리, 배우
 *   KMDb  (secondary) → 한국 키워드/영화제정보, 스틸컷, 신작 보완
 *   KOFIC (tertiary)  → 공식 등록정보(개봉상태, 장르, 독립영화 필터)
 *
 * 필드별 우선순위:
 *   poster_url : TMDB > KMDb > null
 *   plot       : TMDB 한국어 > KMDb 한국어
 *   keywords   : KMDb (영화제 키워드 강점)
 *   stills     : KMDb
 *   status     : KOFIC (공식 개봉상태)
 *   director   : KMDb > KOFIC
 *   actors     : TMDB > KMDb
 */

const KOFIC_BASE = "https://www.kobis.or.kr/kobisopenapi/webservice/rest/movie/searchMovieList.json";
const KMDB_BASE  = "https://api.koreafilm.or.kr/openapi-data2/wisenut/search_api/search_json2.jsp";
const TMDB_BASE  = "https://api.themoviedb.org/3";
const TMDB_IMG   = "https://image.tmdb.org/t/p/w500";

const clean   = s => (s || "").replace(/!HS\s?|!HE\s?/g, "").trim();
const fullRes = url => url ? url.replace(/^http:\/\//i, "https://") : url;

/* ── 제목 정규화 (중복 판단용) ──────────────── */
const norm = t => (t || "").toLowerCase().replace(/[\s\-·:：]/g, "");

/* ── 연도 근접 판단 ──────────────────────────── */
function yearClose(y1, y2, tol = 1) {
  const a = parseInt(y1) || 0, b = parseInt(y2) || 0;
  return a > 0 && b > 0 && Math.abs(a - b) <= tol;
}

/* ══ TMDB ══════════════════════════════════════ */

async function tmdbSearch(q, tmdbKey, count = 20) {
  if (!q || !tmdbKey) return [];

  // 원본 + 공백제거 변형 모두 검색 후 합산
  const variants = [q];
  const qNoSp = q.replace(/\s+/g, "");
  if (qNoSp !== q) variants.push(qNoSp);

  const seenIds = new Set();
  const all = [];
  await Promise.all(variants.map(async v => {
    const p = new URLSearchParams({ api_key: tmdbKey, query: v, language: "ko-KR", region: "KR" });
    try {
      const res  = await fetch(`${TMDB_BASE}/search/movie?${p}`);
      const data = await res.json();
      for (const item of (data.results || [])) {
        if (item.original_language === "ko" && !seenIds.has(item.id)) {
          seenIds.add(item.id);
          all.push(item);
        }
      }
    } catch {}
  }));
  return all.slice(0, count);
}

/* ── TMDB 감독 필모그래피 검색 ──────────────── */
async function tmdbDirectorSearch(director, tmdbKey, count = 30, tmdbMovieId = null) {
  if (!director || !tmdbKey) return [];
  try {
    let personId = null;

    // tmdbMovieId가 있으면 해당 영화 크레딧에서 정확한 person ID 확인 (동명이인 방지)
    if (tmdbMovieId) {
      const credRes  = await fetch(`${TMDB_BASE}/movie/${tmdbMovieId}/credits?api_key=${tmdbKey}&language=ko-KR`);
      const credData = await credRes.json();
      const matched  = (credData.crew || []).find(
        c => c.job === "Director" && norm(c.name) === norm(director)
      );
      if (matched) personId = matched.id;
    }

    // person ID 없으면 이름으로 검색 (첫 번째 감독 역할 인물)
    if (!personId) {
      const personRes  = await fetch(
        `${TMDB_BASE}/search/person?${new URLSearchParams({ api_key: tmdbKey, query: director, language: "ko-KR" })}`
      );
      const personData = await personRes.json();
      const person = (personData.results || []).find(p => p.known_for_department === "Directing")
        || personData.results?.[0];
      if (!person) return [];
      personId = person.id;
    }

    // 해당 인물의 연출작 목록
    const creditsRes  = await fetch(
      `${TMDB_BASE}/person/${personId}/movie_credits?${new URLSearchParams({ api_key: tmdbKey, language: "ko-KR" })}`
    );
    const creditsData = await creditsRes.json();

    return (creditsData.crew || [])
      .filter(m => m.job === "Director" && m.original_language === "ko")
      .sort((a, b) => (b.release_date || "").localeCompare(a.release_date || ""))
      .slice(0, count);
  } catch { return []; }
}

function parseTMDb(item) {
  return {
    id:         `tmdb_${item.id}`,
    tmdb_id:    item.id,
    title:      item.title || item.original_title || "",
    director:   "",
    year:       (item.release_date || "").substring(0, 4),
    status:     "",
    type:       "",
    genre:      "",
    runtime:    item.runtime || null,
    poster_url: item.poster_path    ? `${TMDB_IMG}${item.poster_path}`    : null,
    backdrop:   item.backdrop_path  ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : null,
    plot:       item.overview || "",
    keywords:   [],
    actors:     [],
    stills:     [],
  };
}

/* ══ KMDb ══════════════════════════════════════ */

async function kmdbFetch(params, kmdbKey) {
  params.set("ServiceKey", kmdbKey);
  params.set("detail",     "Y");
  params.set("collection", "kmdb_new2");
  try {
    const res  = await fetch(`${KMDB_BASE}?${params}`);
    const data = await res.json();
    return data?.Data?.[0]?.Result || [];
  } catch { return []; }
}

async function kmdbQuery(q, director, kmdbKey, listCount = 20, searchBy = "query") {
  const base = { startCount: "0", listCount: String(listCount) };

  if (director && !q) {
    return kmdbFetch(new URLSearchParams({ ...base, director }), kmdbKey);
  }

  if (searchBy === "title" && q) {
    const qNoSp = q.replace(/\s+/g, "");

    const p1 = new URLSearchParams({ ...base, title: q });
    if (director) p1.set("director", director);
    let titleResults = await kmdbFetch(p1, kmdbKey);

    // 공백 제거 버전으로 재시도
    if (!titleResults.length && qNoSp !== q) {
      const p1b = new URLSearchParams({ ...base, title: qNoSp });
      if (director) p1b.set("director", director);
      titleResults = await kmdbFetch(p1b, kmdbKey);
    }

    // 제목 결과 없을 때만 query(전체필드) 폴백 — 있으면 제목 결과만 반환
    if (!titleResults.length) {
      const p2 = new URLSearchParams({ ...base, query: q });
      if (director) p2.set("director", director);
      return kmdbFetch(p2, kmdbKey);
    }

    return titleResults;
  }

  const p = new URLSearchParams({ ...base, query: q || "" });
  if (director) p.set("director", director);
  return kmdbFetch(p, kmdbKey);
}

function parseKMDb(item, koficMatch = null) {
  const directorList = item.directors?.director || [];
  const director = directorList.map(d => clean(d.directorNm)).filter(Boolean).join(", ");
  const rt = parseInt(item.runtime);
  const posters   = item.posters || "";
  const stllsRaw  = item.stlls  || "";
  const plots     = item.plots?.plot || [];
  const kwRaw     = item.keywords || "";
  const actorList = item.actors?.actor || [];
  const plotText  = plots.find(p => p.plotLang === "한국어")?.plotText || plots[0]?.plotText || "";

  return {
    id:         koficMatch?.movieCd || item.DOCID || item.movieId || "",
    title:      clean(item.title),
    director,
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

/* ══ KOFIC ═════════════════════════════════════ */

async function koficSearch(q, director, koficKey) {
  const p = new URLSearchParams({ key: koficKey, curPage: "1", itemPerPage: "20" });
  if (q)        p.set("movieNm",    q);
  if (director) p.set("directorNm", director);
  try {
    const res  = await fetch(`${KOFIC_BASE}?${p}`);
    const data = await res.json();
    return (data.movieListResult?.movieList || [])
      .filter(m => (m.repNationNm || "").includes("한국"));
  } catch { return []; }
}

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

/* ══ 소스 병합 ══════════════════════════════════
 *  tmdb  → 포스터·줄거리·배우 우선
 *  kmdb  → 키워드·스틸컷·감독·한국어 보완
 *  kofic → id·status·type·genre 공식값
 * ════════════════════════════════════════════ */
function mergeRecord(tmdb, kmdb, kofic) {
  const t = tmdb ? parseTMDb(tmdb) : null;
  const k = kmdb ? parseKMDb(kmdb, kofic) : null;
  const c = kofic ? parseKOFIC(kofic) : null;

  // 기본 레코드: 있는 소스 중 우선순위대로
  const base = t || k || c;

  const merged = {
    id:         (c?.id) || (k?.id) || (t?.id) || "",
    tmdb_id:    t?.tmdb_id || null,
    title:      base.title,
    director:   k?.director || c?.director || "",
    year:       base.year,
    status:     c?.status || k?.status || "",
    type:       c?.type   || k?.type   || "",
    genre:      k?.genre  || c?.genre  || "",
    runtime:    t?.runtime ?? k?.runtime ?? null,
    poster_url: t?.poster_url || k?.poster_url || null,
    plot:       (t?.plot && t.plot.length > 10 ? t.plot : "") || k?.plot || "",
    keywords:   k?.keywords?.length ? k.keywords : [],
    actors:     t?.actors?.length   ? t.actors   : (k?.actors || []),
    // KMDb 스틸컷 우선, 없으면 TMDB backdrop 사용, 둘 다 합산
    stills:     [...(k?.stills || []), ...(t?.backdrop ? [t.backdrop] : [])],
  };

  return merged;
}

/* ══ 핸들러 ════════════════════════════════════ */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const {
    page = "1", yearFrom = "", yearTo = "", genre = "",
    searchBy = "query", tmdbMovieId = "",
  } = req.query;

  // 앞뒤 공백 제거 + 연속 공백 단일화
  const q        = (req.query.q        || "").trim().replace(/\s+/g, " ");
  const director = (req.query.director || "").trim().replace(/\s+/g, " ");

  const koficKey = process.env.KOFIC_API_KEY || "";
  const kmdbKey  = process.env.KMDB_API_KEY  || "";
  const tmdbKey  = process.env.TMDB_API_KEY  || "";

  /* ════ 검색 모드 ════════════════════════════ */
  if (q || director) {
    // 3개 소스 동시 검색
    // - 제목 검색: TMDB 제목검색 + KMDb + KOFIC
    // - 감독 검색: TMDB 인물→필모그래피 + KMDb 감독검색 + KOFIC 감독검색
    const [tmdbItems, kmdbItems, koficList] = await Promise.all([
      q ? tmdbSearch(q, tmdbKey, 30) : tmdbDirectorSearch(director, tmdbKey, 30, tmdbMovieId || null),
      kmdbQuery(q, director, kmdbKey, 50, searchBy),
      koficSearch(q, director, koficKey),
    ]);

    const results = [];

    // 제목+연도(±1) 기준 중복 체크
    const isDupe = (title, year) =>
      results.some(r => norm(r.title) === norm(title) && yearClose(r.year, year, 1));

    const usedKmdbIds  = new Set();
    const usedKoficIds = new Set();

    // 1순위: TMDB 결과 기준 merge
    for (const tmdb of tmdbItems) {
      const tYear  = (tmdb.release_date || "").substring(0, 4);
      const tTitle = tmdb.title || tmdb.original_title || "";
      if (isDupe(tTitle, tYear)) continue;

      // 제목+연도 매칭 → 실패 시 연도만으로 폴백 (영문/한글 제목 혼용 대응)
      let kmdb = kmdbItems.find(i => norm(clean(i.title)) === norm(tTitle) && yearClose(i.prodYear, tYear));
      if (!kmdb) kmdb = kmdbItems.find(i => yearClose(i.prodYear, tYear) && !usedKmdbIds.has(i.DOCID));

      let kofic = koficList.find(i => norm(i.movieNm) === norm(tTitle) && yearClose(i.prdtYear, tYear));
      if (!kofic) kofic = koficList.find(i => yearClose(i.prdtYear, tYear) && !usedKoficIds.has(i.movieCd));

      if (kmdb)  usedKmdbIds.add(kmdb.DOCID);
      if (kofic) usedKoficIds.add(kofic.movieCd);

      const record = mergeRecord(tmdb, kmdb || null, kofic || null);
      if (!record.title) continue;
      results.push(record);
    }

    // 2순위: KMDb 전용 결과 (TMDB에 없는 한국 독립신작)
    for (const kmdb of kmdbItems) {
      const kTitle = clean(kmdb.title);
      if (isDupe(kTitle, kmdb.prodYear)) continue;
      const kofic  = koficList.find(i => norm(i.movieNm) === norm(kTitle) && yearClose(i.prdtYear, kmdb.prodYear));
      const record = mergeRecord(null, kmdb, kofic || null);
      if (!record.title) continue;
      results.push(record);
    }

    // 3순위: KOFIC 전용 결과 (위 둘 다 없는 경우)
    for (const kofic of koficList) {
      if (isDupe(kofic.movieNm, kofic.prdtYear)) continue;
      results.push(parseKOFIC(kofic));
    }

    return res.json({ results, total: results.length, page: 1 });
  }

  /* ════ 브라우징 모드 ════════════════════════ */
  const koficParams = new URLSearchParams({
    key:           koficKey,
    curPage:       page,
    itemPerPage:   "20",
    prdtStartYear: yearFrom || "2020",
    prdtEndYear:   yearTo   || "2026",
  });
  if (genre) koficParams.set("genreNm", genre);

  let koficMovies = [], total = 0;
  try {
    const r    = await fetch(`${KOFIC_BASE}?${koficParams}`);
    const data = await r.json();
    const all  = data.movieListResult?.movieList || [];
    total       = parseInt(data.movieListResult?.totCnt || "0");
    koficMovies = all.filter(m => (m.repNationNm || "").includes("한국"));
  } catch (err) {
    return res.status(502).json({ error: "KOFIC API 오류", detail: err.message });
  }

  // TMDB + KMDb 병렬 보강
  const results = await Promise.all(
    koficMovies.map(async (m) => {
      const base = parseKOFIC(m);
      if (!base.title) return base;

      const [tmdbItems, kmdbItems] = await Promise.all([
        tmdbSearch(base.title, tmdbKey, 3),
        kmdbQuery(base.title, base.director, kmdbKey, 3),
      ]);

      const targetYear = parseInt(base.year) || 2026;
      const tmdb = tmdbItems.find(t => yearClose((t.release_date || "").substring(0, 4), targetYear)) || null;
      const kmdb = kmdbItems.find(i => yearClose(i.prodYear, targetYear)) || null;

      return mergeRecord(tmdb, kmdb, m);
    })
  );

  res.json({ results, total, page: parseInt(page) });
};
