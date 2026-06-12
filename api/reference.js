// 꿈it 지도안 도구 — 참고자료(Drive 문서 본문) 저장/조회 API (Vercel 서버리스)
//
// 브라우저의 '참고자료 관리' 화면이 Drive 문서 본문을 붙여넣어 여기로 보내면,
// Supabase에 저장한다. /api/generate 가 생성 직전 이 자료를 읽어 프롬프트에 주입한다.
//
// 환경변수
//   - SUPABASE_URL           (필수) : https://xxxx.supabase.co
//   - SUPABASE_SERVICE_KEY   (필수) : service_role 키 (서버 전용, 브라우저 노출 금지)
//   - REFERENCE_ADMIN_TOKEN  (선택) : 설정하면 쓰기(POST/DELETE) 시 x-admin-token 헤더 일치 요구
//
// 라우트
//   GET    /api/reference            → 자료 목록(본문 제외, 길이만)
//   GET    /api/reference?full=1     → 자료 목록(본문 포함)
//   POST   /api/reference            → { title, content, tags?, source? } 저장
//   DELETE /api/reference?id=<uuid>  → 삭제

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token");
}

function sbHeaders(key, extra) {
  return Object.assign({ apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" }, extra || {});
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    res.status(500).json({ error: "SUPABASE_URL / SUPABASE_SERVICE_KEY 환경변수가 설정되지 않았습니다." });
    return;
  }
  const base = `${url.replace(/\/$/, "")}/rest/v1/reference_docs`;

  // 쓰기 보호(선택)
  const adminToken = process.env.REFERENCE_ADMIN_TOKEN || "";
  const writeMethods = ["POST", "DELETE"];
  if (adminToken && writeMethods.includes(req.method)) {
    const sent = req.headers["x-admin-token"] || "";
    if (sent !== adminToken) { res.status(401).json({ error: "관리 토큰이 올바르지 않습니다." }); return; }
  }

  try {
    if (req.method === "GET") {
      const full = req.query && (req.query.full === "1" || req.query.full === "true");
      const cols = full ? "id,title,source,tags,content,created_at" : "id,title,source,tags,created_at";
      const r = await fetch(`${base}?select=${cols}&order=created_at.asc`, { headers: sbHeaders(key) });
      if (!r.ok) { res.status(502).json({ error: `Supabase ${r.status}`, detail: (await r.text()).slice(0, 300) }); return; }
      const rows = await r.json();
      // 본문 미요청 시 길이만 내려서 가볍게 한다.
      const out = rows.map((d) => full ? d : { id: d.id, title: d.title, source: d.source, tags: d.tags, created_at: d.created_at, length: (d.content || "").length });
      res.status(200).json(out);
      return;
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      const title = String(body.title || "").trim();
      const content = String(body.content || "").trim();
      if (!title || !content) { res.status(400).json({ error: "title과 content는 필수입니다." }); return; }
      const row = {
        title,
        content,
        tags: String(body.tags || "").trim(),
        source: String(body.source || "drive").trim() || "drive"
      };
      const r = await fetch(base, {
        method: "POST",
        headers: sbHeaders(key, { Prefer: "return=representation" }),
        body: JSON.stringify(row)
      });
      if (!r.ok) { res.status(502).json({ error: `Supabase ${r.status}`, detail: (await r.text()).slice(0, 300) }); return; }
      const inserted = await r.json();
      res.status(200).json(Array.isArray(inserted) ? inserted[0] : inserted);
      return;
    }

    if (req.method === "DELETE") {
      const id = req.query && req.query.id;
      if (!id) { res.status(400).json({ error: "id 쿼리가 필요합니다." }); return; }
      const r = await fetch(`${base}?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: sbHeaders(key, { Prefer: "return=minimal" })
      });
      if (!r.ok) { res.status(502).json({ error: `Supabase ${r.status}`, detail: (await r.text()).slice(0, 300) }); return; }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "지원하지 않는 메서드" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
