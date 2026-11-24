"""Cache de capitulos ja traduzidos. Nunca re-traduz o mesmo (novel, cap, lingua)."""

from __future__ import annotations

from sqlalchemy import delete, select

from app.db import models as orm
from app.db.database import get_session, init_db


class TranslationStore:
    def __init__(self) -> None:
        init_db()

    def get(self, novel_id: int, chapter_index: int, language: str) -> tuple[str, str | None] | None:
        """Retorna ``(html, titulo_traduzido)`` ou ``None`` se nao houver."""
        with get_session() as s:
            row = s.scalar(
                select(orm.TranslatedChapter).where(
                    orm.TranslatedChapter.novel_id == novel_id,
                    orm.TranslatedChapter.chapter_index == chapter_index,
                    orm.TranslatedChapter.language == language,
                )
            )
            return (row.html, row.title) if row else None

    def save(
        self,
        *,
        novel_id: int,
        chapter_index: int,
        language: str,
        title: str | None,
        html: str,
        model: str,
        glossary_size: int,
    ) -> None:
        with get_session() as s:
            row = s.scalar(
                select(orm.TranslatedChapter).where(
                    orm.TranslatedChapter.novel_id == novel_id,
                    orm.TranslatedChapter.chapter_index == chapter_index,
                    orm.TranslatedChapter.language == language,
                )
            )
            if row is None:
                row = orm.TranslatedChapter(
                    novel_id=novel_id,
                    chapter_index=chapter_index,
                    language=language,
                )
                s.add(row)
            row.title = title
            row.html = html
            row.model = model
            row.glossary_size = glossary_size
            s.commit()

    def get_chunk(
        self,
        novel_id: int,
        chapter_index: int,
        language: str,
        chunk_index: int,
        chunk_hash: str,
    ) -> tuple[str, str | None, str] | None:
        """Retorna ``(html, title, model)`` se o bloco existir com mesmo hash."""
        with get_session() as s:
            row = s.scalar(
                select(orm.TranslatedChapterChunk).where(
                    orm.TranslatedChapterChunk.novel_id == novel_id,
                    orm.TranslatedChapterChunk.chapter_index == chapter_index,
                    orm.TranslatedChapterChunk.language == language,
                    orm.TranslatedChapterChunk.chunk_index == chunk_index,
                )
            )
            if row is None or row.chunk_hash != chunk_hash:
                return None
            return row.html, row.title, row.model

    def save_chunk(
        self,
        *,
        novel_id: int,
        chapter_index: int,
        language: str,
        chunk_index: int,
        total_chunks: int,
        chunk_hash: str,
        title: str | None,
        html: str,
        model: str,
    ) -> None:
        with get_session() as s:
            row = s.scalar(
                select(orm.TranslatedChapterChunk).where(
                    orm.TranslatedChapterChunk.novel_id == novel_id,
                    orm.TranslatedChapterChunk.chapter_index == chapter_index,
                    orm.TranslatedChapterChunk.language == language,
                    orm.TranslatedChapterChunk.chunk_index == chunk_index,
                )
            )
            if row is None:
                row = orm.TranslatedChapterChunk(
                    novel_id=novel_id,
                    chapter_index=chapter_index,
                    language=language,
                    chunk_index=chunk_index,
                )
                s.add(row)
            row.total_chunks = total_chunks
            row.chunk_hash = chunk_hash
            row.title = title
            row.html = html
            row.model = model
            s.commit()

    def clear_chunks(self, novel_id: int, chapter_index: int, language: str) -> None:
        with get_session() as s:
            s.execute(
                delete(orm.TranslatedChapterChunk).where(
                    orm.TranslatedChapterChunk.novel_id == novel_id,
                    orm.TranslatedChapterChunk.chapter_index == chapter_index,
                    orm.TranslatedChapterChunk.language == language,
                )
            )
            s.commit()
