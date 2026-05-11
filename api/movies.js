/**
 * Vercel Serverless Function — KOFIC + KMDb 프록시
 * API 키를 서버사이드에서 보관하고 브라우저에 결과만 반환
 *
 * Query params:
 *   q        검색어 (제목)
 *   director 감독명
 *   page     페이지 번호 (기본 1)
 */

const KOFIC_BASE = "https://www.kobis.or.kr/kobisopenapi/webservice/rest/movie/searchMovieList.json";
const KMDB_BASE  = "https://api.koreafilm.or.kr/openapi-data2/wisenut/search_api/search_json2.jsp";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { q = "", director = "", page = "1", yearFrom = "", yearTo = "", genre = "" } = req.query;

  // ── 1. KOFIC 검색 ────────────────────────────
  const koficParams = new URLSearchParams({
    key:         process.env.KOFIC_API_KEY,
    curPage:     page,
    itemPerPage: "20",
  });
  // 연도 범위: 직접 지정 > 기본 브라우징용(검색어 없을 때 2020~2026)
  if (yearFrom) {
    koficParams.set("prdtStartYear", yearFrom);
  } else if (!q && !director) {
    koficParams.set("prdtStartYear", "2020");
  }
  if (yearTo) {
    koficParams.set("prdtEndYear", yearTo);
  } else if (!q && !director) {
    koficParams.set("prdtEndYear", "2026");
  }
  if (q)        koficParams.set("movieNm",    q);
  if (director) koficParams.set("directorNm", director);
  if (genre)    koficParams.set("genreNm",    genre);

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

  // ── 2. KMDb 교차검증 (키 있을 때만) ──────────
  const kmdbKey = process.env.KMDB_API_KEY || "";
  const results = await Promise.all(
    koficMovies.map(async (m) => {
      const record = {
        id:         m.movieCd,
        title:      (m.movieNm || "").trim(),
        director:   m.directors?.[0]?.peopleNm?.trim() || "",
        year:       m.prdtYear || "",
        status:     m.prdtStatNm || "",
        type:       m.typeNm || "",
        genre:      m.repGenreNm || "",
        runtime:    null,
        poster_url: null,
        plot:       null,
        keywords:   [],
        actors:     [],
        stills:     [],
      };

      if (!kmdbKey || !record.title) return record;

      try {
        const kmdbParams = new URLSearchParams({
          ServiceKey: kmdbKey,
          title:      record.title,
          director:   record.director,
          startCount: "0",
          listCount:  "3",
          detail:     "Y",
          collection: "kmdb_new2",
        });
        const kmdbRes  = await fetch(`${KMDB_BASE}?${kmdbParams}`);
        const kmdbData = await kmdbRes.json();
        const items    = kmdbData?.Data?.[0]?.Result || [];
        const targetYear = parseInt(record.year) || 2026;

        for (const item of items) {
          const prodYear = parseInt(item.prodYear);
          if (isNaN(prodYear) || Math.abs(prodYear - targetYear) > 1) continue;

          const posters = item.posters || "";
          record.poster_url = posters ? posters.split("|")[0] : null;

          const plots = item.plots?.plot || [];
          record.plot = plots.find(p => p.plotLang === "한국어")?.plotText
            || plots[0]?.plotText || "";

          const kwRaw = item.keywords || "";
          record.keywords = kwRaw ? kwRaw.split("|").map(k => k.trim()).filter(Boolean) : [];

          const rt = parseInt(item.runtime);
          if (!isNaN(rt)) record.runtime = rt;

          const actorList = item.actors?.actor || [];
          record.actors = actorList.slice(0, 8).map(a => a.actorNm).filter(Boolean);

          const stllsRaw = item.stlls || "";
          record.stills = stllsRaw ? stllsRaw.split("|").slice(0, 8).filter(Boolean) : [];
          break;
        }
      } catch {
        // KMDb 실패 시 KOFIC 데이터만 반환
      }

      return record;
    })
  );

  // total: 검색어 있을 때는 실제 결과 수, 없을 때는 KOFIC 원본 총계(페이지네이션용)
  const responseTotal = (q || director) ? results.length : total;
  res.json({ results, total: responseTotal, page: parseInt(page) });
}
