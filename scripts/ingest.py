#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
꿈it 지도안 도구 — Drive 참고자료 RAG 인제스트 스크립트 (로컬 실행)

공개 Google Drive 폴더의 PDF/DOCX를 내려받아 텍스트 추출 → 청크 분할 →
OpenAI 임베딩 → Supabase(reference_chunks)에 적재한다.
이 스크립트는 '본인 컴퓨터'에서 실행하며, 키는 환경변수로만 읽으므로
service_role 키를 외부에 노출하지 않는다.

준비물:
  pip install pymupdf requests
환경변수(셸에 export 하거나 scripts/.env 에 KEY=VALUE 형식으로):
  OPENAI_API_KEY          (필수)
  SUPABASE_URL            (필수)  예: https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY    (필수)  service_role 키
선행:
  Supabase에 supabase-schema.sql, supabase-rag.sql 를 먼저 Run.

사용:
  python scripts/ingest.py                       # 기본 폴더 전체 인제스트
  python scripts/ingest.py --folder <FOLDER_ID>  # 다른 폴더
  python scripts/ingest.py --reset               # 적재 전 reference_chunks 전체 삭제
  python scripts/ingest.py --limit 2             # 앞 N개 파일만(테스트)
"""

import os
import re
import sys
import json
import time
import zipfile
import argparse
import urllib.parse
from io import BytesIO

import requests

import unicodedata

try:
    import fitz  # PyMuPDF
except ImportError:
    print("PyMuPDF가 필요합니다:  pip install pymupdf", file=sys.stderr)
    sys.exit(1)

# 윈도우 콘솔(cp949)에서 한글 출력 시 UnicodeEncodeError가 나지 않도록 UTF-8로 전환.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

DEFAULT_FOLDER = "1d8yE4YtYa5gW43C-chWkLKuX4qFVWGXA"
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIM = 1536
CHUNK_CHARS = 1200
CHUNK_OVERLAP = 150
EMBED_BATCH = 64
UPSERT_BATCH = 100


def load_dotenv():
    path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def env(name):
    v = os.environ.get(name)
    if not v:
        print(f"환경변수 {name} 가 설정되지 않았습니다.", file=sys.stderr)
        sys.exit(1)
    return v


def list_folder(folder_id):
    """공개 폴더의 (file_id, title) 목록을 embeddedfolderview HTML에서 파싱."""
    url = f"https://drive.google.com/embeddedfolderview?id={folder_id}#list"
    html = requests.get(url, timeout=60).text
    ids = re.findall(r"/file/d/([A-Za-z0-9_-]+)/", html)
    titles = re.findall(r'flip-entry-title">([^<]+)</div>', html)
    seen, pairs = set(), []
    for fid, title in zip(ids, titles):
        if fid in seen:
            continue
        seen.add(fid)
        pairs.append((fid, unicodedata.normalize("NFC", title)))
    return pairs


def download(file_id):
    url = f"https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t"
    r = requests.get(url, timeout=300)
    r.raise_for_status()
    return r.content


def extract_pdf(data):
    doc = fitz.open(stream=data, filetype="pdf")
    parts = [doc[i].get_text() for i in range(doc.page_count)]
    doc.close()
    return "\n".join(parts)


def extract_docx(data):
    with zipfile.ZipFile(BytesIO(data)) as z:
        xml = z.read("word/document.xml").decode("utf-8", "ignore")
    xml = xml.replace("</w:p>", "\n")
    text = re.sub(r"<[^>]+>", "", xml)
    return re.sub(r"[ \t]+", " ", text)


def clean(text):
    text = text.replace("\u00a0", " ").replace("\u200b", "")
    # NUL(\x00) \ubc0f \uc904\ubc14\uafc8/\ud0ed\uc744 \ube80 \uc81c\uc5b4\ubb38\uc790 \uc81c\uac70 \u2014 Postgres text \ub294  \uc744 \uc800\uc7a5 \ubabb \ud568.
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def chunk_text(text):
    """문단 경계를 살려 ~CHUNK_CHARS 크기로 나누고 약간 겹치게 한다."""
    paras = [p.strip() for p in text.split("\n") if p.strip()]
    chunks, cur = [], ""
    for p in paras:
        if len(cur) + len(p) + 1 <= CHUNK_CHARS:
            cur = f"{cur}\n{p}" if cur else p
        else:
            if cur:
                chunks.append(cur)
            if len(p) > CHUNK_CHARS:
                # 아주 긴 문단은 글자수로 자른다.
                for i in range(0, len(p), CHUNK_CHARS - CHUNK_OVERLAP):
                    chunks.append(p[i:i + CHUNK_CHARS])
                cur = ""
            else:
                cur = p
    if cur:
        chunks.append(cur)
    # 인접 청크 약간 겹치기
    overlapped = []
    for i, c in enumerate(chunks):
        if i > 0:
            tail = chunks[i - 1][-CHUNK_OVERLAP:]
            c = tail + "\n" + c
        overlapped.append(c)
    return overlapped


def embed(texts, api_key):
    out = []
    for i in range(0, len(texts), EMBED_BATCH):
        batch = texts[i:i + EMBED_BATCH]
        r = requests.post(
            "https://api.openai.com/v1/embeddings",
            headers={"Authorization": f"Bearer {api_key}", "content-type": "application/json"},
            json={"model": EMBED_MODEL, "input": batch},
            timeout=120,
        )
        if not r.ok:
            raise RuntimeError(f"OpenAI embeddings {r.status_code}: {r.text[:300]}")
        data = r.json()["data"]
        out.extend(d["embedding"] for d in data)
        time.sleep(0.2)
    return out


def sb_headers(key, extra=None):
    h = {"apikey": key, "Authorization": f"Bearer {key}", "content-type": "application/json"}
    if extra:
        h.update(extra)
    return h


def delete_doc_chunks(base, key, doc_title):
    q = urllib.parse.quote(doc_title, safe="")
    requests.delete(f"{base}/reference_chunks?doc_title=eq.{q}", headers=sb_headers(key, {"Prefer": "return=minimal"}), timeout=60)


def insert_chunks(base, key, rows):
    for i in range(0, len(rows), UPSERT_BATCH):
        batch = rows[i:i + UPSERT_BATCH]
        r = requests.post(f"{base}/reference_chunks", headers=sb_headers(key, {"Prefer": "return=minimal"}), data=json.dumps(batch), timeout=120)
        if not r.ok:
            raise RuntimeError(f"Supabase insert {r.status_code}: {r.text[:300]}")


def main():
    load_dotenv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", default=DEFAULT_FOLDER)
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    openai_key = env("OPENAI_API_KEY")
    sb_url = env("SUPABASE_URL").rstrip("/")
    sb_key = env("SUPABASE_SERVICE_KEY")
    base = f"{sb_url}/rest/v1"

    if args.reset:
        print("reference_chunks 전체 삭제…")
        requests.delete(f"{base}/reference_chunks?id=gt.0", headers=sb_headers(sb_key, {"Prefer": "return=minimal"}), timeout=120)

    files = list_folder(args.folder)
    if args.limit:
        files = files[:args.limit]
    print(f"폴더 파일 {len(files)}개")

    total_chunks = 0
    for n, (fid, title) in enumerate(files, 1):
        low = title.lower()
        if not (low.endswith(".pdf") or low.endswith(".docx") or ".pdf" in low or ".docx" in low):
            print(f"[{n}/{len(files)}] 건너뜀(지원 형식 아님): {title}")
            continue
        try:
            print(f"[{n}/{len(files)}] 다운로드: {title}")
            data = download(fid)
            if ".docx" in low:
                text = extract_docx(data)
            else:
                text = extract_pdf(data)
            text = clean(text)
            if len(text) < 50:
                print(f"    텍스트가 거의 없음({len(text)}자) — 스캔본 가능. 건너뜀.")
                continue
            chunks = chunk_text(text)
            print(f"    텍스트 {len(text)}자 → 청크 {len(chunks)}개, 임베딩…")
            vectors = embed(chunks, openai_key)
            tag = "수학" if "수학" in title else ("진로" if "진로" in title else "")
            rows = [{
                "doc_title": title,
                "source": "drive",
                "tags": tag,
                "chunk_index": i,
                "content": c,
                "embedding": v,
            } for i, (c, v) in enumerate(zip(chunks, vectors))]
            delete_doc_chunks(base, sb_key, title)
            insert_chunks(base, sb_key, rows)
            total_chunks += len(rows)
            print(f"    적재 완료 (누적 청크 {total_chunks})")
        except Exception as e:
            print(f"    실패: {e}", file=sys.stderr)

    print(f"\n완료. 총 청크 {total_chunks}개 적재.")


if __name__ == "__main__":
    main()
