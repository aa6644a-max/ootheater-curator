/**
 * 오오극장 독립영화 — Supabase Edge Function
 *
 * 용도: HTTP 트리거로 단일 영화 또는 소규모 배치 갱신
 *      (전체 배치는 .github/workflows/fetch.yml 사용)
 *
 * 배포:
 *   supabase functions deploy fetch-movies --no-verify-jwt
 *
 * 호출 예시:
 *   # 최신 20편 갱신 (기본)
 *   POST https://[ref].supabase.co/functions/v1/fetch-movies
 *   {}
 *
 *   # 특정 영화 갱신 (movieCd 지정)
 *   POST https://[ref].supabase.co/functions/v1/fetch-movies
 *   { "movieCd": "20261234" }
 *
 *   # 처리 편수 조정 (최대 50편 권장 — 타임아웃 주의)
 *   POST https://[ref].supabase.co/functions/v1/fetch-movies
 *   { "maxMovies": 30 }
 *
 * 필요 Secrets (supabase secrets set 으로 등록):
 *   KOFIC_API_KEY, KMDB_API_KEY
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 는 Edge Function에 자동 주입됨
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const KOFIC_BASE =
  "https://www.kobis.or.kr/kobisopenapi/webservice/rest/movie/searchMovieList.json";
const KMDB_BASE =
  "https://api.koreafilm.or.kr/openapi-data2/wisenut/search_api/search_json2.jsp";
const TABLE = "indie_movies_2026";

// ── 타입 ────────────────────────────────────────

interface KoficRaw {
  movieCd: string;
  movieNm: string;
  directors: { peopleNm: string }[];
  prdtYear: string;
  prdtStatNm: string;
}

interface MovieRecord {
  id: string;
  title: string;
  director: string;
  year: string;
  runtime: number | null;
  status: string;
  poster_url: string | null;
  plot: string | null;
  keywords: string[];
}

// ── KOFIC 파싱 ──────────────────────────────────

function parseKofic(raw: KoficRaw): MovieRecord {
  return {
    id:         raw.movieCd ?? "",
    title:      (raw.movieNm ?? "").trim(),
    director:   raw.directors?.[0]?.peopleNm?.trim() ?? "",
    year:       raw.prdtYear ?? "",
    runtime:    null,
    status:     raw.prdtStatNm ?? "",
    poster_url: null,
    plot:       null,
    keywords:   [],
  };
}

// ── KOFIC API 호출 ──────────────────────────────

async function fetchKoficPage(
  page: number,
  pageSize: number,
): Promise<{ movies: KoficRaw[]; total: number }> {
  const params = new URLSearchParams({
    key:           Deno.env.get("KOFIC_API_KEY") ?? "",
    curPage:       String(page),
    itemPerPage:   String(pageSize),
    prdtStartYear: "2025",
    prdtEndYear:   "2026",
    movieTypeCd:   "204104",
  });

  const res = await fetch(`${KOFIC_BASE}?${params}`);
  if (!res.ok) throw new Error(`KOFIC HTTP ${res.status}`);

  const data = await res.json();
  const result = data?.movieListResult ?? {};
  return {
    movies: result.movieList ?? [],
    total:  parseInt(result.totCnt ?? "0"),
  };
}

// ── KMDb API 호출 + 교차검증 ────────────────────

async function fetchKmdb(
  title: string,
  director: string,
  koficYear: string,
): Promise<Partial<MovieRecord> | null> {
  const targetYear = /^\d+$/.test(koficYear) ? parseInt(koficYear) : 2026;

  const params = new URLSearchParams({
    ServiceKey: Deno.env.get("KMDB_API_KEY") ?? "",
    title,
    director,
    startCount: "0",
    listCount:  "5",
    detail:     "Y",
    collection: "kmdb_new2",
  });

  try {
    const res = await fetch(`${KMDB_BASE}?${params}`);
    if (!res.ok) return null;

    const data = await res.json();
    const results: Record<string, unknown>[] = data?.Data?.[0]?.Result ?? [];

    for (const item of results) {
      const prodYearStr = String(item.prodYear ?? "");
      if (!/^\d+$/.test(prodYearStr)) continue;
      if (Math.abs(parseInt(prodYearStr) - targetYear) > 1) continue;

      const postersRaw = String(item.posters ?? "");
      const poster_url = postersRaw ? postersRaw.split("|")[0] : null;

      type PlotEntry = { plotLang: string; plotText: string };
      const plots: PlotEntry[] = (item.plots as { plot: PlotEntry[] })?.plot ?? [];
      const plot =
        plots.find((p) => p.plotLang === "한국어")?.plotText ??
        plots[0]?.plotText ??
        "";

      const kwRaw = String(item.keywords ?? "");
      const keywords = kwRaw
        ? kwRaw.split("|").map((k) => k.trim()).filter(Boolean)
        : [];

      const runtimeStr = String(item.runtime ?? "");
      const runtime = /^\d+$/.test(runtimeStr) ? parseInt(runtimeStr) : null;

      return { poster_url, plot, keywords, runtime };
    }
  } catch {
    // 요청 실패 — null 반환으로 KOFIC 데이터만 적재
  }
  return null;
}

// ── 병합 ────────────────────────────────────────

async function buildRecords(rawList: KoficRaw[]): Promise<MovieRecord[]> {
  const records: MovieRecord[] = [];

  for (const raw of rawList) {
    const record = parseKofic(raw);
    if (!record.id || !record.title) continue;

    const kmdb = await fetchKmdb(record.title, record.director, record.year);
    if (kmdb) {
      record.poster_url = kmdb.poster_url ?? null;
      record.plot       = kmdb.plot ?? null;
      record.keywords   = kmdb.keywords ?? [];
      if (kmdb.runtime != null) record.runtime = kmdb.runtime;
    }

    records.push(record);
    await new Promise((r) => setTimeout(r, 200)); // KMDb 부하 방지
  }

  return records;
}

// ── 엔트리포인트 ─────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "POST 요청만 허용됩니다." }, { status: 405 });
  }

  const body: { movieCd?: string; maxMovies?: number } =
    await req.json().catch(() => ({}));

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let targetMovies: KoficRaw[] = [];

  if (body.movieCd) {
    // 특정 영화만 갱신
    const { movies } = await fetchKoficPage(1, 100);
    const found = movies.find((m) => m.movieCd === body.movieCd);
    if (!found) {
      return Response.json(
        { error: `movieCd ${body.movieCd}를 찾지 못했습니다.` },
        { status: 404 },
      );
    }
    targetMovies = [found];
  } else {
    // 소규모 배치 (기본 20편, 최대 50편 권장)
    const maxMovies = Math.min(body.maxMovies ?? 20, 50);
    const { movies } = await fetchKoficPage(1, maxMovies);
    targetMovies = movies.slice(0, maxMovies);
  }

  const records = await buildRecords(targetMovies);

  if (records.length === 0) {
    return Response.json({ message: "처리할 레코드가 없습니다.", processed: 0 });
  }

  const { error } = await supabase
    .from(TABLE)
    .upsert(records, { onConflict: "id" });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({
    message: `${records.length}편 처리 완료`,
    processed: records.length,
  });
});
