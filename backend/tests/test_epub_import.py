"""Testes do leitor de EPUB local, compartilhamento de série e rotas /api/epub/*."""

from __future__ import annotations

import asyncio
from pathlib import Path

from ebooklib import epub
from fastapi.testclient import TestClient

from app.api.server import create_app
from app.db.cache import ChapterCache
from app.db.volume_store import VolumeStore
from app.epub.reader import extract_series_name, import_epub_to_cache, parse_epub
from app.rebuild import rebuild_volume_epub

_PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc`\x00\x00"
    b"\x00\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _make_sample_epub(
    path: Path,
    *,
    title: str,
    chapters: list[tuple[str, str]],
    split_divider: bool = False,
) -> Path:
    book = epub.EpubBook()
    book.set_identifier(f"id-{title}")
    book.set_title(title)
    book.set_language("en")
    book.add_author("Test Author")
    book.set_cover("images/cover.png", _PNG_1X1, create_page=False)

    copy_item = epub.EpubHtml(title="Copyright", file_name="Text/copyright.xhtml", lang="en")
    copy_item.content = "<html><body><h1>Copyright</h1><p>All rights reserved.</p></body></html>"
    book.add_item(copy_item)

    spine = ["nav", copy_item]
    toc = [epub.Link("Text/copyright.xhtml", "Copyright", "copy")]

    for idx, (ctitle, cbody) in enumerate(chapters, start=1):
        if split_divider:
            div = epub.EpubHtml(title=ctitle, file_name=f"Text/part{idx}.xhtml", lang="en")
            div.content = f'<html><body><img src="../images/cover.png" alt="{ctitle}"/></body></html>'
            part_a = epub.EpubHtml(title=ctitle, file_name=f"Text/chap{idx}_a.xhtml", lang="en")
            part_a.content = f"<html><body><h1>{ctitle}</h1><p>{cbody} part A.</p></body></html>"
            part_b = epub.EpubHtml(title="", file_name=f"Text/chap{idx}_b.xhtml", lang="en")
            part_b.content = f"<html><body><p>{cbody} part B.</p></body></html>"
            book.add_item(div)
            book.add_item(part_a)
            book.add_item(part_b)
            spine.extend([div, part_a, part_b])
            toc.append(epub.Link(f"Text/part{idx}.xhtml", ctitle, f"ch{idx}"))
        else:
            item = epub.EpubHtml(title=ctitle, file_name=f"chap{idx}.xhtml", lang="en")
            item.content = f"<html><body><h1>{ctitle}</h1><p>{cbody}</p></body></html>"
            book.add_item(item)
            spine.append(item)
            toc.append(epub.Link(f"chap{idx}.xhtml", ctitle, f"ch{idx}"))

    news = epub.EpubHtml(title="Yen Newsletter", file_name="Text/newsletter.xhtml", lang="en")
    news.content = "<html><body><p>Sign up for Yen Press newsletter!</p></body></html>"
    book.add_item(news)
    spine.append(news)
    toc.append(epub.Link("Text/newsletter.xhtml", "Yen Newsletter", "news"))

    book.toc = tuple(toc)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = spine
    epub.write_epub(str(path), book)
    return path


def test_extract_series_name_groups_all_volume_variants():
    akira_titles = [
        "Associate Professor Akira Takatsuki’s Conjecture EX, Vol. 1",
        "Associate Professor Akira Takatsuki’s Conjecture, Vol. 2: The Supernatural Hides in the Cracks",
        "Associate Professor Akira Takatsuki's Conjecture - Volume 7",
    ]
    assert len({extract_series_name(t) for t in akira_titles}) == 1
    assert extract_series_name(akira_titles[0]) == "Associate Professor Akira Takatsuki's Conjecture"

    yf_titles = [
        "Your Forma, Vol.1: Electronic Investigator Echika",
        "Your Forma, Vol. 7: Electronic Investigator Echika and Discord",
    ]
    assert {extract_series_name(t) for t in yf_titles} == {"Your Forma"}


def test_parse_epub_handles_split_divider_and_skips_boilerplate(tmp_path):
    p = _make_sample_epub(
        tmp_path / "yf1.epub",
        title="Your Forma, Vol. 1: Amicus",
        chapters=[("Prologue: Blizzard", "Cold snow"), ("Chapter 1: Awakening", "Echika woke up")],
        split_divider=True,
    )
    parsed = parse_epub(p)
    assert parsed.series_slug == "your-forma"
    assert parsed.cover_bytes == _PNG_1X1
    assert len(parsed.chapters) == 2
    assert parsed.chapters[0].title == "Prologue: Blizzard"
    assert "<p>Cold snow part A.</p>" in parsed.chapters[0].html
    assert "<p>Cold snow part B.</p>" in parsed.chapters[0].html
    assert parsed.chapters[1].title == "Chapter 1: Awakening"


def test_multi_volume_import_shares_novel_id_and_is_idempotent(tmp_path):
    p1 = _make_sample_epub(
        tmp_path / "vol1.epub",
        title="My Series, Vol. 1",
        chapters=[("Chapter 1", "First vol ch 1"), ("Chapter 2", "First vol ch 2")],
    )
    p2 = _make_sample_epub(
        tmp_path / "vol2.epub",
        title="My Series, Vol. 2",
        chapters=[("Chapter 1", "Second vol ch 1")],
    )

    info1 = import_epub_to_cache(p1)
    assert info1["start"] == 1 and info1["end"] == 2
    info1_again = import_epub_to_cache(p1, novel_id=info1["novel_id"])
    assert info1_again["reused_existing"] is True
    assert info1_again["start"] == 1 and info1_again["end"] == 2

    info2 = import_epub_to_cache(p2, novel_id=info1["novel_id"])
    assert info2["novel_id"] == info1["novel_id"]
    assert info2["reused_existing"] is False
    assert info2["start"] == 3 and info2["end"] == 3
    assert ChapterCache().get_novel(info1["novel_id"])["chapters"] == 3


def test_epub_api_upload_preview_import_cover_and_rebuild(tmp_path, monkeypatch):
    app = create_app()
    src = _make_sample_epub(
        tmp_path / "test_book.epub",
        title="Your Forma, Vol. 1",
        chapters=[("Chapter 1", "Hello world"), ("Chapter 2", "Second chapter")],
    )

    with TestClient(app) as client:
        # Upload binário
        up = client.post(
            "/api/epub/upload",
            content=src.read_bytes(),
            headers={"X-Filename": "Your Forma Vol 1.epub"},
        )
        assert up.status_code == 200
        uploaded_path = up.json()["file_path"]

        # Preview
        prev = client.post("/api/epub/preview", json={"file_path": uploaded_path})
        assert prev.status_code == 200
        pdata = prev.json()
        assert pdata["series_name"] == "Your Forma"
        assert pdata["total_chapters"] == 2
        assert pdata["cover_data_url"].startswith("data:image/png;base64,")

        # Enqueue import (sem tradução pra testar pipeline rápido em memória)
        imp = client.post(
            "/api/epub/import",
            json={
                "file_path": uploaded_path,
                "translate_to": None,
                "with_cover": True,
            },
        )
        assert imp.status_code == 201
        assert not Path(uploaded_path).exists()
        job_id = imp.json()["id"]

        # Aguarda job terminar
        import time
        for _ in range(50):
            st = client.get(f"/api/downloads/{job_id}").json()
            if st["status"] in ("done", "error"):
                break
            time.sleep(0.05)
        assert st["status"] == "done", st
        vid = st["volume_id"]
        novel_id = VolumeStore().get(vid)["novel_id"]

        # Rota da capa local
        cov = client.get(f"/api/library/{novel_id}/cover")
        assert cov.status_code == 200
        assert cov.content == _PNG_1X1

        # Rebuild preserva capa local
        rebuilt = asyncio.run(rebuild_volume_epub(vid))
        assert rebuilt.exists()
