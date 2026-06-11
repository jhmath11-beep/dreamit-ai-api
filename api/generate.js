// 꿈it 지도안 도구 전용 - 독립형 OpenAI 중계 서버리스 함수 (Vercel)
//
// 역할: 브라우저가 보낸 수업 정보(system/user 프롬프트)를 받아,
//       이 프로젝트의 환경변수에 보관된 OpenAI 키로 GPT를 호출하고,
//       연구학교 양식 각 칸에 들어갈 JSON을 돌려준다.
//       (기존 study.jbot.kr 프로젝트와 완전히 분리된 독립 배포)
//
// 필요한 환경변수 (이 Vercel 프로젝트 Settings → Environment Variables)
//   - OPENAI_API_KEY  (필수)  : OpenAI API 키
//   - OPENAI_MODEL    (선택)  : 기본값 "gpt-4o-mini"
//
// 호출: POST /api/generate   body: { "system": "...", "user": "..." }
// 응답: 200  { designPoint, chasi, careerLinks, dreamitMethod, warmUp, activity, wrapUp }

// 연구학교 양식 각 칸을 채우기 위한 출력 스키마 (HTML과 동일 구조).
const LESSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    designPoint: { type: "string", description: "수업 디자인의 주안점(2~4문장)" },
    chasi: {
      type: "array",
      description: "차시별 활동 내용",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          period: { type: "string", description: "예: 1차시" },
          content: { type: "string" }
        },
        required: ["period", "content"]
      }
    },
    careerLinks: {
      type: "array",
      description: "해당하는 진로·직업 연계 영역만 선택",
      items: { type: "string", enum: ["진로와 나의 이해", "직업 세계와 진로 탐색", "진로 설계와 실천"] }
    },
    dreamitMethod: { type: "string", description: "꿈it(잇)다 시스템 연계 방법" },
    warmUp: {
      type: "object",
      additionalProperties: false,
      properties: { teacher: { type: "string" }, student: { type: "string" }, note: { type: "string" } },
      required: ["teacher", "student", "note"]
    },
    activity: {
      type: "object",
      additionalProperties: false,
      properties: { teacher: { type: "string" }, student: { type: "string" }, note: { type: "string" } },
      required: ["teacher", "student", "note"]
    },
    wrapUp: {
      type: "object",
      additionalProperties: false,
      properties: { teacher: { type: "string" }, student: { type: "string" }, note: { type: "string" } },
      required: ["teacher", "student", "note"]
    }
  },
  required: ["designPoint", "chasi", "careerLinks", "dreamitMethod", "warmUp", "activity", "wrapUp"]
};

function setCors(res) {
  // 데모용: 모든 출처 허용. 운영 시 특정 도메인으로 제한하려면 "*" 대신 도메인을 넣으세요.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
          { role: "user", content: user }
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
