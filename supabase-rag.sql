-- 꿈it 지도안 도구 — RAG(검색 기반) 참고자료 스키마 (pgvector)
--
-- 대용량 Drive 자료(교육과정 별책, 진로연계 자료집, 꿈it 매뉴얼 등)는 프롬프트에
-- 통째로 못 넣으므로, 잘게 나눈 청크(chunk)와 임베딩 벡터를 저장하고
-- 수업 주제와 가장 가까운 청크만 검색해 생성에 주입한다.
--
-- 적용: Supabase SQL Editor에 붙여넣고 Run. (supabase-schema.sql 먼저 실행해도 무방)
-- 임베딩 모델: OpenAI text-embedding-3-small (차원 1536)

create extension if not exists vector;

create table if not exists reference_chunks (
  id          bigint generated always as identity primary key,
  doc_title   text not null,                 -- 출처 문서 제목(파일명)
  source      text not null default 'drive',
  tags        text not null default '',
  chunk_index int  not null default 0,        -- 문서 내 청크 순번
  content     text not null,                 -- 청크 본문
  embedding   vector(1536),                  -- text-embedding-3-small
  created_at  timestamptz not null default now()
);

-- 코사인 유사도 검색용 HNSW 인덱스(데이터가 비어 있어도 생성 가능, 훈련 불필요).
create index if not exists reference_chunks_embedding_idx
  on reference_chunks using hnsw (embedding vector_cosine_ops);

create index if not exists reference_chunks_doc_idx on reference_chunks (doc_title);

alter table reference_chunks enable row level security;
-- (정책 없음: service_role 키를 쓰는 서버 함수/인제스트 스크립트만 접근. service_role은 RLS 우회.)

-- 질의 임베딩과 가장 가까운 청크를 돌려주는 RPC.
create or replace function match_reference_chunks(
  query_embedding vector(1536),
  match_count int default 8
)
returns table (
  content text,
  doc_title text,
  tags text,
  similarity float
)
language sql stable
as $$
  select
    content,
    doc_title,
    tags,
    1 - (embedding <=> query_embedding) as similarity
  from reference_chunks
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
