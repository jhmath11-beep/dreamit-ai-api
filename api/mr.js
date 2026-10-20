// 매탄중 수학 다지기(mathremind) 전용 OpenAI 중계 (Vercel 서버리스)
//
// 역할: 복습 앱이 보낸 학생 수행 요약(system/user 프롬프트)을 받아 이 프로젝트의
//       OPENAI_API_KEY 로 GPT를 호출하고 텍스트를 돌려준다. (꿈it generate.js 와 키 공유)
//       images 를 함께 보내면(학습지 사진·PDF 페이지) 비전 입력으로 붙이고,
//       json:true 면 JSON 객체만 돌려주도록 response_format 을 건다.
//
// 인증: 앱이 보내는 Firebase 익명 로그인 ID 토큰을 identitytoolkit 로 검증해
//       math-detective-43743 프로젝트 사용자만 통과시킨다.
//       ponytail: 익명 토큰이라 "앱을 연 사람"만 거를 뿐 강한 인증은 아님. 남용이 보이면
//       교사 전용 토큰(RTDB teachers 대조)으로 올릴 것.
//
// 호출: POST /api/mr   headers: Authorization: Bearer <firebase idToken>
//       body: { system, user, maxTokens?, images?: [dataURL...], json?: boolean }
// 응답: 200 { text }

const FIREBASE_WEB_KEY = process.env.MR_FIREBASE_WEB_KEY || "AIzaSyCixmaBwPSgdsKkTv6MRrTCV7J1LlBQNA4";
const MAX_USER_CHARS = 16000;
const MAX_IMAGES = 8;
const MAX_IMAGE_CHARS = 3_000_000; // dataURL 기준 약 2.2MB

module.exports.config = { maxDuration: 120 }; // 학습지 비전 추출은 30~90초 걸릴 수 있음

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const authResult = await verifyFirebase(req);
  if (!authResult.ok) { res.status(authResult.status).json({ error: authResult.error }); return; }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "OPENAI_API_KEY 환경변수가 설정되지 않았습니다." }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const system = typeof body.system === "string" ? body.system : "";
  const user = typeof body.user === "string" ? body.user.slice(0, MAX_USER_CHARS) : "";
  if (!user) { res.status(400).json({ error: "user 프롬프트가 비어 있습니다." }); return; }
  const images = Array.isArray(body.images)
    ? body.images.filter(x => typeof x === "string" && x.startsWith("data:image/") && x.length <= MAX_IMAGE_CHARS).slice(0, MAX_IMAGES)
    : [];
  const wantJson = body.json === true;
  const maxTokens = Math.min(Math.max(parseInt(body.maxTokens, 10) || 1200, 200), 8000);
  const model = process.env.MR_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4o";

  const userContent = images.length
    ? [{ type: "text", text: user }, ...images.map(url => ({ type: "image_url", image_url: { url, detail: "high" } }))]
    : user;
  const payload = {
    model, temperature: wantJson ? 0.2 : 0.4, max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: userContent }]
  };
  if (wantJson) payload.response_format = { type: "json_object" };

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
    const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || "").trim();
    if (!text) { res.status(502).json({ error: "AI 응답이 비어 있습니다." }); return; }
    res.status(200).json({ text, model, finish: j.choices[0].finish_reason });
  } catch (e) {
    res.status(500).json({ error: "생성 중 오류: " + (e && e.message || e) });
  }
};
