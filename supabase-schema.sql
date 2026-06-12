-- 꿈it 지도안 도구 — 참고자료(Drive 문서 본문) 저장 테이블
--
-- 사용법:
--   1) Supabase 프로젝트 생성 → 좌측 SQL Editor에 이 파일 내용을 붙여넣고 Run.
--   2) Project Settings → API 에서 다음을 확인:
--        - Project URL                → Vercel 환경변수 SUPABASE_URL
--        - service_role 키(secret)    → Vercel 환경변수 SUPABASE_SERVICE_KEY
--      (service_role 키는 절대 브라우저에 노출하지 말 것. 서버 함수에서만 사용.)
--   3) (선택) 쓰기 보호용 토큰을 쓰려면 Vercel 환경변수 REFERENCE_ADMIN_TOKEN 설정.

create extension if not exists pgcrypto;

create table if not exists reference_docs (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,                 -- 문서 제목(예: 꿈it(잇)다 수업 모형 안내)
  source      text not null default 'drive', -- 출처 메모(drive/직접입력 등)
  tags        text not null default '',       -- 쉼표 구분 태그(예: 수학,진로,평가)
  content     text not null,                 -- 문서 본문 텍스트(붙여넣기)
  created_at  timestamptz not null default now()
);

create index if not exists reference_docs_created_idx on reference_docs (created_at);

-- RLS 켜두되 공개 정책은 만들지 않는다.
-- 모든 읽기/쓰기는 service_role 키를 쓰는 서버 함수(/api/reference, /api/generate)로만 한다.
-- service_role 키는 RLS를 우회하므로 별도 정책 없이 동작한다.
alter table reference_docs enable row level security;
