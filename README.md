# dreamit-ai-api (독립형)

꿈it 지도안 도구(`metan-portal/dreamit_final_output.html`)가 호출하는 **독립 OpenAI 중계 API**입니다.
기존 study.jbot.kr(webapp)과 완전히 분리된 별도 Vercel 프로젝트로, OpenAI 키를 브라우저에 노출하지 않고
이 프로젝트의 환경변수에 보관한 채 GPT를 호출합니다.

```
브라우저(HTML) ──POST {system,user}──▶ /api/generate (이 프로젝트) ──OpenAI 키──▶ OpenAI
              ◀──── 각 칸 JSON ───────────────────────────────────────────────┘
```

폴더 구조:
```
dreamit-ai-api/
  api/generate.js   ← 서버리스 함수 (이게 핵심)
  package.json
  README.md
```

## 배포 (한 번만)

### 방법 A — Vercel 대시보드 (가장 쉬움, GitHub 불필요)
1. 이 `dreamit-ai-api` 폴더를 GitHub에 올리거나, 아래 CLI 방법을 씁니다.
   - GitHub에 올렸다면: vercel.com → **Add New… → Project** → 이 리포 선택 → **Deploy**.

### 방법 B — Vercel CLI (GitHub 없이 폴더 그대로 배포)
```
cd C:\Users\USER\Projects\dreamit-ai-api
vercel            # 처음엔 프로젝트 생성: 이름을 dreamit-ai-api 로 추천
vercel --prod     # 운영 배포
```
- `vercel` 실행 시 질문:
  - Set up and deploy? **Y**
  - Which scope? 본인 계정
  - Link to existing project? **N** (새 프로젝트)
  - Project name? **dreamit-ai-api** (이 이름이면 주소가 `https://dreamit-ai-api.vercel.app` 가 됨)
  - directory? 그냥 Enter(현재 폴더)

### 공통 — 환경변수 등록 (필수)
배포한 프로젝트 → **Settings → Environment Variables** 에 추가하고 **Redeploy**:
- `OPENAI_API_KEY` = (OpenAI 키)  ← 필수. study.jbot.kr에 넣어둔 그 키 값을 그대로 붙여넣어도 됩니다.
- `OPENAI_MODEL` = `gpt-4o-mini`  ← 선택(안 넣으면 기본값)

CLI로 등록하려면:
```
vercel env add OPENAI_API_KEY production
vercel env add OPENAI_MODEL production   # 선택
vercel --prod                            # 환경변수 반영 위해 재배포
```

## HTML 연결
배포 후 함수 주소: `https://dreamit-ai-api.vercel.app/api/generate`
`dreamit_final_output.html` 상단 상수에 이미 이 주소를 넣어 두었습니다. 프로젝트 이름을 다르게 지었다면 그 줄만 바꾸세요.
```js
const AI_ENDPOINT = "https://dreamit-ai-api.vercel.app/api/generate";
```
- 주소가 틀리거나 호출 실패 시 HTML은 자동으로 **시뮬레이션**으로 동작하므로 시연이 멈추지 않습니다.

## 테스트
- 브라우저에서 `https://dreamit-ai-api.vercel.app/api/generate` 열기 → `POST only` 또는 비슷한 메시지가 보이면 살아있는 것(GET이라 거부).
- 지도안 도구에서 'AI 수업 추천으로 지도안 만들기' → 각 칸이 채워지면 성공.

## 보안 메모
- 키는 이 서버의 환경변수에만 있고 브라우저로 내려가지 않습니다.
- CORS는 데모 편의를 위해 모든 출처(`*`)를 허용합니다. 특정 도메인만 허용하려면 `api/generate.js`의 `setCors`에서 `"*"` 대신 도메인을 넣으세요.
- 인증이 없어 외부에서도 호출할 수 있습니다(OpenAI 할당량 사용). 운영 시 간단한 비밀 토큰 검사 추가를 권장합니다.
