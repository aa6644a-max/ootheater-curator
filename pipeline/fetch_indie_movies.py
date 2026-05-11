"""
오오극장 독립영화 기획전 데이터 수집 스크립트
KOFIC + KMDb 교차검증 → Supabase 적재

필요 환경변수 (.env 또는 GitHub Actions Secrets):
    KOFIC_API_KEY     : 영화진흥위원회 API 인증키
    KMDB_API_KEY      : 한국영화데이터베이스 API 인증키
    SUPABASE_URL      : Supabase 프로젝트 URL
    SUPABASE_KEY      : Supabase service_role 키 (anon 키 사용 금지)
"""

import os
import json
import time
import logging
import requests
from dotenv import load_dotenv

# ──────────────────────────────────────────────
# 0. 기본 설정
# ──────────────────────────────────────────────
load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

KOFIC_KEY     = os.environ["KOFIC_API_KEY"]
KMDB_KEY      = os.environ["KMDB_API_KEY"]
SUPABASE_URL  = os.environ["SUPABASE_URL"]
SUPABASE_KEY  = os.environ["SUPABASE_KEY"]

KOFIC_BASE = "https://www.kobis.or.kr/kobisopenapi/webservice/rest/movie/searchMovieList.json"
KMDB_BASE  = "https://api.koreafilm.or.kr/openapi-data2/wisenut/search_api/search_json2.jsp"

TABLE_NAME = "indie_movies_2026"

# 제작연도 범위 (2025년 완성작도 2026년 기획전 대상)
PROD_START_YEAR = "2025"
PROD_END_YEAR   = "2026"

# ──────────────────────────────────────────────
# 1. KOFIC API — 뼈대 데이터 수집
# ──────────────────────────────────────────────

def fetch_kofic_movies(page_size: int = 100) -> list[dict]:
    """KOFIC에서 독립영화 목록을 전체 페이지 순회하며 수집."""
    movies, cur_page = [], 1

    while True:
        params = {
            "key":           KOFIC_KEY,
            "curPage":       cur_page,
            "itemPerPage":   page_size,
            "prdtStartYear": PROD_START_YEAR,
            "prdtEndYear":   PROD_END_YEAR,
            "movieTypeCd":   "204104",   # 독립영화 유형 코드
        }
        try:
            res = requests.get(KOFIC_BASE, params=params, timeout=10)
            res.raise_for_status()
            data = res.json().get("movieListResult", {})
        except Exception as e:
            log.error("KOFIC 요청 실패 (page %d): %s", cur_page, e)
            break

        items = data.get("movieList", [])
        total = int(data.get("totCnt", 0))
        # 한국 영화만 필터링
        korean = [m for m in items if m.get("repNationNm") == "한국"]
        movies.extend(korean)
        log.info("KOFIC page %d — 한국 %d건 / 페이지 %d건 / 전체 %d", cur_page, len(korean), len(items), total)

        if cur_page * page_size >= total or not items:
            break
        cur_page += 1
        time.sleep(0.3)   # API 요청 부하 방지

    return movies


def parse_kofic(raw: dict) -> dict:
    """KOFIC 응답 항목을 표준 구조로 변환."""
    directors = raw.get("directors", [])
    director_nm = directors[0].get("peopleNm", "") if directors else ""

    return {
        "id":       raw.get("movieCd", ""),          # PK
        "title":    raw.get("movieNm", "").strip(),
        "director": director_nm.strip(),
        "year":     raw.get("prdtYear", ""),
        "runtime":  None,                             # KMDb에서 채움
        "status":   raw.get("prdtStatNm", ""),
        "poster_url": None,
        "plot":     None,
        "keywords": [],
    }


# ──────────────────────────────────────────────
# 2. KMDb API — 살점 데이터(포스터·줄거리·키워드) 수집
# ──────────────────────────────────────────────

def fetch_kmdb(title: str, director: str, kofic_year: str) -> dict | None:
    """
    KMDb에서 제목 + 감독으로 검색 후 제작연도 ±1년 교차검증.
    매칭되는 첫 번째 항목의 포스터·줄거리·키워드를 반환.
    """
    params = {
        "ServiceKey": KMDB_KEY,
        "title":      title,
        "director":   director,
        "startCount": 0,
        "listCount":  5,
        "detail":     "Y",
        "collection": "kmdb_new2",
    }
    try:
        res = requests.get(KMDB_BASE, params=params, timeout=10)
        res.raise_for_status()
        result = res.json().get("Data", [{}])[0].get("Result", [])
    except Exception as e:
        log.warning("KMDb 요청 실패 (%s / %s): %s", title, director, e)
        return None

    target_year = int(kofic_year) if kofic_year.isdigit() else 2026

    for item in result:
        prod_year_str = item.get("prodYear", "")
        if not prod_year_str.isdigit():
            continue
        prod_year = int(prod_year_str)

        # ── 교차검증: 제작연도 ±1년 허용 ──
        if abs(prod_year - target_year) > 1:
            continue

        # 포스터 URL (첫 번째만)
        posters_raw = item.get("posters", "")
        poster_url  = posters_raw.split("|")[0] if posters_raw else None

        # 줄거리 (한국어 우선)
        plots = item.get("plots", {}).get("plot", [])
        plot_text = ""
        for p in plots:
            if p.get("plotLang") == "한국어":
                plot_text = p.get("plotText", "")
                break
        if not plot_text and plots:
            plot_text = plots[0].get("plotText", "")

        # 키워드 (파이프 구분 → 배열)
        keywords_raw = item.get("keywords", "")
        keywords = [k.strip() for k in keywords_raw.split("|") if k.strip()] if keywords_raw else []

        # 상영시간
        runtime_str = item.get("runtime", "")
        runtime = int(runtime_str) if runtime_str.isdigit() else None

        return {
            "poster_url": poster_url,
            "plot":       plot_text,
            "keywords":   keywords,
            "runtime":    runtime,
        }

    return None   # 매칭 실패


# ──────────────────────────────────────────────
# 3. 데이터 병합
# ──────────────────────────────────────────────

def build_merged_records(kofic_list: list[dict]) -> list[dict]:
    """KOFIC 목록 전체에 KMDb 데이터를 병합하여 최종 레코드 생성."""
    merged, success, fail = [], 0, 0

    for raw in kofic_list:
        record = parse_kofic(raw)

        if not record["title"] or not record["id"]:
            continue

        log.info("처리 중: [%s] %s / %s", record["id"], record["title"], record["director"])
        kmdb_data = fetch_kmdb(record["title"], record["director"], record["year"])

        if kmdb_data:
            record["poster_url"] = kmdb_data["poster_url"]
            record["plot"]       = kmdb_data["plot"]
            record["keywords"]   = kmdb_data["keywords"]
            if kmdb_data["runtime"] is not None:
                record["runtime"] = kmdb_data["runtime"]
            success += 1
        else:
            log.warning("KMDb 매칭 실패: %s (%s)", record["title"], record["director"])
            fail += 1

        merged.append(record)
        time.sleep(0.2)   # KMDb 요청 부하 방지

    log.info("병합 완료 — 성공 %d / 실패 %d / 전체 %d", success, fail, len(merged))
    return merged


# ──────────────────────────────────────────────
# 4. Supabase 적재 (Upsert)
# ──────────────────────────────────────────────

def upsert_to_supabase(records: list[dict]) -> None:
    """레코드 목록을 Supabase REST API로 upsert. SDK 대신 requests 사용."""
    url = f"{SUPABASE_URL}/rest/v1/{TABLE_NAME}"
    headers = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",
    }

    chunk_size = 50
    for i in range(0, len(records), chunk_size):
        chunk = records[i : i + chunk_size]
        try:
            res = requests.post(url, headers=headers, data=json.dumps(chunk), timeout=30)
            res.raise_for_status()
            log.info("Supabase upsert — chunk %d~%d 완료", i, i + len(chunk) - 1)
        except Exception as e:
            log.error("Supabase upsert 실패 (chunk %d): %s", i, e)


# ──────────────────────────────────────────────
# 5. 진입점
# ──────────────────────────────────────────────

def main():
    log.info("=== 오오극장 독립영화 데이터 수집 시작 ===")

    # Step 1: KOFIC 수집
    log.info("[1/3] KOFIC 독립영화 목록 수집")
    kofic_list = fetch_kofic_movies()
    log.info("KOFIC 총 %d편 수집 완료", len(kofic_list))

    if not kofic_list:
        log.error("KOFIC 데이터 없음. 스크립트 종료.")
        return

    # Step 2: KMDb 교차검증 + 병합
    log.info("[2/3] KMDb 교차검증 및 데이터 병합")
    records = build_merged_records(kofic_list)

    # Step 3: Supabase 적재
    log.info("[3/3] Supabase 적재")
    upsert_to_supabase(records)

    log.info("=== 완료: 총 %d편 처리 ===", len(records))


if __name__ == "__main__":
    main()
