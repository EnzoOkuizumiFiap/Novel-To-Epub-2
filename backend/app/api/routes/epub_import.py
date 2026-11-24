"""Importação direta de arquivos .epub locais (upload, preview e job)."""

from __future__ import annotations

import asyncio
import base64
import hashlib
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Request
from slugify import slugify
from sqlalchemy import select

from app.api.deps import get_jobs
from app.api.jobs import JobManager
from app.api.schemas import (
    DownloadRequest,
    EpubChapterPreviewOut,
    EpubImportRequest,
    EpubPreviewOut,
    EpubPreviewRequest,
    JobStatus,
)
from app.config import settings
from app.db import models as orm
from app.db.database import get_session
from app.epub.reader import import_epub_to_cache, parse_epub

router = APIRouter()

_MAX_UPLOAD_BYTES = 100 * 1024 * 1024
_MAX_PREVIEW_COVER_BYTES = 2_500_000


@router.post("/epub/upload")
async def upload_epub(request: Request) -> dict:
    """Recebe binário .epub cru (fallback browser sem dialog nativo)."""
    raw_name = unquote(request.headers.get("x-filename") or "livro.epub")
    orig_name = Path(raw_name).name or "livro.epub"
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="arquivo vazio")
    if len(body) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="arquivo excede limite de 100 MB")
    if not body.startswith(b"PK\x03\x04"):
        raise HTTPException(status_code=400, detail="arquivo inválido (não é um .epub/ZIP)")

    digest = hashlib.sha256(body).hexdigest()[:12]
    stem = slugify(Path(orig_name).stem) or "livro"
    uploads_dir = settings.data_dir / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    dest = uploads_dir / f"{digest}-{stem}.epub"
    dest.write_bytes(body)
    return {"file_path": str(dest), "filename": orig_name}


@router.post("/epub/preview", response_model=EpubPreviewOut)
async def preview_epub(req: EpubPreviewRequest) -> EpubPreviewOut:
    """Lê metadados, capa e capítulos de um .epub local sem alterar o banco."""
    path = Path(req.file_path.strip())
    try:
        parsed = await asyncio.to_thread(parse_epub, path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    with get_session() as s:
        matched = s.scalar(
            select(orm.Novel).where(
                orm.Novel.source == "epub",
                orm.Novel.slug == parsed.series_slug,
            )
        )

    cover_data_url: str | None = None
    if parsed.cover_bytes and len(parsed.cover_bytes) <= _MAX_PREVIEW_COVER_BYTES:
        mime = parsed.cover_mime or "image/jpeg"
        b64 = base64.b64encode(parsed.cover_bytes).decode("ascii")
        cover_data_url = f"data:{mime};base64,{b64}"

    return EpubPreviewOut(
        file_path=str(path),
        title=parsed.title,
        series_name=parsed.series_name,
        author=parsed.author,
        description=parsed.description,
        language=parsed.language,
        cover_data_url=cover_data_url,
        total_chapters=len(parsed.chapters),
        total_chars=sum(c.char_count for c in parsed.chapter_previews),
        chapters=[
            EpubChapterPreviewOut(
                index=c.index,
                title=c.title,
                char_count=c.char_count,
                paragraph_count=c.paragraph_count,
            )
            for c in parsed.chapter_previews
        ],
        matched_novel_id=matched.id if matched else None,
        matched_novel_title=matched.title if matched else None,
    )


@router.post("/epub/import", response_model=JobStatus, status_code=201)
async def import_epub(
    req: EpubImportRequest, jobs: JobManager = Depends(get_jobs)
) -> JobStatus:
    """Importa capítulos do .epub no cache da obra/série e enfileira tradução/EPUB."""
    path = Path(req.file_path.strip())
    try:
        info = await asyncio.to_thread(
            import_epub_to_cache,
            path,
            novel_id=req.novel_id,
            series_title=req.series_title,
            volume_title=req.volume_title,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    count = info["chapter_count"]
    if req.start > count:
        raise HTTPException(
            status_code=400,
            detail=f"início ({req.start}) maior que total de capítulos do EPUB ({count})",
        )
    base = info["start"] - 1
    abs_start = base + req.start
    abs_end = base + min(req.end, count) if req.end is not None else info["end"]
    if abs_end < abs_start:
        raise HTTPException(
            status_code=400,
            detail=f"intervalo inválido ({req.start}..{req.end})",
        )
    abs_skip = [base + i for i in req.skip_chapters if 1 <= i <= count]

    dl_req = DownloadRequest(
        url=info["source_url"],
        start=abs_start,
        end=abs_end,
        with_cover=req.with_cover,
        translate_to=req.translate_to,
        volume_title=info["volume_title"],
        ai_cover=req.ai_cover,
        cover_style=req.cover_style,
        skip_chapters=abs_skip,
    )
    status = jobs.enqueue(dl_req).to_status()
    uploads_dir = (settings.data_dir / "uploads").resolve()
    try:
        if path.resolve().is_relative_to(uploads_dir):
            path.unlink(missing_ok=True)
    except OSError:
        pass
    return status
