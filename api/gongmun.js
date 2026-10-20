// 매탄 업무포털 "공문 분석기" 전용 OpenAI 중계 (Vercel 서버리스)
//
// 역할: 브라우저에서 개인정보를 가린 공문 텍스트(본문+붙임 요약)를 받아
//       고정 system 프롬프트 + json_schema(strict)로 요약·메신저·제출정보·날짜 근거를 돌려준다.
//       날짜 계산은 하지 않는다(근거 문장만). 확정은 프론트 dates.js 가 한다.
//
// 인증: mr.js 와 같은 Firebase 익명 로그인 ID 토큰 검증(math-detective-43743).
//       ponytail: 익명 토큰이라 "앱을 연 사람"만 거를 뿐 강한 인증은 아님.
//
// 호출: POST /api/gongmun   headers: Authorization: Bearer <firebase idToken>
//       body: { text }   (text 앞머리에 "부서명: ..." 포함)
// 응답: 200 { data, model }   / AI 응답 파싱 실패 502

const FIREBASE_WEB_KEY = process.env.MR_FIREBASE_WEB_KEY || "AIzaSyCixmaBwPSgdsKkTv6MRrTCV7J1LlBQNA4";
const MAX_USER_CHARS = 40000;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Access-Code");
}

async function verifyFirebase(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return { ok: false, status: 401, error: "앱에서 로그인한 뒤 다시 시도해 주세요." };
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_KEY}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: token }), signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return { ok: false, status: 401, error: "인증 토큰이 유효하지 않습니다. 새로고침 후 다시 시도해 주세요." };
    const j = await r.json();
    if (!j.users || !j.users.length) return { ok: false, status: 401, error: "인증 실패" };
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 502, error: "인증 확인 중 오류가 발생했습니다." };
  }
}

const S = { type: "string" };
const SA = { type: "array", items: S };
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

const SCHEMA = obj({
  summary: obj({
    oneLine: S,
    basic: obj({ title: S, sender: S, docNo: S, docDate: S, recvNo: S, recvDate: S, related: S, disclosure: S }),
    kind: { type: "string", enum: ["안내", "제출", "신청·모집", "행사·연수", "조사·회신", "기타"] },
    points: SA,
    attachments: {
      type: "array",
      items: obj({ no: S, name: S, what: S, points: SA, isForm: { type: "boolean" }, formFields: SA })
    }
  }),
  messenger: obj({
    all: { type: "string", description: "전체 교직원용 메신저 안내문. 형식 그대로 10~18줄의 완성된 글." },
    target: { type: "string", description: "해당자·담당자용 메신저 안내문. all 과 같은 형식의 완성된 글(10~18줄). 따로 필요 없으면 빈 문자열. 담당자 이름·직위만 쓰는 것은 금지." }
  }),
  submit: obj({ required: { type: "boolean" }, deadlineText: S, where: S, method: S, form: S, target: S, evidence: S }),
  todos: { type: "array", items: { type: "string", description: "'~하기'로 끝나는 명사형 할 일. 예: 의견서 취합하기. '~하다'·'~한다' 금지." } },
  dateCandidates: { type: "array", items: obj({ label: S, sourceSentence: S }) }
});

const SYSTEM = `당신은 중학교 교무실의 공문 정리 담당자입니다. 사용자가 보낸 공문(본문과 붙임 파일 추출 텍스트)을 읽고 지정된 JSON 스키마로만 답합니다.

[절대 규칙]
- 공문에 없는 내용은 쓰지 않는다. 추측·일반론·덧붙임 금지. 모르는 칸은 빈 문자열 "".
- 학교 내부에서 정할 사항(내부 담당자, 내부 마감일, 학교 자체 계획 등 공문에 없는 판단)은 "[  ]" 로 비워 둔다.
- 날짜는 계산하거나 형식을 바꾸지 않는다. 기한·일정은 dateCandidates 에 근거 문장을 원문 그대로(띄어쓰기·요일·시각 포함) 옮긴다.
- 개인정보는 이미 [전화번호] 등으로 가려져 있다. 복원하거나 추측하지 않는다.

[summary]
- oneLine: 이 공문이 무엇을 요구하는지 한 문장.
- basic: 제목, 발신기관(sender), 시행번호(docNo), 시행일(docDate, 원문 표기 그대로), 접수번호(recvNo), 접수일(recvDate), 관련 문서(related), 공개여부(disclosure).
- kind: 안내 | 제출 | 신청·모집 | 행사·연수 | 조사·회신 | 기타 중 하나.
- points: 핵심 내용 3~7개, 짧은 문장.
- attachments: 붙임마다 no(붙임 번호, 예 "1"), name, what(무엇인 문서인지 한 줄), points(핵심 1~4개), isForm(작성해서 내야 하는 서식이면 true), formFields(서식이면 채워야 할 항목명, 아니면 []).

[messenger] 교직원 메신저용 순수 텍스트. 마크다운(#, *, -, **, 표) 금지. 기호는 ■ ※ → 만 사용. 10~18줄.
목표: 이 글만 읽고 "내가 해당되는지, 언제까지, 무엇을, 어떻게, 누구에게" 내는지 알 수 있어야 한다. 공문 문장을 옮겨 적지 말고 읽는 사람이 할 행동 중심으로 다시 정리한다. 형식:
[안내] 핵심만 남긴 짧은 제목
{부서명}입니다.
(발신기관)에서 온 (무엇) 안내입니다. 해당 선생님께서는 아래 내용을 확인해 주시기 바랍니다.   ← 1~2문장
■ 대상: 누가 해당되는지
■ 기준: 실적 기준일·기간 등(해당 시)
■ 기한: {교내마감}까지 (누구에게 무엇을 내는지)
■ 방법·절차
→ 1. 누가 무엇을 한다([붙임N] 이름과 함께)
→ 2. 누가 누구에게 어떻게 낸다
※ 유의사항: 오해하기 쉬운 점·주의점(해당 시)
※ 상세 내용과 서식은 공람된 공문을 확인해 주세요.
감사합니다.
- 해당 없는 ■ 줄은 뺀다. "붙임 목록" 줄은 만들지 않는다. 붙임은 절차 속에서 [붙임N]으로 언급한다.
- 절차의 각 단계는 주어(희망자·담당자·교감 등)를 분명히 쓴다. 교원 → 교내 담당자 → 교육청처럼 제출이 두 단계면 단계별로 나눈다. 교원이 직접 교육청·에듀파인에 내는 것처럼 쓰지 않는다.
- 기한: 교직원은 학교 내부 마감에 맞춰 내야 하므로, 학교가 제출할 것이 있으면(submit.required) ■ 기한 줄과 본문 어디에도 교육청 기한 날짜를 쓰지 말고 반드시 "{교내마감}" 이라는 글자를 그대로 쓴다(앱이 학교 내부 마감일로 바꿔 넣는다). 예: "■ 기한: {교내마감}까지 교감 선생님께 인비 제출". 제출이 없는 안내·행사 공문이면 일정 원문 표기를 그대로 쓴다.
- {부서명}은 입력 앞머리 "부서명:" 값을 그대로 쓴다.
- all: 전체 교직원용 안내문.
- target: 해당자·담당자용 안내문. 제출·작성할 사람이 따로 있을 때만 쓰고, all 과 같은 형식의 완성된 안내문(10~18줄)이어야 한다. 필요 없으면 "". "인사 담당자(교감)"처럼 담당자 이름·직위만 쓰는 것은 금지.

[submit] 학교가 교육청 등에 무엇을 내야 하면 required true. 아니면 false 이고 나머지는 "".
- deadlineText: 기한 문장 원문 그대로. where: 제출처. method: 제출 방법(공문, 업무포털, 메일 등). form: 제출 서식(붙임 번호). target: 제출 대상(누가/무엇을). evidence: 제출 요구가 적힌 근거 문장 원문.

[todos] 학교 담당자가 할 일 체크리스트(3~8개). 공문에 근거가 있는 것만. 모두 "~하기"로 끝나는 명사형(예: "의견서 취합하기", "업무포털로 제출하기"). "설정하다"·"준수한다" 같은 사전형·서술형 어미는 금지.
[dateCandidates] 공문 속 모든 기한·일정 문장. label 예: "제출 기한", "연수 일정", "신청 기간". sourceSentence 는 원문 그대로.`;

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const authResult = await verifyFirebase(req);
  if (!authResult.ok) { res.status(authResult.status).json({ error: authResult.error }); return; }

  // 접속코드: 허용된 몇 명만. GONGMUN_CODES="코드1,코드2" (Vercel 환경변수). 없으면 전부 거절.
  const codes = (process.env.GONGMUN_CODES || "").split(",").map(s => s.trim()).filter(Boolean);
  let code = ""; try { code = decodeURIComponent(String(req.headers["x-access-code"] || "")).trim(); } catch {}   // 한글 코드도 되게 프론트가 인코딩해 보냄
  if (!code || !codes.includes(code)) { res.status(403).json({ error: "접속코드가 맞지 않습니다.", code: "BAD_CODE" }); return; }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "OPENAI_API_KEY 환경변수가 설정되지 않았습니다." }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const text = typeof body.text === "string" ? body.text.slice(0, MAX_USER_CHARS) : "";
  if (!text.trim()) { res.status(400).json({ error: "공문 텍스트가 비어 있습니다." }); return; }
  const model = process.env.GONGMUN_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4o";

  const payload = {
    model, temperature: 0.2, max_tokens: 8000,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }],
    response_format: { type: "json_schema", json_schema: { name: "gongmun", strict: true, schema: SCHEMA } }
  };

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: `OpenAI 오류(${r.status})`, detail: t.slice(0, 300) });
      return;
    }
    const j = await r.json();
    const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || "").trim();
    if (j.choices && j.choices[0] && j.choices[0].finish_reason === "length") {
      res.status(502).json({ error: "응답이 너무 길어 잘렸습니다. 붙임 수를 줄여 다시 시도해 주세요." });
      return;
    }
    let data;
    try { data = JSON.parse(content); } catch (e) { data = null; }
    if (!data || typeof data !== "object" || Array.isArray(data)) { res.status(502).json({ error: "AI 응답을 해석하지 못했습니다. 다시 시도해 주세요." }); return; }
    res.status(200).json({ data, model });
  } catch (e) {
    res.status(500).json({ error: "분석 중 오류: " + (e && e.message || e) });
  }
};
// config 는 module.exports 재할당 뒤에 붙여야 남는다(앞에 두면 사라짐).
module.exports.config = { maxDuration: 120 };
