"""Testes de guarda free-only do OpenRouter, chunking com retomada e cascade."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.api.server import create_app
from app.db.cache import ChapterCache
from app.models import NovelMeta
from app.translation.cascade import CascadeTranslator
from app.translation.glossary import GlossaryEntry
from app.translation.openai_compatible_provider import (
    OpenAICompatTranslationError,
    OpenAICompatibleProvider,
    _safe_json_parse,
    is_openrouter_free_model,
)
from app.translation.provider import TranslationProvider, TranslationResult
from app.translation.translation_store import TranslationStore
from app.translation.translator import Translator, split_html_chunks


def test_openrouter_free_model_guard_blocks_paid_models():
    assert is_openrouter_free_model("google/gemma-4-31b-it:free") is True
    assert is_openrouter_free_model("openrouter/free") is True
    assert is_openrouter_free_model("openai/gpt-4o") is False
    assert is_openrouter_free_model("anthropic/claude-3.5-sonnet") is False
    assert is_openrouter_free_model("google/lyria-3-pro-preview") is False
    assert is_openrouter_free_model("") is False

    with pytest.raises(ValueError):
        OpenAICompatibleProvider(
            provider_name="openrouter",
            api_key="dummy-key",
            model="openai/gpt-4o",
        )

    app = create_app()
    with TestClient(app) as client:
        r_bad = client.put("/api/settings", json={"openrouter_model": "openai/gpt-4o"})
        assert r_bad.status_code == 400
        r_ok = client.put("/api/settings", json={"openrouter_model": "google/gemma-4-31b-it:free"})
        assert r_ok.status_code == 200


def test_safe_json_parse_strips_think_tags():
    raw = '<think>analisando contexto...</think>\n```json\n{"translated_title":"Cap 1","translated_html":"<p>Oi</p>","new_glossary_entries":[]}\n```'
    parsed = _safe_json_parse(raw)
    assert parsed is not None
    assert parsed["translated_title"] == "Cap 1"


def test_chunked_translation_propagates_glossary_and_resumes_from_partial_cache():
    novel_id = ChapterCache().upsert_novel(
        "epub",
        "chunk-novel",
        NovelMeta(title="Chunk Novel", source_url="epub://chunk-novel", slug="chunk-novel"),
    )
    paras = [f"<p>Paragraph {i}: " + ("word " * 120) + "Echika spoke.</p>" for i in range(1, 20)]
    long_html = "\n".join(paras)
    chunks = split_html_chunks(long_html, max_chars=4000)
    assert len(chunks) >= 3

    calls: list[dict] = []
    fail_on_call = {"target": 2}

    class FakeProvider(TranslationProvider):
        name = "fake"
        model = "fake-model"

        async def translate_chapter(self, **kw) -> TranslationResult:
            calls.append(
                {
                    "title": kw["chapter_title"],
                    "glossary_terms": {e.term for e in kw["glossary"]},
                    "has_anchor": bool(kw["style_anchor_block"]),
                }
            )
            if len(calls) == fail_on_call["target"]:
                raise RuntimeError("falha simulada no meio do capitulo")
            entries = []
            if len(calls) == 1:
                entries.append(
                    GlossaryEntry(
                        term="Echika",
                        canonical_pt="Echika",
                        kind="character",
                        gender="female",
                        notes="protagonista",
                        confidence="high",
                    )
                )
            return TranslationResult(
                translated_html=kw["text_html"].replace("Paragraph", "Parágrafo"),
                translated_title="Capítulo 1: Teste",
                new_entries=entries,
                input_tokens=100,
                output_tokens=100,
                model="fake/model",
            )

    tr = Translator(
        provider=FakeProvider(),
        target_language="pt-BR",
        wiki_client=None,
    )
    tr.wiki = None  # desliga lookup de rede

    # Monkeypatch max_chars via split_html_chunks? Vamos usar MAX_CHUNK_CHARS=4000
    import app.translation.translator as tr_mod
    orig_max = tr_mod.MAX_CHUNK_CHARS
    tr_mod.MAX_CHUNK_CHARS = 4000
    try:
        # 1ª tentativa falha no chunk 2 -> chunk 1 fica salvo em cache parcial
        with pytest.raises(RuntimeError):
            asyncio.run(
                tr.translate(
                    novel_id=novel_id,
                    novel_title="Chunk Novel",
                    novel_slug="chunk-novel",
                    chapter_index=1,
                    chapter_title="Chapter 1",
                    chapter_html=long_html,
                )
            )
        assert len(calls) == 2

        # 2ª tentativa não re-traduz o chunk 1 e já injeta Echika + âncora nos próximos
        fail_on_call["target"] = 999
        title, html, cached = asyncio.run(
            tr.translate(
                novel_id=novel_id,
                novel_title="Chunk Novel",
                novel_slug="chunk-novel",
                chapter_index=1,
                chapter_title="Chapter 1",
                chapter_html=long_html,
            )
        )
    finally:
        tr_mod.MAX_CHUNK_CHARS = orig_max

    assert cached is False
    assert title == "Capítulo 1: Teste"
    assert "Parágrafo 1:" in html
    assert f"Parágrafo {len(paras)}:" in html
    # Chunk 1 não foi chamado de novo (1 call na 1a + 1 falha + restantes na 2a)
    assert len(calls) == 1 + len(chunks)
    assert "Echika" in calls[-1]["glossary_terms"]
    assert calls[-1]["has_anchor"] is True
    # Chunks parciais foram limpos após consolidação
    assert TranslationStore().get_chunk(novel_id, 1, "pt-BR", 0, "any") is None


def test_cascade_waits_short_cooldown_and_penalizes_daily_limit(monkeypatch):
    sleeps: list[float] = []

    async def fake_sleep(sec: float) -> None:
        sleeps.append(sec)

    monkeypatch.setattr("app.translation.cascade.asyncio.sleep", fake_sleep)

    class FlakyProvider(TranslationProvider):
        name = "cerebras"
        model = "gpt-oss-120b"

        def __init__(self) -> None:
            self.attempts = 0

        async def translate_chapter(self, **kw) -> TranslationResult:
            self.attempts += 1
            if self.attempts == 1:
                raise OpenAICompatTranslationError(
                    "cerebras HTTP 429: rate limit", status_code=429, retry_after_s=15.0
                )
            return TranslationResult(
                translated_html="<p>Ok</p>",
                translated_title="Cap 1",
                new_entries=[],
                input_tokens=10,
                output_tokens=10,
                model="cerebras/gpt-oss-120b",
            )

    p = FlakyProvider()
    cascade = CascadeTranslator([p])

    async def fake_sleep_advance(sec: float) -> None:
        sleeps.append(sec)
        for st in cascade._states:
            st.cooldown_until = None

    monkeypatch.setattr("app.translation.cascade.asyncio.sleep", fake_sleep_advance)
    res = asyncio.run(
        cascade.translate_chapter(
            text_html="<p>Ok</p>",
            chapter_title="Ch 1",
            target_language="pt-BR",
            glossary=[],
            novel_title="N",
        )
    )
    assert res.translated_title == "Cap 1"
    assert len(sleeps) == 1 and 14 <= sleeps[0] <= 16

    # Daily limit gera cooldown longo (600s) e não dorme
    class DailyProvider(TranslationProvider):
        name = "openrouter"
        model = "google/gemma-4-31b-it:free"

        async def translate_chapter(self, **kw) -> TranslationResult:
            raise OpenAICompatTranslationError(
                "openrouter HTTP 429: free-models-per-day exceeded", status_code=429
            )

    c2 = CascadeTranslator([DailyProvider()])
    with pytest.raises(Exception):
        asyncio.run(
            c2.translate_chapter(
                text_html="<p>x</p>",
                chapter_title="Ch 1",
                target_language="pt-BR",
                glossary=[],
                novel_title="N",
            )
        )
    assert len(sleeps) == 1  # não dormiu pelos 600s


def test_usage_store_tokens_distinct_chapters_and_model_norm():
    from app.db import models as orm
    from app.db.database import get_session
    from app.db.usage_store import UsageStore

    novel_id = ChapterCache().upsert_novel(
        "epub", "tok", NovelMeta(title="Token Novel", source_url="epub://tok", chapters=[])
    )
    us = UsageStore()
    # 3 chunks do mesmo capítulo 1 + 1 falha — devem contar como 1 capítulo traduzido
    for i in range(3):
        us.record(
            op="translate_chapter",
            model="openrouter/openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
            provider="openrouter",
            input_tokens=1000,
            output_tokens=500,
            novel_id=novel_id,
            chapter_index=1,
        )
    us.record_failure(
        op="translate_chapter",
        model="gpt-oss-120b",
        provider="cerebras",
        error_message="HTTP 429",
        novel_id=novel_id,
        chapter_index=1,
    )

    with get_session() as s:
        row = s.query(orm.GeminiUsage).filter(orm.GeminiUsage.provider == "openrouter").first()
        assert row is not None
        assert row.model == "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"

    summary = us.summary()
    assert summary["total_input_tokens"] == 3000
    assert summary["total_output_tokens"] == 1500
    assert summary["total_tokens"] == 4500
    assert summary["chapters_translated"] == 1

    by_novel = [n for n in us.by_novel() if n["novel_id"] == novel_id]
    assert len(by_novel) == 1
    assert by_novel[0]["chapters_translated"] == 1
    assert by_novel[0]["total_tokens"] == 4500

    by_prov = {p["provider"]: p for p in us.by_provider()}
    assert by_prov["openrouter"]["total_tokens"] == 4500


def test_reset_novel_pin_route_and_adaptive_chunk_and_gemini_pricing():
    from app.translation.pin_store import VolumePinStore
    from app.translation.pricing import calculate_cost

    novel_id = ChapterCache().upsert_novel(
        "epub", "pin", NovelMeta(title="Pin Novel", source_url="epub://pin", chapters=[])
    )
    VolumePinStore().set(
        novel_id=novel_id,
        volume_title="Vol 1",
        language="pt-BR",
        provider="cerebras",
        model="gpt-oss-120b",
    )
    client = TestClient(create_app())
    r = client.delete(
        f"/api/library/{novel_id}/translator-pin",
        params={"volume_title": "Vol 1", "language": "pt-BR"},
    )
    assert r.status_code == 204
    assert VolumePinStore().get(novel_id, "Vol 1", "pt-BR") is None

    # Preços Gemini 4 e 3.5 / 3.8
    assert calculate_cost("gemini-4-hydrogen", "translate_chapter", 1_000_000, 1_000_000) == pytest.approx(9.00)
    assert calculate_cost("gemini-4-neon", "translate_chapter", 1_000_000, 1_000_000) == pytest.approx(18.00)
    assert calculate_cost("gemini-4-carbon", "translate_chapter", 1_000_000, 1_000_000) == pytest.approx(24.00)
    assert calculate_cost("gemini-3.5-flash-lite", "translate_chapter", 1_000_000, 0) == pytest.approx(0.30)
    assert calculate_cost("gemini-3.8-flash", "translate_chapter", 1_000_000, 1_000_000) == pytest.approx(4.50)

    # Normaliza modelos legados salvos no DB ao retornar GET /api/settings
    from app.db.settings_store import SettingsStore as _SS
    _SS().update({"translation_model": "gemini-2.5-flash"})
    r_cfg = client.get("/api/settings")
    assert r_cfg.status_code == 200
    assert r_cfg.json()["translation_model"] == "gemini-3.5-flash-lite"

    # Chunk padrão = 25000, factory descarta providers desconhecidos de cascade_order,
    # e PUT /api/settings com "" limpa a API key salva.
    from app.db.settings_store import SettingsStore
    from app.translation.factory import build_translator
    from app.translation.translator import MAX_CHUNK_CHARS

    assert MAX_CHUNK_CHARS == 25000
    SettingsStore().update({
        "openrouter_api_key": "sk-or-v1-dummy",
        "cascade_order": "desconhecido,openrouter",
    })

    built = build_translator("pt-BR")
    names = [st.provider.name for st in built.provider._states]
    assert "desconhecido" not in names
    assert "openrouter" in names

    r_clear = client.put("/api/settings", json={"openrouter_api_key": ""})
    assert r_clear.status_code == 200
    assert r_clear.json()["openrouter_api_key_set"] is False
    assert "desconhecido" not in r_clear.json()["cascade_order"]


def test_per_provider_chunk_limits_web_no_chunk_and_continuation_anchor(monkeypatch):
    import app.translation.translator as tr_mod

    class _Stub(TranslationProvider):
        def __init__(self, name: str, model: str) -> None:
            self.name = name
            self.model = model
            self.calls: list[dict] = []

        async def translate_chapter(self, **kw) -> TranslationResult:
            self.calls.append(kw)
            # Devolve 8 parágrafos longos (~160 chars cada = ~1280 chars > 900)
            paras = "\n".join(
                f"<p>Parágrafo traduzido número {i}: " + ("texto de contexto " * 8) + "</p>"
                for i in range(1, 9)
            )
            return TranslationResult(
                translated_html=paras,
                translated_title="Cap",
                new_entries=[],
                input_tokens=10,
                output_tokens=10,
                model=f"{self.name}/{self.model}",
            )

    assert Translator(provider=_Stub("gemini", "g"), target_language="pt-BR", wiki_client=None)._chunk_limit() == 120_000
    assert Translator(provider=_Stub("claude", "c"), target_language="pt-BR", wiki_client=None)._chunk_limit() == 120_000
    assert Translator(provider=_Stub("openrouter", "o:free"), target_language="pt-BR", wiki_client=None)._chunk_limit() == 25_000
    assert Translator(provider=_Stub("cerebras", "c"), target_language="pt-BR", wiki_client=None)._chunk_limit() == 25_000
    assert Translator(provider=_Stub("other", "x"), target_language="pt-BR", wiki_client=None)._chunk_limit() == tr_mod.MAX_CHUNK_CHARS

    # 1. allow_chunking=False (fluxo web) não fatia mesmo quando excede MAX_CHUNK_CHARS
    nid = ChapterCache().upsert_novel(
        "novelfull", "web-no-chunk", NovelMeta(title="Web Novel", source_url="https://ex.com/w", chapters=[])
    )
    stub_web = _Stub("openrouter", "o:free")
    tr_web = Translator(provider=stub_web, target_language="pt-BR", wiki_client=None)
    big_html = "\n".join(f"<p>Line {i}: " + ("word " * 100) + "</p>" for i in range(60))
    assert len(big_html) > tr_mod.MAX_CHUNK_CHARS
    asyncio.run(
        tr_web.translate(
            novel_id=nid,
            novel_title="Web Novel",
            novel_slug="web-no-chunk",
            chapter_index=1,
            chapter_title="Ch 1",
            chapter_html=big_html,
            allow_chunking=False,
        )
    )
    assert len(stub_web.calls) == 1

    # 2. EPUB (allow_chunking=True) fatia e envia âncora expandida de continuação (>3 parágrafos, >900 chars)
    monkeypatch.setattr(tr_mod, "MAX_CHUNK_CHARS", 4000)
    nid_epub = ChapterCache().upsert_novel(
        "epub", "epub-anchor", NovelMeta(title="EPUB Novel", source_url="epub://epub-anchor", chapters=[])
    )
    stub_epub = _Stub("other", "x")
    tr_epub = Translator(provider=stub_epub, target_language="pt-BR", wiki_client=None)
    chunkable_html = "\n".join(f"<p>Paragraph {i}: " + ("word " * 80) + "</p>" for i in range(15))
    asyncio.run(
        tr_epub.translate(
            novel_id=nid_epub,
            novel_title="EPUB Novel",
            novel_slug="epub-anchor",
            chapter_index=1,
            chapter_title="Ch 1",
            chapter_html=chunkable_html,
            allow_chunking=True,
        )
    )
    assert len(stub_epub.calls) >= 2
    anchor2 = stub_epub.calls[1]["style_anchor_block"]
    assert "CONTEXTO IMEDIATO DO MESMO CAPÍTULO" in anchor2
    assert len(anchor2) > 900
    assert "Parágrafo traduzido número 1:" in anchor2 and "Parágrafo traduzido número 8:" in anchor2
