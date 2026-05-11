# 오오극장 독립영화 기획전 큐레이션 대시보드 — Claude Code 작업 지침

이 문서는 Claude Code가 본 프로젝트의 맥락을 완전히 이해하고 작업을 수행하기 위한 마스터 지침이다.
작업 시작 전 반드시 이 파일 전체를 숙지할 것.

---

## 1. 프로젝트 개요

| 항목 | 내용 |
|------|------|
| 프로젝트명 | 오오극장 독립영화 기획전 큐레이션 대시보드 |
| 목적 | 대구 독립영화관 '오오극장'의 2026년 기획전 상영작 발굴 및 선별을 위한 사내 회의용 웹 도구 |
| 핵심 문제 | 독립영화는 정보가 파편화되어 있어 단일 출처로는 신뢰도 낮음 → 2개 공공 API 교차검증으로 해결 |

---

## 2. 기술 스택

```
Data Pipeline  : Python 3.11+ (requests, python-dotenv, supabase-py)
Database       : Supabase (PostgreSQL) — 테이블명: indie_movies_2026
Frontend       : Vanilla HTML / CSS / JS (단일 파일, 프레임워크 없음)
Automation     : GitHub Actions (Python 스크립트 주기 실행)
Deploy         : Vercel (HTML 정적 배포)
```

---

## 3. 디렉토리 구조 (목표 상태)

```
/
├── CLAUDE.md                  ← 이 파일
├── .env                       ← 로컬 환경변수 (절대 커밋 금지)
├── .env.example               ← 환경변수 템플릿
├── .gitignore
│
├── pipeline/
│   └── fetch_indie_movies.py  ← KOFIC + KMDb 교차검증 및 Supabase 적재 스크립트
│
├── frontend/
│   └── dashboard.html         ← 큐레이션 대시보드 (단일 HTML)
│
└── .github/
    └── workflows/
        └── fetch.yml          ← GitHub Actions 자동화 워크플로우
```

---

## 4. 환경변수 목록

`.env` 파일 또는 GitHub Actions Secrets / Vercel Environment Variables에 설정.

```
KOFIC_API_KEY      영화진흥위원회 오픈API 인증키
KMDB_API_KEY       한국영화데이터베이스 오픈API 인증키
SUPABASE_URL       https://[project-ref].supabase.co
SUPABASE_KEY       Supabase service_role 키 (pipeline 전용, 클라이언트 노출 금지)
SUPABASE_ANON_KEY  Supabase anon 키 (dashboard.html 프론트엔드 전용)
```

> **보안 원칙**: `SUPABASE_KEY`(service_role)는 절대 프론트엔드 코드에 포함하지 말 것.
> 프론트엔드는 `SUPABASE_ANON_KEY`만 사용하고, Supabase 대시보드에서 RLS 읽기 정책을 반드시 활성화할 것.

---

## 5. Supabase 스키마

테이블명: `indie_movies_2026`

```sql
create table indie_movies_2026 (
  id          text primary key,        -- KOFIC movieCd (예: "20261234")
  title       text not null,           -- 영화 제목
  director    text,                    -- 감독 이름
  year        text,                    -- 제작연도 (문자열)
  runtime     integer,                 -- 상영시간(분), 단편 기준 40분
  status      text,                    -- 개봉 상태 (미개봉, 제작완료, 개봉준비 등)
  poster_url  text,                    -- KMDb 포스터 이미지 URL
  plot        text,                    -- 시놉시스
  keywords    text[],                  -- 키워드 배열 (영화제명, 주제어 등)
  created_at  timestamptz default now()
);

-- RLS 읽기 정책 (anon 허용)
alter table indie_movies_2026 enable row level security;
create policy "public read" on indie_movies_2026
  for select using (true);
```

---

## 6. 핵심 비즈니스 로직: 2-API 교차검증

독립영화는 동명이작이 많아 제목 단독 검색은 오판 위험이 높다. 반드시 아래 순서를 지킬 것.

```
Step 1. KOFIC API 호출
        파라미터: prdtStartYear=2025, prdtEndYear=2026, movieTypeCd=204104
        획득: movieCd(PK), movieNm(제목), directors(감독), prdtStatNm(상태), prdtYear(연도)

Step 2. KMDb API 호출 (Step 1 결과를 입력으로 사용)
        파라미터: title={영화제목}, director={감독명}, detail=Y
        획득: posters, plots, keywords, runtime

Step 3. 교차검증 (연도 ±1년 허용)
        KMDb 결과의 prodYear와 KOFIC의 prdtYear 차이가 1 이하일 때만 병합
        → 일치 시: poster_url, plot, keywords, runtime을 KOFIC 레코드에 병합
        → 불일치 시: KMDb 필드 null 상태로 KOFIC 데이터만 적재

Step 4. Supabase upsert
        PK(id = movieCd) 기준 중복 시 update, 신규 시 insert
        50건씩 청크 전송
```

---

## 7. 프론트엔드 필수 기능 명세

`dashboard.html`이 반드시 구현해야 하는 기능 목록.

### 퀵 필터 버튼 (data-filter 속성 기준)

| data-filter | 필터 조건 |
|-------------|----------|
| `all` | 전체 표시 |
| `jeonju` | `keywords` 배열에 "전주" 포함 |
| `unreleased` | `status`에 "미개봉" 또는 "제작완료" 또는 "개봉준비" 포함 |
| `short` | `runtime < 40` (단편) |
| `feature` | `runtime >= 40` (장편) |
| `noposter` | `poster_url` 값 없음 |

### 통합 검색

검색 대상 필드: `title`, `director`, `plot`, `keywords` (모두 소문자 변환 후 부분 일치)
디바운스: 200ms

### 카드 뱃지 색상 규칙

- 골드(`--accent`) : 기본 상태 뱃지, 키워드 태그
- 블루(`--accent2`) : 전주 뱃지
- 레드(`--danger`) : 미개봉 / 제작완료 뱃지

---

## 8. 코딩 컨벤션

- **Python**: 함수 단위 모듈화, 타입 힌트 사용, `log.info/warning/error`로 진행상황 출력
- **API 요청**: KOFIC 호출 간 0.3초, KMDb 호출 간 0.2초 sleep (서버 부하 방지)
- **HTML/JS**: 외부 라이브러리·프레임워크 사용 금지 (Vanilla JS 유지), SDK 없이 `fetch` 직접 호출
- **보안**: `.env` 파일은 `.gitignore`에 포함, service_role 키는 서버사이드 전용
- **에러 처리**: 모든 API 호출은 try/except로 감싸고, 실패 시 해당 항목 skip 후 계속 진행

---

## 9. 현재 완성된 파일

| 파일 | 상태 | 설명 |
|------|------|------|
| `fetch_indie_movies.py` | ✅ 완성 | KOFIC+KMDb 교차검증, Supabase upsert |
| `dashboard.html` | ✅ 완성 | 다크모드 카드 그리드, 검색·필터·모달·즐겨찾기·CSV |
| `.github/workflows/fetch.yml` | ✅ 완성 | GitHub Actions 주 1회 cron (월 11:00 KST) |
| `.env.example` | ✅ 완성 | 환경변수 템플릿 (5개 키) |
| `requirements.txt` | ✅ 완성 | Python 의존성 (requests, python-dotenv, supabase) |
| `requirements-dev.txt` | ✅ 완성 | 개발 의존성 (pytest) |
| `.gitignore` | ✅ 완성 | .env 등 커밋 제외 목록 |
| `pytest.ini` | ✅ 완성 | pytest 설정 |
| `tests/conftest.py` | ✅ 완성 | 테스트 환경 설정 (env 주입, supabase mock) |
| `tests/test_fetch_indie_movies.py` | ✅ 완성 | 단위 테스트 28개 (전체 통과) |
| `supabase/functions/fetch-movies/index.ts` | ✅ 완성 | Edge Function (HTTP 트리거, 단일/소규모 배치) |

---

## 10. 다음 작업 후보

모든 초기 우선순위 작업 완료. 추가 개선 후보:

- Supabase Edge Function Secrets 등록: `supabase secrets set KOFIC_API_KEY=... KMDB_API_KEY=...`
- Edge Function 배포: `supabase functions deploy fetch-movies --no-verify-jwt`
- dashboard.html: Vercel 환경변수 연동 (SUPABASE_URL / SUPABASE_ANON_KEY 하드코딩 제거)
- 테스트 GitHub Actions 연동 (PR 시 자동 테스트)

---

## 11. 참고 API 엔드포인트

```
KOFIC 영화목록 조회
GET https://www.kobis.or.kr/kobisopenapi/webservice/rest/movie/searchMovieList.json
  ?key=KEY&curPage=1&itemPerPage=100&prdtStartYear=2025&prdtEndYear=2026&movieTypeCd=204104

KMDb 영화 상세 검색
GET https://api.koreafilm.or.kr/openapi-data2/wisenut/search_api/search_json2.jsp
  ?ServiceKey=KEY&title=제목&director=감독&startCount=0&listCount=5&detail=Y&collection=kmdb_new2

Supabase REST (프론트엔드 읽기)
GET https://[ref].supabase.co/rest/v1/indie_movies_2026?select=*&order=title.asc
Headers: apikey: ANON_KEY, Authorization: Bearer ANON_KEY
```
