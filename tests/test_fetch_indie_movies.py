"""
오오극장 독립영화 파이프라인 단위 테스트

테스트 대상 함수:
  - parse_kofic()          : KOFIC 응답 항목 → 표준 구조 변환
  - fetch_kmdb()           : KMDb API 호출 + 연도 ±1 교차검증
  - fetch_kofic_movies()   : KOFIC 전 페이지 순회 수집
  - build_merged_records() : KOFIC + KMDb 병합
"""
from unittest.mock import MagicMock, patch

import pytest

import fetch_indie_movies as fim


# ──────────────────────────────────────────────────────
# 헬퍼
# ──────────────────────────────────────────────────────

def _kofic_raw(code="20261234", title="테스트 영화", director="홍길동", year="2026", status="미개봉"):
    return {
        "movieCd": code,
        "movieNm": title,
        "directors": [{"peopleNm": director}] if director else [],
        "prdtYear": year,
        "prdtStatNm": status,
    }


def _kmdb_item(prod_year="2026", posters="", plots=None, keywords="", runtime=""):
    return {
        "prodYear": prod_year,
        "posters": posters,
        "plots": {"plot": plots or []},
        "keywords": keywords,
        "runtime": runtime,
    }


def _kmdb_response(items):
    return {"Data": [{"Result": items}]}


def _mock_get(items, *, raise_for_status=None):
    m = MagicMock()
    m.json.return_value = _kmdb_response(items)
    m.raise_for_status = raise_for_status or MagicMock()
    return m


# ──────────────────────────────────────────────────────
# parse_kofic
# ──────────────────────────────────────────────────────

class TestParseKofic:
    def test_normal(self):
        result = fim.parse_kofic(_kofic_raw())
        assert result["id"]       == "20261234"
        assert result["title"]    == "테스트 영화"
        assert result["director"] == "홍길동"
        assert result["year"]     == "2026"
        assert result["status"]   == "미개봉"
        assert result["runtime"]  is None
        assert result["poster_url"] is None
        assert result["plot"]     is None
        assert result["keywords"] == []

    def test_title_stripped(self):
        raw = _kofic_raw(title="  공백영화  ")
        assert fim.parse_kofic(raw)["title"] == "공백영화"

    def test_empty_directors_list(self):
        raw = _kofic_raw(director="")
        assert fim.parse_kofic(raw)["director"] == ""

    def test_missing_directors_key(self):
        raw = {"movieCd": "20261111", "movieNm": "키없음", "prdtYear": "2026"}
        assert fim.parse_kofic(raw)["director"] == ""

    def test_all_fields_missing(self):
        result = fim.parse_kofic({})
        assert result["id"]    == ""
        assert result["title"] == ""
        assert result["year"]  == ""


# ──────────────────────────────────────────────────────
# fetch_kmdb
# ──────────────────────────────────────────────────────

class TestFetchKmdb:
    @patch("fetch_indie_movies.requests.get")
    def test_exact_year_match(self, mock_get):
        item = _kmdb_item(
            prod_year="2026",
            posters="http://poster.jpg|http://poster2.jpg",
            plots=[{"plotLang": "한국어", "plotText": "한국어 줄거리."}],
            keywords="독립|드라마",
            runtime="92",
        )
        mock_get.return_value = _mock_get([item])

        result = fim.fetch_kmdb("테스트", "홍길동", "2026")

        assert result is not None
        assert result["poster_url"] == "http://poster.jpg"   # 첫 번째 포스터만
        assert result["plot"]       == "한국어 줄거리."
        assert result["keywords"]   == ["독립", "드라마"]
        assert result["runtime"]    == 92

    @patch("fetch_indie_movies.requests.get")
    def test_year_plus_one_allowed(self, mock_get):
        mock_get.return_value = _mock_get([_kmdb_item("2025", runtime="80")])
        assert fim.fetch_kmdb("테스트", "홍길동", "2026") is not None

    @patch("fetch_indie_movies.requests.get")
    def test_year_minus_one_allowed(self, mock_get):
        mock_get.return_value = _mock_get([_kmdb_item("2027", runtime="80")])
        assert fim.fetch_kmdb("테스트", "홍길동", "2026") is not None

    @patch("fetch_indie_movies.requests.get")
    def test_year_gap_two_returns_none(self, mock_get):
        mock_get.return_value = _mock_get([_kmdb_item("2024", runtime="80")])
        assert fim.fetch_kmdb("테스트", "홍길동", "2026") is None

    @patch("fetch_indie_movies.requests.get")
    def test_non_digit_prod_year_skipped(self, mock_get):
        """prodYear가 숫자가 아닌 항목은 건너뛰고 다음 항목 검사."""
        items = [
            _kmdb_item("미상", runtime="70"),
            _kmdb_item("2026", runtime="85"),
        ]
        mock_get.return_value = _mock_get(items)
        result = fim.fetch_kmdb("테스트", "홍길동", "2026")
        assert result is not None
        assert result["runtime"] == 85

    @patch("fetch_indie_movies.requests.get")
    def test_non_digit_kofic_year_defaults_to_2026(self, mock_get):
        """KOFIC 연도가 숫자가 아니면 기본값 2026으로 비교."""
        mock_get.return_value = _mock_get([_kmdb_item("2026", runtime="75")])
        assert fim.fetch_kmdb("테스트", "홍길동", "알수없음") is not None

    @patch("fetch_indie_movies.requests.get")
    def test_empty_results_returns_none(self, mock_get):
        mock_get.return_value = _mock_get([])
        assert fim.fetch_kmdb("없는영화", "없는감독", "2026") is None

    @patch("fetch_indie_movies.requests.get")
    def test_request_exception_returns_none(self, mock_get):
        mock_get.side_effect = Exception("Connection error")
        assert fim.fetch_kmdb("테스트", "홍길동", "2026") is None

    @patch("fetch_indie_movies.requests.get")
    def test_no_posters_field(self, mock_get):
        mock_get.return_value = _mock_get([_kmdb_item("2026", posters="", runtime="60")])
        result = fim.fetch_kmdb("테스트", "홍길동", "2026")
        assert result["poster_url"] is None

    @patch("fetch_indie_movies.requests.get")
    def test_fallback_to_non_korean_plot(self, mock_get):
        """한국어 줄거리 없으면 첫 번째 항목 사용."""
        item = _kmdb_item(
            "2026",
            plots=[{"plotLang": "영어", "plotText": "English synopsis."}],
            runtime="88",
        )
        mock_get.return_value = _mock_get([item])
        result = fim.fetch_kmdb("테스트", "홍길동", "2026")
        assert result["plot"] == "English synopsis."

    @patch("fetch_indie_movies.requests.get")
    def test_non_digit_runtime_returns_none(self, mock_get):
        mock_get.return_value = _mock_get([_kmdb_item("2026", runtime="미상")])
        result = fim.fetch_kmdb("테스트", "홍길동", "2026")
        assert result["runtime"] is None

    @patch("fetch_indie_movies.requests.get")
    def test_keywords_empty_string_returns_empty_list(self, mock_get):
        mock_get.return_value = _mock_get([_kmdb_item("2026", keywords="", runtime="70")])
        result = fim.fetch_kmdb("테스트", "홍길동", "2026")
        assert result["keywords"] == []


# ──────────────────────────────────────────────────────
# fetch_kofic_movies
# ──────────────────────────────────────────────────────

def _kofic_page_response(items, total):
    return {"movieListResult": {"movieList": items, "totCnt": total}}


class TestFetchKoficMovies:
    @patch("fetch_indie_movies.time.sleep")
    @patch("fetch_indie_movies.requests.get")
    def test_single_page(self, mock_get, mock_sleep):
        movies = [{"movieCd": f"2026{i:04d}", "movieNm": f"영화{i}"} for i in range(3)]
        mock_get.return_value.json.return_value = _kofic_page_response(movies, 3)
        mock_get.return_value.raise_for_status = MagicMock()

        result = fim.fetch_kofic_movies()

        assert len(result) == 3
        mock_sleep.assert_not_called()  # 한 페이지 → sleep 없음

    @patch("fetch_indie_movies.time.sleep")
    @patch("fetch_indie_movies.requests.get")
    def test_multi_page_pagination(self, mock_get, mock_sleep):
        page1 = [{"movieCd": f"2026{i:04d}", "movieNm": f"영화{i}"} for i in range(3)]
        page2 = [{"movieCd": f"2026{i:04d}", "movieNm": f"영화{i}"} for i in range(3, 5)]

        mock_get.return_value.raise_for_status = MagicMock()
        mock_get.return_value.json.side_effect = [
            _kofic_page_response(page1, 5),
            _kofic_page_response(page2, 5),
        ]

        result = fim.fetch_kofic_movies(page_size=3)

        assert len(result) == 5
        mock_sleep.assert_called_once_with(0.3)

    @patch("fetch_indie_movies.requests.get")
    def test_api_exception_returns_empty(self, mock_get):
        mock_get.side_effect = Exception("Timeout")
        assert fim.fetch_kofic_movies() == []

    @patch("fetch_indie_movies.time.sleep")
    @patch("fetch_indie_movies.requests.get")
    def test_empty_movie_list_stops_pagination(self, mock_get, mock_sleep):
        mock_get.return_value.json.return_value = _kofic_page_response([], 0)
        mock_get.return_value.raise_for_status = MagicMock()

        result = fim.fetch_kofic_movies()
        assert result == []


# ──────────────────────────────────────────────────────
# build_merged_records
# ──────────────────────────────────────────────────────

class TestBuildMergedRecords:
    @patch("fetch_indie_movies.time.sleep")
    @patch("fetch_indie_movies.fetch_kmdb")
    def test_kmdb_match_merges_all_fields(self, mock_kmdb, mock_sleep):
        mock_kmdb.return_value = {
            "poster_url": "http://poster.jpg",
            "plot": "줄거리",
            "keywords": ["독립", "전주"],
            "runtime": 95,
        }
        records = fim.build_merged_records([_kofic_raw()])

        assert len(records) == 1
        r = records[0]
        assert r["poster_url"] == "http://poster.jpg"
        assert r["plot"]       == "줄거리"
        assert r["keywords"]   == ["독립", "전주"]
        assert r["runtime"]    == 95

    @patch("fetch_indie_movies.time.sleep")
    @patch("fetch_indie_movies.fetch_kmdb")
    def test_kmdb_no_match_leaves_nulls(self, mock_kmdb, mock_sleep):
        mock_kmdb.return_value = None
        records = fim.build_merged_records([_kofic_raw(code="20265678", title="매칭안됨")])

        assert len(records) == 1
        r = records[0]
        assert r["poster_url"] is None
        assert r["plot"]       is None
        assert r["keywords"]   == []

    @patch("fetch_indie_movies.time.sleep")
    @patch("fetch_indie_movies.fetch_kmdb")
    def test_skip_empty_id(self, mock_kmdb, mock_sleep):
        raw = {"movieCd": "", "movieNm": "빈ID", "directors": [], "prdtYear": "2026", "prdtStatNm": ""}
        assert fim.build_merged_records([raw]) == []
        mock_kmdb.assert_not_called()

    @patch("fetch_indie_movies.time.sleep")
    @patch("fetch_indie_movies.fetch_kmdb")
    def test_skip_empty_title(self, mock_kmdb, mock_sleep):
        raw = {"movieCd": "20261111", "movieNm": "", "directors": [], "prdtYear": "2026", "prdtStatNm": ""}
        assert fim.build_merged_records([raw]) == []
        mock_kmdb.assert_not_called()

    @patch("fetch_indie_movies.time.sleep")
    @patch("fetch_indie_movies.fetch_kmdb")
    def test_kmdb_runtime_none_not_overwritten(self, mock_kmdb, mock_sleep):
        """KMDb runtime이 None이면 기존 None 유지 (0으로 덮어쓰지 않음)."""
        mock_kmdb.return_value = {"poster_url": None, "plot": None, "keywords": [], "runtime": None}
        records = fim.build_merged_records([_kofic_raw()])
        assert records[0]["runtime"] is None

    @patch("fetch_indie_movies.time.sleep")
    @patch("fetch_indie_movies.fetch_kmdb")
    def test_sleep_called_per_record(self, mock_kmdb, mock_sleep):
        mock_kmdb.return_value = None
        fim.build_merged_records([_kofic_raw("20261001", "영화A"), _kofic_raw("20261002", "영화B")])
        assert mock_sleep.call_count == 2
        mock_sleep.assert_called_with(0.2)

    @patch("fetch_indie_movies.time.sleep")
    @patch("fetch_indie_movies.fetch_kmdb")
    def test_multiple_records_all_processed(self, mock_kmdb, mock_sleep):
        mock_kmdb.side_effect = [
            {"poster_url": "http://a.jpg", "plot": "A줄거리", "keywords": [], "runtime": 80},
            None,
        ]
        raws = [_kofic_raw("20261001", "영화A"), _kofic_raw("20261002", "영화B")]
        records = fim.build_merged_records(raws)

        assert len(records) == 2
        assert records[0]["poster_url"] == "http://a.jpg"
        assert records[1]["poster_url"] is None
