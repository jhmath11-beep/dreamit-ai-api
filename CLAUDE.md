# dreamit-ai-api

metan-portal의 꿈it 지도안 도구(`dreamit_final_output.html`)가 호출하는 **독립형 OpenAI 중계 API**.
OpenAI 키를 브라우저에 노출하지 않고 이 프로젝트 환경변수에 보관한 채 GPT를 호출한다.
Vercel 서버리스 함수(Node ≥18, 무빌드·무의존성). git repo: `jhmath11-beep/dreamit-ai-api`.

## 구조
- `sources-data.js` — **자료실(STEP 2) 4개 항목의 실제 본문**(modelGuide/lessonSamples/careerGuide/rubric, 약 1.5만 자).
  `window.sourceDocs`에 붙이며 index.html의 `selectedSourceDocs()`가 체크된 항목만 AI 요청문에 통째로 주입한다.
  Supabase·벡터검색을 안 거치므로 체크한 자료는 항상 100% 들어간다. 내용 수정은 이 파일만 고치면 된다.
  본문 중 '초안' 표시 부분(수업 모형 5종, 진로교육 요소 10개 정의)은 학교 확정본으로 교체 필요.
- `api/generate.js` — 핵심. `POST /api/generate` {system, user} → 연구학교 양식 각 칸 JSON.
  Google ID 토큰 로그인 검증 → (선택) Supabase 참고자료 주입 → OpenAI 호출.
- `api/reference.js` — `GET/POST/DELETE /api/reference`. Drive 문서 본문을 Supabase `reference_docs`에 저장/조회.
- `scripts/ingest.py` — 로컬 실행 RAG 인제스트(공개 Drive PDF/DOCX → 청크 → 임베딩 → pgvector `reference_chunks`). `scripts/README.md` 참고.
- `supabase-schema.sql`(붙여넣기 테이블), `supabase-rag.sql`(pgvector + `match_reference_chunks` 함수).
- `guide/dreamit-guide.pdf` — 도구 사용 안내서(제목 옆 도움말 버튼의 PDF 모달에서 사용).

## AI 모델
- 실제 호출은 **OpenAI gpt-4o-mini**(사용자 OpenAI 키). Claude 아님.
- 모델은 `OPENAI_MODEL` 환경변수로 지정. 코드 기본값은 `gpt-4o`이며 배포본은 mini로 override됨.
- 응답은 `response_format: json_schema`(strict)로 `LESSON_SCHEMA` 강제. 임베딩은 `text-embedding-3-small`.

## 배포
- Vercel 프로젝트 `dreamit-ai-api`(`.vercel/project.json` 연동). 함수 주소 `https://dreamit-ai-api.vercel.app/api/generate`.
- **`git push origin main` 하면 자동 배포된다**(2026-08-21 확인: 푸시 직후 반영). Vercel CLI는 안 깔려 있어도 됨.
- 환경변수(값 절대 읽지 말 것): `OPENAI_API_KEY`(필수), `OPENAI_MODEL`(선택),
  `GOOGLE_CLIENT_ID`(필수·로그인), `ALLOWED_EMAIL_DOMAINS`(기본 goedu.kr), `ALLOWED_EMAILS`,
  `SUPABASE_URL`·`SUPABASE_SERVICE_KEY`(참고자료 기능), `REFERENCE_ADMIN_TOKEN`(선택).
- Supabase 미설정 시 참고자료 주입은 조용히 생략되고 기본 동작 유지. CORS는 `*` 전체 허용.
- **(2026-08-21 확인) 기존 Supabase 프로젝트는 삭제됨** — `opnsbprcskfwilqjtfgz.supabase.co` DNS NXDOMAIN,
  `/api/reference`는 `{"error":"fetch failed"}`. 즉 Drive RAG(2271청크) 주입은 현재 0건이고 조용히 생략된다.
  지도안 근거는 `sources-data.js`(자료실 4개)가 담당한다. RAG를 되살리려면 Supabase 새 프로젝트 →
  `supabase-schema.sql`+`supabase-rag.sql` Run → Vercel 환경변수 재설정 → `python scripts/ingest.py --reset`.

## 주의
- service_role 키·OpenAI 키는 서버 전용. 브라우저 노출 금지. `scripts/.env`는 커밋 금지(.gitignore).
- HTML 쪽 엔드포인트 상수(`AI_ENDPOINT`)는 metan-portal에 있음. 호출 실패 시 HTML은 시뮬레이션으로 폴백.
