"""Orquestra traducao de UM capitulo: cache → provider → glossario → cache."""

from __future__ import annotations

import hashlib
import re
from typing import Callable

from app.db.usage_store import UsageStore
from app.logging_conf import get_logger
from app.translation.glossary import GlossaryEntry, GlossaryStore, select_for_chapter
from app.translation.provider import TranslationProvider, TranslationResult
from app.translation.style import (
    StyleProfileStore,
    build_anchor_block,
    extract_anchor_from_html,
    extract_profile_from_text,
    fetch_style_anchor,
)
from app.translation.translation_store import TranslationStore
from app.translation.wiki_lookup import WikiClient

log = get_logger("translator")

MAX_CHUNK_CHARS = 25000
PROVIDER_CHUNK_CHARS: dict[str, int] = {
    "gemini": 120_000,
    "claude": 120_000,
    "openrouter": 25_000,
    "cerebras": 25_000,
}
_P_BLOCK_RE = re.compile(r"<p\b[^>]*>.*?</p>", re.S | re.I)


def split_html_chunks(chapter_html: str, max_chars: int | None = None) -> list[str]:
    """Divide capítulos longos em blocos de <= max_chars respeitando limites de <p>."""
    limit = MAX_CHUNK_CHARS if max_chars is None else max_chars
    if len(chapter_html) <= limit:
        return [chapter_html]
    units = _P_BLOCK_RE.findall(chapter_html)
    if not units:
        units = [ln for ln in chapter_html.split("\n") if ln.strip()]
    if not units:
        return [chapter_html]

    chunks: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for u in units:
        u_len = len(u) + (1 if cur else 0)
        if cur and cur_len + u_len > limit:
            chunks.append("\n".join(cur))
            cur = [u]
            cur_len = len(u)
        else:
            cur.append(u)
            cur_len += u_len
    if cur:
        chunks.append("\n".join(cur))
    return chunks


def _infer_gender_from_pronouns(text: str) -> str | None:
    """Heuristica: conta pronomes na introducao da wiki."""
    t = " " + text.lower() + " "
    male = sum(t.count(p) for p in (" he ", " him ", " his "))
    female = sum(t.count(p) for p in (" she ", " her ", " hers "))
    if male >= 2 and male >= female * 2:
        return "male"
    if female >= 2 and female >= male * 2:
        return "female"
    return None


class Translator:
    def __init__(
        self,
        *,
        provider: TranslationProvider,
        target_language: str,
        glossary_store: GlossaryStore | None = None,
        translation_store: TranslationStore | None = None,
        wiki_client: WikiClient | None = None,
        style_store: StyleProfileStore | None = None,
        volume_title: str | None = None,
    ) -> None:
        self.provider = provider
        self.target = target_language
        self.gloss = glossary_store or GlossaryStore()
        self.trans = translation_store or TranslationStore()
        # passar wiki_client=False desliga; padrao = ativa
        self.wiki: WikiClient | None = (
            wiki_client if wiki_client is not None else WikiClient()
        )
        self.style = style_store or StyleProfileStore()
        # Volume atual — usado pra fetch do profile correto
        self._volume_title = volume_title

    def _active_provider_name(self) -> str | None:
        """Retorna o nome do provider ativo (respeitando pin e cooldown no cascade)."""
        ordered = getattr(self.provider, "_ordered_for", None)
        if callable(ordered):
            for st in ordered(self.target):
                if not st.in_cooldown():
                    return st.provider.name
        return getattr(self.provider, "name", None)

    def _chunk_limit(self) -> int:
        """Limite seguro de caracteres por chamada conforme capacidade do provider."""
        name = self._active_provider_name()
        if name and name in PROVIDER_CHUNK_CHARS:
            return PROVIDER_CHUNK_CHARS[name]
        return MAX_CHUNK_CHARS

    async def translate(
        self,
        *,
        novel_id: int,
        novel_title: str,
        novel_slug: str | None,
        chapter_index: int,
        chapter_title: str,
        chapter_html: str,
        on_chunk_progress: Callable[[int, int], None] | None = None,
        allow_chunking: bool = True,
    ) -> tuple[str, str, bool]:
        """Devolve ``(translated_title, translated_html, was_cached)``."""
        cached = self.trans.get(novel_id, chapter_index, self.target)
        if cached is not None:
            html, title = cached
            log.debug("translation_cache_hit", chapter=chapter_index)
            return title or chapter_title, html, True

        if allow_chunking:
            chunks = split_html_chunks(chapter_html, max_chars=self._chunk_limit())
            if len(chunks) > 1:
                return await self._translate_chunked(
                    novel_id=novel_id,
                    novel_title=novel_title,
                    novel_slug=novel_slug,
                    chapter_index=chapter_index,
                    chapter_title=chapter_title,
                    chunks=chunks,
                    on_chunk_progress=on_chunk_progress,
                )

        anchor_sample = fetch_style_anchor(
            novel_id=novel_id, current_chapter=chapter_index, language=self.target,
        )
        result, glossary_size = await self._translate_unit(
            novel_id=novel_id,
            novel_title=novel_title,
            novel_slug=novel_slug,
            chapter_index=chapter_index,
            chapter_title=chapter_title,
            prompt_title=chapter_title,
            html_part=chapter_html,
            anchor_sample=anchor_sample,
        )

        self.trans.save(
            novel_id=novel_id,
            chapter_index=chapter_index,
            language=self.target,
            title=result.translated_title,
            html=result.translated_html,
            model=result.model,
            glossary_size=glossary_size,
        )

        return result.translated_title or chapter_title, result.translated_html, False

    async def _translate_unit(
        self,
        *,
        novel_id: int,
        novel_title: str,
        novel_slug: str | None,
        chapter_index: int,
        chapter_title: str,
        prompt_title: str,
        html_part: str,
        anchor_sample: str | None,
        is_continuation: bool = False,
        infer_style: bool = True,
    ) -> tuple[TranslationResult, int]:
        """Executa uma chamada de tradução (capítulo inteiro ou bloco) com glossário, estilo e uso."""
        glossary = self.gloss.list_for_novel(novel_id)
        # So o que importa pra ESTE trecho vai pro prompt (o glossario inteiro nao cabe).
        relevant = select_for_chapter(glossary, f"{chapter_title}\n{html_part}")
        log.debug(
            "glossary_selected", chapter=chapter_index, total=len(glossary), sent=len(relevant)
        )

        profile = self.style.get(novel_id, self._volume_title, self.target)
        profile_block = profile.to_prompt() if profile else ""
        anchor_block = build_anchor_block(anchor_sample, is_continuation=is_continuation)

        result = await self.provider.translate_chapter(
            text_html=html_part,
            chapter_title=prompt_title,
            target_language=self.target,
            glossary=relevant,
            novel_title=novel_title,
            novel_slug=novel_slug,
            chapter_index=chapter_index,
            style_profile_block=profile_block,
            style_anchor_block=anchor_block,
        )

        if result.new_entries:
            # Enriquece personagens ambiguos com info da wiki Fandom antes de salvar.
            if self.wiki is not None and novel_slug:
                await self._enrich_with_wiki(novel_id, novel_slug, result.new_entries)
            added, updated = self.gloss.upsert_many(
                novel_id, result.new_entries, first_seen_chapter=chapter_index
            )
            log.info("glossary_grew", chapter=chapter_index, added=added, updated=updated)

        # Define style profile do volume se ainda não tem (1º cap traduzido define a "voz").
        if infer_style and profile is None:
            inferred = extract_profile_from_text(result.translated_html)
            self.style.set(
                novel_id=novel_id,
                volume_title=self._volume_title,
                language=self.target,
                profile=inferred,
            )
            log.info(
                "style_profile_extracted",
                chapter=chapter_index,
                dialog=inferred.dialog_marker,
                person=inferred.second_person,
            )

        UsageStore().record(
            op="translate_chapter",
            model=result.model,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            novel_id=novel_id,
            chapter_index=chapter_index,
        )
        return result, len(glossary)

    async def _translate_chunked(
        self,
        *,
        novel_id: int,
        novel_title: str,
        novel_slug: str | None,
        chapter_index: int,
        chapter_title: str,
        chunks: list[str],
        on_chunk_progress: Callable[[int, int], None] | None = None,
    ) -> tuple[str, str, bool]:
        """Traduz capítulos longos em blocos preservando glossário, âncora e cache parcial."""
        translated_parts: list[str] = []
        final_title: str | None = None
        last_model = ""
        total_glossary_size = 0
        rolling_anchor = fetch_style_anchor(
            novel_id=novel_id, current_chapter=chapter_index, language=self.target,
        )

        for ci, chunk_html in enumerate(chunks):
            chunk_hash = hashlib.sha256(chunk_html.encode("utf-8")).hexdigest()[:16]
            cached_chunk = self.trans.get_chunk(
                novel_id, chapter_index, self.target, ci, chunk_hash
            )
            if cached_chunk is not None:
                c_html, c_title, c_model = cached_chunk
                translated_parts.append(c_html)
                if ci == 0:
                    final_title = c_title or chapter_title
                last_model = c_model
                rolling_anchor = (
                    extract_anchor_from_html(c_html, max_paragraphs=10, max_chars=2500)
                    or rolling_anchor
                )
                if on_chunk_progress:
                    on_chunk_progress(ci + 1, len(chunks))
                continue

            prompt_title = (
                chapter_title
                if ci == 0
                else f"{final_title or chapter_title} [continuação {ci + 1}/{len(chunks)}]"
            )
            result, total_glossary_size = await self._translate_unit(
                novel_id=novel_id,
                novel_title=novel_title,
                novel_slug=novel_slug,
                chapter_index=chapter_index,
                chapter_title=chapter_title,
                prompt_title=prompt_title,
                html_part=chunk_html,
                anchor_sample=rolling_anchor,
                is_continuation=(ci > 0),
                infer_style=(ci == 0),
            )

            self.trans.save_chunk(
                novel_id=novel_id,
                chapter_index=chapter_index,
                language=self.target,
                chunk_index=ci,
                total_chunks=len(chunks),
                chunk_hash=chunk_hash,
                title=result.translated_title,
                html=result.translated_html,
                model=result.model,
            )

            if ci == 0:
                final_title = result.translated_title or chapter_title

            translated_parts.append(result.translated_html)
            last_model = result.model
            rolling_anchor = (
                extract_anchor_from_html(result.translated_html, max_paragraphs=10, max_chars=2500)
                or rolling_anchor
            )
            if on_chunk_progress:
                on_chunk_progress(ci + 1, len(chunks))

        full_html = "\n".join(translated_parts)
        self.trans.save(
            novel_id=novel_id,
            chapter_index=chapter_index,
            language=self.target,
            title=final_title or chapter_title,
            html=full_html,
            model=last_model or "cascade",
            glossary_size=total_glossary_size,
        )
        self.trans.clear_chunks(novel_id, chapter_index, self.target)
        return final_title or chapter_title, full_html, False

    async def _enrich_with_wiki(
        self,
        novel_id: int,
        novel_slug: str,
        entries: list[GlossaryEntry],
    ) -> None:
        """Busca na wiki APENAS personagens com gênero ambíguo ou baixa confiança.

        Se achar: anexa o resumo da wiki em ``notes`` e tenta inferir o gênero
        por contagem de pronomes (heurística simples mas eficaz para LitRPG).
        """
        assert self.wiki is not None
        targets = [
            e
            for e in entries
            if e.kind == "character" and (e.gender in ("unknown", "n/a") or e.confidence == "low")
        ]
        if not targets:
            return

        for entry in targets:
            info = await self.wiki.lookup(novel_id, novel_slug, entry.term)
            if not info["found"] or not info["summary"]:
                continue
            summary = info["summary"]
            inferred = _infer_gender_from_pronouns(summary)
            if inferred:
                entry.gender = inferred
                entry.confidence = "high"  # wiki + pronomes claros = confiavel
            # Anexa a info da wiki nas notes (sera vista em traducoes futuras).
            extra = f"[wiki] {summary[:300]}"
            entry.notes = (entry.notes + " " + extra).strip() if entry.notes else extra
            entry.source = "wiki"
            log.info(
                "wiki_enriched",
                term=entry.term,
                gender_inferred=inferred,
                summary_chars=len(summary),
            )
