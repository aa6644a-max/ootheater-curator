"""
테스트 실행 전 환경변수 및 경로 설정.
fetch_indie_movies.py는 모듈 임포트 시점에 os.environ 값을 읽으므로
conftest.py에서 미리 더미값을 주입한다.
supabase 패키지는 설치 없이 mock으로 대체한다.
"""
import os
import sys
from unittest.mock import MagicMock

# 환경변수 주입 (모듈 임포트 전)
os.environ.setdefault("KOFIC_API_KEY", "test_kofic_key")
os.environ.setdefault("KMDB_API_KEY",  "test_kmdb_key")
os.environ.setdefault("SUPABASE_URL",  "https://test.supabase.co")
os.environ.setdefault("SUPABASE_KEY",  "test_service_role_key")

# 루트 디렉토리를 모듈 검색 경로에 추가
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# supabase 패키지를 mock으로 대체 (테스트 환경에서 설치 불필요)
supabase_mock = MagicMock()
supabase_mock.create_client = MagicMock()
sys.modules.setdefault("supabase", supabase_mock)
