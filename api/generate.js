// 꿈it 지도안 도구 전용 - 독립형 OpenAI 중계 서버리스 함수 (Vercel)
//
// 역할: 브라우저가 보낸 수업 정보(system/user 프롬프트)를 받아,
//       이 프로젝트의 환경변수에 보관된 OpenAI 키로 GPT를 호출하고,
//       연구학교 양식 각 칸에 들어갈 JSON을 돌려준다.
//       (기존 study.jbot.kr 프로젝트와 완전히 분리된 독립 배포)
//
// 필요한 환경변수 (이 Vercel 프로젝트 Settings → Environment Variables)
//   - OPENAI_API_KEY  (필수)  : OpenAI API 키
//   - OPENAI_MODEL    (선택)  : 기본값 "gpt-4o" (작성 원칙 준수도·내용 품질이 mini보다 높음)
//
// 호출: POST /api/generate   body: { "system": "...", "user": "..." }
// 응답: 200  { designPoint, chasi, careerLinks, dreamitMethod, warmUp, activity, wrapUp }

// 연구학교 양식 각 칸을 채우기 위한 출력 스키마 (HTML과 동일 구조).
const LESSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    designPoint: { type: "string", description: "수업 디자인의 주안점. 핵심 의도·성취기준 도달 전략·진로 연계 논리를 5문장 이상으로 구체적으로." },
    chasi: {
      type: "array",
      description: "차시별 활동 내용",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          period: { type: "string", description: "예: 1차시" },
          content: { type: "string", description: "그 차시의 활동 흐름을 2~3문장으로 구체적으로" }
        },
        required: ["period", "content"]
      }
    },
    careerLinks: {
      type: "array",
      description: "해당하는 진로·직업 연계 영역만 선택",
      items: { type: "string", enum: ["진로와 나의 이해", "직업 세계와 진로 탐색", "진로 설계와 실천"] }
    },
    dreamitMethod: { type: "string", description: "꿈it(잇)다 시스템 연계 방법. 어느 수업 단계에서 어떻게 활용하는지 3문장 이상으로." },
    warmUp: {
      type: "object",
      additionalProperties: false,
      properties: {
        teacher: { type: "string", description: "배움열기 교사 활동. 실제 발문을 포함해 3문장 이상으로." },
        student: { type: "string", description: "배움열기 학생 활동. 실제 수행 과제로 3문장 이상으로." },
        note: { type: "string", description: "자료·에듀테크 사용법·시간 배분·유의점" }
      },
      required: ["teacher", "student", "note"]
    },
    activity: {
      type: "object",
      additionalProperties: false,
      properties: {
        teacher: { type: "string", description: "배움활동 교사 활동. 실제 발문·기준 제시를 포함해 3~4문장 이상으로." },
        student: { type: "string", description: "배움활동 학생 활동. 실제 수행 과제로 3~4문장 이상으로." },
        note: { type: "string", description: "자료·에듀테크 사용법·모둠 구성·평가 관점·유의점" }
      },
      required: ["teacher", "student", "note"]
    },
    wrapUp: {
      type: "object",
      additionalProperties: false,
      properties: {
        teacher: { type: "string", description: "삶과 연결 짓기 및 배움정리 교사 활동. 3문장 이상으로." },
        student: { type: "string", description: "삶과 연결 짓기 및 배움정리 학생 활동(진로 성찰 포함). 3문장 이상으로." },
        note: { type: "string", description: "자료·시간 배분·유의점" }
      },
      required: ["teacher", "student", "note"]
    }
  },
  required: ["designPoint", "chasi", "careerLinks", "dreamitMethod", "warmUp", "activity", "wrapUp"]
};

function setCors(res) {
  // 데모용: 모든 출처 허용. 운영 시 특정 도메인으로 제한하려면 "*" 대신 도메인을 넣으세요.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "x-reference-count");
}

// ── Google 로그인 검증 ─────────────────────────────────────────────
// 브라우저가 보낸 Google ID 토큰(JWT)을 Google tokeninfo로 검증하고,
// 허용된 도메인(@goedu.kr) 또는 허용 이메일만 통과시킨다.
// 라이브러리 없이(무설치) 동작하도록 tokeninfo 엔드포인트를 사용한다.
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || "goedu.kr")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "jhmath11@gmail.com")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

async function verifyGoogleUser(req) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return { ok: false, status: 500, error: "GOOGLE_CLIENT_ID 환경변수가 설정되지 않았습니다." };

  const auth = req.headers["authorization"] || req.headers["Authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return { ok: false, status: 401, error: "로그인이 필요합니다." };

  let payload;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
    if (!r.ok) return { ok: false, status: 401, error: "로그인 토큰이 유효하지 않습니다(만료되었을 수 있어요). 다시 로그인해 주세요." };
    payload = await r.json();
  } catch (e) {
    return { ok: false, status: 502, error: "로그인 토큰 검증 중 오류가 발생했습니다." };
  }

  if (payload.aud !== clientId) return { ok: false, status: 401, error: "토큰 대상이 일치하지 않습니다." };
  if (payload.email_verified !== "true" && payload.email_verified !== true) {
    return { ok: false, status: 403, error: "이메일이 확인되지 않은 계정입니다." };
  }
  const email = String(payload.email || "").toLowerCase();
  const domain = email.includes("@") ? email.split("@")[1] : "";
  const allowed = ALLOWED_EMAILS.includes(email) || ALLOWED_DOMAINS.includes(domain);
  if (!allowed) {
    return { ok: false, status: 403, error: "학교 계정(@goedu.kr)으로만 사용할 수 있습니다." };
  }
  return { ok: true, email };
}

// Supabase에 저장된 Drive 참고자료를 읽어, 수업 주제/교과와 관련도가 높은 순으로
// 글자수 예산(REFERENCE_CHAR_BUDGET) 안에서 모아 프롬프트에 넣을 블록을 만든다.
// 환경변수(SUPABASE_URL/KEY)가 없으면 빈 문자열을 돌려 기존 동작을 유지한다.
const REFERENCE_CHAR_BUDGET = 12000;
async function loadReferenceBlock(userText) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { text: "", count: 0 };
  try {
    const base = `${url.replace(/\/$/, "")}/rest/v1/reference_docs`;
    const r = await fetch(`${base}?select=title,tags,content&order=created_at.asc`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!r.ok) return { text: "", count: 0 };
    const docs = await r.json();
    if (!Array.isArray(docs) || !docs.length) return { text: "", count: 0 };

    const subject = (userText.match(/-\s*교과:\s*(.+)/) || [])[1] || "";
    const topic = (userText.match(/-\s*수업 주제:\s*(.+)/) || [])[1] || "";
    const keywords = `${subject} ${topic}`.split(/[\s,/]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
    const score = (d) => {
      const hay = `${d.title} ${d.tags} ${d.content}`;
      return keywords.reduce((acc, k) => acc + (hay.includes(k) ? 1 : 0), 0);
    };
    const ranked = docs
      .map((d, i) => ({ d, i, s: score(d) }))
      .sort((a, b) => (b.s - a.s) || (a.i - b.i));

    const parts = [];
    let used = 0;
    let count = 0;
    for (const { d } of ranked) {
      const body = String(d.content || "").trim();
      if (!body) continue;
      const remain = REFERENCE_CHAR_BUDGET - used;
      if (remain <= 200) break;
      const clip = body.length > remain ? body.slice(0, remain) + " …(이하 생략)" : body;
      parts.push(`〔자료: ${d.title}${d.tags ? ` (${d.tags})` : ""}〕\n${clip}`);
      used += clip.length;
      count += 1;
    }
    if (!parts.length) return { text: "", count: 0 };
    const text = `[참고 자료 — 학교가 제공한 Drive 문서 발췌입니다. 이 자료의 내용과 용어를 근거로 작성하고, 자료에 없는 사실은 지어내지 마세요.]\n\n${parts.join("\n\n")}`;
    return { text, count };
  } catch (e) {
    return { text: "", count: 0 };
  }
}

// RAG: 수업 주제를 임베딩해 Supabase pgvector(reference_chunks)에서 가장 가까운 청크만
// 가져와 프롬프트 블록을 만든다. pgvector 미설정/오류 시 null을 돌려 호출부가
// reference_docs(붙여넣기) 폴백으로 넘어가게 한다.
async function ragReferenceBlock(userText, apiKey) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !apiKey) return null;
  try {
    const pick = (re) => (userText.match(re) || [])[1] || "";
    const subject = pick(/-\s*교과:\s*(.+)/);
    const unit = pick(/-\s*단원명:\s*(.+)/);
    const topic = pick(/-\s*수업 주제:\s*(.+)/);
    const standard = pick(/-\s*성취기준:\s*(.+)/);
    const query = [subject, unit, topic, standard, "진로 연계 수업"].filter(Boolean).join(" ").trim();
    if (!query) return null;

    const er = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: query })
    });
    if (!er.ok) return null;
    const embedding = (await er.json()).data[0].embedding;

    const base = `${url.replace(/\/$/, "")}/rest/v1/rpc/match_reference_chunks`;
    const rr = await fetch(base, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ query_embedding: embedding, match_count: 12 })
    });
    if (!rr.ok) return null;
    const rows = await rr.json();
    if (!Array.isArray(rows) || !rows.length) return null;

    const parts = [];
    let used = 0;
    let count = 0;
    for (const row of rows) {
      const body = String(row.content || "").trim();
      if (!body) continue;
      const remain = REFERENCE_CHAR_BUDGET - used;
      if (remain <= 200) break;
      const clip = body.length > remain ? body.slice(0, remain) + " …(이하 생략)" : body;
      parts.push(`〔${row.doc_title || "자료"}〕\n${clip}`);
      used += clip.length;
      count += 1;
    }
    if (!parts.length) return null;
    const text = `[참고 자료 — 학교 Drive 자료에서 이 수업과 관련해 검색된 발췌입니다. 이 내용과 용어를 근거로 작성하고, 자료에 없는 사실은 지어내지 마세요.]\n\n${parts.join("\n\n")}`;
    return { text, count };
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  // 로그인 검증: 허용된 학교 계정만 OpenAI 호출 가능 (무분별한 API 사용 방지)
  const authResult = await verifyGoogleUser(req);
  if (!authResult.ok) {
    res.status(authResult.status).json({ error: authResult.error });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "OPENAI_API_KEY 환경변수가 설정되지 않았습니다." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};
  const system = typeof body.system === "string" ? body.system : "";
  const user = typeof body.user === "string" ? body.user : "";
  if (!user) {
    res.status(400).json({ error: "user 프롬프트가 비어 있습니다." });
    return;
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o";

  // Drive 참고자료를 읽어 사용자 프롬프트 앞에 붙인다(설정 안 됐으면 그대로 진행).
  // RAG(pgvector 검색)를 우선 시도하고, 없으면 reference_docs(붙여넣기) 폴백.
  const reference = (await ragReferenceBlock(user, apiKey)) || (await loadReferenceBlock(user));
  res.setHeader("x-reference-count", String(reference.count));
  const userWithRef = reference.text ? `${reference.text}\n\n----\n\n${user}` : user;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userWithRef }
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "lesson_fill", strict: true, schema: LESSON_SCHEMA }
        }
      })
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      res.status(502).json({ error: `OpenAI ${r.status}`, detail: detail.slice(0, 500) });
      return;
    }

    const data = await r.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) {
      res.status(502).json({ error: "OpenAI 응답이 비어 있습니다." });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      res.status(502).json({ error: "JSON 파싱 실패", raw: content.slice(0, 500) });
      return;
    }

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
