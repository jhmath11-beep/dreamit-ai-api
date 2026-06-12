# 참고자료 RAG 인제스트 (로컬 실행)

공개 Google Drive 폴더의 PDF/DOCX를 내려받아 텍스트 추출 → 청크 분할 → OpenAI 임베딩 →
Supabase `reference_chunks` 에 적재합니다. 그러면 'AI 수업 추천' 생성 시 서버가 수업 주제로
**벡터 검색해 관련 부분만** 프롬프트에 넣습니다(RAG).

> 이 스크립트는 **본인 컴퓨터에서** 실행합니다. 키는 환경변수로만 읽으며 외부로 보내지 않습니다.
> service_role 키를 누구(저 포함)에게도 줄 필요가 없습니다.

## 1) 선행: Supabase 준비
Supabase SQL Editor에서 순서대로 Run:
1. `../supabase-schema.sql` (참고자료 붙여넣기 테이블)
2. `../supabase-rag.sql`   (pgvector 청크 테이블 + 검색 함수)

## 2) 의존성 설치
```
pip install -r requirements.txt
```

## 3) 키 설정
`scripts/.env` 파일을 만들고(또는 셸 환경변수로):
```
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...(service_role)
```
> `.env` 는 커밋 금지(.gitignore 에 등록됨).

## 4) 실행
```
# 먼저 1개 파일로 점검
python ingest.py --limit 1

# 전체 적재(처음엔 --reset 으로 깨끗이)
python ingest.py --reset

# 다른 폴더
python ingest.py --folder <FOLDER_ID>
```
- 폴더는 **'링크가 있는 모든 사용자'로 공개** 되어 있어야 다운로드됩니다.
- 스캔본(텍스트 없는 이미지 PDF)은 자동 건너뜁니다(OCR 미지원).
- 같은 문서를 다시 돌리면 그 문서의 기존 청크를 지우고 새로 넣습니다(중복 방지).

## 비용 메모
임베딩 모델은 `text-embedding-3-small`(저렴). 폴더 전체(수십만~수백만 자)라도
임베딩 비용은 보통 수 센트 수준입니다.
