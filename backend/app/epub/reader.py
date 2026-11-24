"""Leitura local de arquivos .epub e armazenamento de capas locais."""

from __future__ import annotations

import hashlib
import posixpath
import re
import warnings
import zipfile
from dataclasses import dataclass
from html import escape
from pathlib import Path
from typing import Iterable

from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning
from ebooklib import ITEM_COVER, ITEM_IMAGE, epub
from slugify import slugify
from sqlalchemy import select

from app.config import settings
from app.db import models as orm
from app.db.cache import ChapterCache
from app.db.database import get_session
from app.models import ChapterContent, NovelMeta
from app.scraper.cleaner import is_spam

_BRACKET_TAG_RE = re.compile(r"\s*\[[^\]]*\]")
_SERIES_SPLIT_RE = re.compile(
    r"\s*(?:,\s*|\s+[-–—]\s+|\s+)(?:(?:EX|SP|Side\s+Story)\s*,?\s*)?"
    r"(?:vol(?:ume)?\.?\s*\d+|book\s*\d+|part\s*\d+|#\d+|v\d+)\b.*$",
    re.IGNORECASE,
)
_BOILERPLATE_TITLE_RE = re.compile(
    r"^(?:cover|title\s*page|half\s*title|copyright|table\s+of\s+contents|contents|"
    r"toc|nav|navigation|insert|color\s+insert|illustrations?|yen\s+newsletter|"
    r"newsletter|sign\s*up|colophon|credits?|books?\s+by|also\s+by|preview\s+of)\b",
    re.IGNORECASE,
)
_BOILERPLATE_STEM_RE = re.compile(
    r"^(?:cover|title|titlepage|copyright|toc|contents|nav|newsletter.*|signup.*|insert\d*)$",
    re.IGNORECASE,
)
_CHAPTER_WORD_RE = re.compile(
    r"^(?:chapter|cap[íi]tulo|prologue|pr[óo]logo|epilogue|ep[íi]logo|extra|afterword|interlude)\b",
    re.IGNORECASE,
)

_EXT_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
}
_MIME_BY_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


@dataclass(slots=True)
class EpubChapterPreview:
    index: int
    title: str
    char_count: int
    paragraph_count: int


@dataclass(slots=True)
class ParsedEpub:
    title: str
    series_name: str
    series_slug: str
    author: str | None
    description: str | None
    language: str | None
    file_hash: str
    cover_bytes: bytes | None
    cover_mime: str | None
    chapters: list[ChapterContent]
    chapter_previews: list[EpubChapterPreview]


def _normalize_quotes(text: str) -> str:
    return (
        text.replace("\u2019", "'")
        .replace("\u2018", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
    )


def extract_series_name(title: str) -> str:
    """Normaliza título e remove sufixos de volume para agrupar volumes da mesma série."""
    cleaned = _normalize_quotes(title or "")
    cleaned = _BRACKET_TAG_RE.sub("", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    series = _SERIES_SPLIT_RE.sub("", cleaned).strip(" :-–—,")
    return series or cleaned


def _detect_image_mime(data: bytes, fallback: str | None = None) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if fallback and fallback.startswith("image/"):
        return fallback
    return "image/jpeg"


def _norm_href(href: str | None) -> str:
    if not href:
        return ""
    base = href.split("#", 1)[0].strip().replace("\\", "/")
    while base.startswith("./"):
        base = base[2:]
    return base.lstrip("/")


def _flatten_toc(toc: Iterable) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for entry in toc:
        if isinstance(entry, tuple):
            sec, kids = entry
            title = (getattr(sec, "title", None) or "").strip()
            href = _norm_href(getattr(sec, "href", None))
            if href and title:
                out.append((title, href))
            out.extend(_flatten_toc(kids))
        else:
            title = (getattr(entry, "title", None) or "").strip()
            href = _norm_href(getattr(entry, "href", None))
            if href and title:
                out.append((title, href))
    return out


def _match_spine_index(href: str, spine_names: list[str]) -> int | None:
    if not href:
        return None
    for idx, name in enumerate(spine_names):
        if name == href:
            return idx
    # Fallback quando TOC omite prefixo de pasta (ex: OEBPS/ ou Text/)
    suffix = "/" + href
    for idx, name in enumerate(spine_names):
        if name.endswith(suffix):
            return idx
    base = posixpath.basename(href)
    for idx, name in enumerate(spine_names):
        if posixpath.basename(name) == base:
            return idx
    return None


def _norm_cmp(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", _normalize_quotes(text).lower()).strip()


def _extract_paragraphs_from_html(raw_bytes: bytes, chapter_title: str) -> list[str]:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
        soup = BeautifulSoup(raw_bytes, "lxml")

    for tag in soup.find_all(["script", "style", "nav", "svg"]):
        tag.decompose()
    for pb in soup.select('[role="doc-pagebreak"], [epub\\:type="pagebreak"]'):
        pb.decompose()

    body = soup.body or soup
    title_cmp = _norm_cmp(chapter_title)

    # Remove cabeçalho inicial redundante que repete o título do capítulo
    first_header = body.find(["header", "h1"])
    if first_header is not None:
        h_text = first_header.get_text(" ", strip=True)
        h_cmp = _norm_cmp(h_text)
        if not h_cmp or (
            title_cmp
            and (
                h_cmp == title_cmp
                or h_cmp in title_cmp
                or title_cmp in h_cmp
                or (_CHAPTER_WORD_RE.match(h_text) and _CHAPTER_WORD_RE.match(chapter_title))
            )
        ):
            first_header.decompose()

    paragraphs: list[str] = []
    block_tags = {"p", "blockquote", "li", "h2", "h3"}
    blocks = body.find_all(list(block_tags))
    if blocks:
        for el in blocks:
            # Evita duplicar texto de <p> dentro de <li> ou <blockquote>
            if el.find_parent(list(block_tags)) is not None:
                continue
            text = re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip()
            if not text or is_spam(text):
                continue
            if el.name in ("h2", "h3") and title_cmp and _norm_cmp(text) == title_cmp:
                continue
            paragraphs.append(text)
    else:
        raw_text = body.get_text("\n", strip=True)
        for line in raw_text.split("\n"):
            text = re.sub(r"\s+", " ", line).strip()
            if text and not is_spam(text):
                paragraphs.append(text)

    return paragraphs


def _extract_cover(book: epub.EpubBook, spine_items: list[tuple[str, epub.EpubItem]]) -> tuple[bytes | None, str | None]:
    # 1. ITEM_COVER direto
    covers = list(book.get_items_of_type(ITEM_COVER))
    if covers and covers[0].get_content():
        data = covers[0].get_content()
        return data, _detect_image_mime(data, getattr(covers[0], "media_type", None))

    # 2. OPF <meta name="cover" content="item-id">
    opf_metas = book.metadata.get("http://www.idpf.org/2007/opf", {})
    for _val, attrs in opf_metas.get("meta", []):
        if isinstance(attrs, dict) and attrs.get("name") == "cover" and attrs.get("content"):
            item = book.get_item_with_id(attrs["content"])
            if item is not None and item.get_content():
                data = item.get_content()
                return data, _detect_image_mime(data, getattr(item, "media_type", None))

    # 3. Primeira imagem dentro de um documento spine de capa
    items_by_name = {_norm_href(it.get_name()): it for it in book.get_items()}
    for name, item in spine_items:
        if "cover" not in posixpath.basename(name).lower():
            continue
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
            soup = BeautifulSoup(item.get_content(), "lxml")
        img = soup.find(["img", "image"])
        if img is not None:
            src = img.get("src") or img.get("xlink:href") or img.get("href")
            if src:
                doc_dir = posixpath.dirname(name)
                resolved = _norm_href(posixpath.normpath(posixpath.join(doc_dir, src)))
                target = items_by_name.get(resolved) or next(
                    (it for k, it in items_by_name.items() if k.endswith("/" + posixpath.basename(resolved))),
                    None,
                )
                if target is not None and target.get_content():
                    data = target.get_content()
                    return data, _detect_image_mime(data, getattr(target, "media_type", None))

    # 4. Qualquer ITEM_IMAGE com "cover" no nome
    for img_item in book.get_items_of_type(ITEM_IMAGE):
        if "cover" in (img_item.get_name() or "").lower() and img_item.get_content():
            data = img_item.get_content()
            return data, _detect_image_mime(data, getattr(img_item, "media_type", None))

    return None, None


def _is_boilerplate(title: str, names: list[str]) -> bool:
    if title and _BOILERPLATE_TITLE_RE.match(title.strip()):
        return True
    if len(names) == 1:
        stem = posixpath.splitext(posixpath.basename(names[0]))[0]
        if _BOILERPLATE_STEM_RE.match(stem):
            return True
    return False


def parse_epub(path: Path) -> ParsedEpub:
    """Lê e extrai metadados, capa e capítulos limpos de um arquivo .epub."""
    if not path.is_file():
        raise ValueError(f"Arquivo EPUB não encontrado: {path}")
    if path.suffix.lower() != ".epub" or not zipfile.is_zipfile(path):
        raise ValueError(f"Arquivo inválido (esperado .epub válido): {path.name}")

    raw_file = path.read_bytes()
    file_hash = hashlib.sha256(raw_file).hexdigest()[:16]

    try:
        book = epub.read_epub(str(path), options={"ignore_ncx": False})
    except Exception as exc:
        raise ValueError(f"Falha ao abrir EPUB '{path.name}': {exc}") from exc

    raw_title = (book.get_metadata("DC", "title") or [(None, {})])[0][0]
    if raw_title:
        title = re.sub(r"\s+", " ", _normalize_quotes(str(raw_title))).strip()
    else:
        title = re.sub(r"\s+", " ", _BRACKET_TAG_RE.sub("", path.stem)).strip() or path.stem

    raw_author = (book.get_metadata("DC", "creator") or [(None, {})])[0][0]
    author = str(raw_author).strip() if raw_author else None

    raw_desc = (book.get_metadata("DC", "description") or [(None, {})])[0][0]
    description: str | None = None
    if raw_desc:
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
            description = BeautifulSoup(str(raw_desc), "lxml").get_text(" ", strip=True) or None

    raw_lang = (book.get_metadata("DC", "language") or [(None, {})])[0][0]
    language = str(raw_lang).strip() if raw_lang else None

    series_name = extract_series_name(title)
    series_slug = slugify(series_name) or slugify(title) or "epub-novel"

    spine_items: list[tuple[str, epub.EpubItem]] = []
    for item_id, _linear in book.spine:
        item = book.get_item_with_id(item_id)
        if item is not None:
            spine_items.append((_norm_href(item.get_name()), item))
    spine_names = [name for name, _ in spine_items]

    cover_bytes, cover_mime = _extract_cover(book, spine_items)

    # Particionamento por âncoras da TOC no spine (agrupa divisórias + sub-partes)
    toc_entries = _flatten_toc(book.toc)
    anchors: list[tuple[int, str]] = []
    seen_spine: set[int] = set()
    for toc_title, toc_href in toc_entries:
        sidx = _match_spine_index(toc_href, spine_names)
        if sidx is not None and sidx not in seen_spine:
            seen_spine.add(sidx)
            anchors.append((sidx, toc_title))
    anchors.sort(key=lambda pair: pair[0])

    sections: list[tuple[str, list[tuple[str, epub.EpubItem]]]] = []
    if anchors:
        for i, (start_idx, sec_title) in enumerate(anchors):
            end_idx = anchors[i + 1][0] if i + 1 < len(anchors) else len(spine_items)
            owned = spine_items[start_idx:end_idx]
            if not _is_boilerplate(sec_title, [n for n, _ in owned]):
                sections.append((sec_title, owned))

    chapters: list[ChapterContent] = []
    previews: list[EpubChapterPreview] = []

    def _collect_section(sec_title: str, items: list[tuple[str, epub.EpubItem]]) -> None:
        all_paras: list[str] = []
        for _name, it in items:
            all_paras.extend(_extract_paragraphs_from_html(it.get_content(), sec_title))
        if not all_paras:
            return
        idx = len(chapters) + 1
        html_body = "\n".join(f"<p>{escape(p)}</p>" for p in all_paras)
        char_count = sum(len(p) for p in all_paras)
        chapters.append(
            ChapterContent(
                index=idx,
                title=sec_title,
                html=html_body,
                url=f"epub://{file_hash}/{idx}",
            )
        )
        previews.append(
            EpubChapterPreview(
                index=idx,
                title=sec_title,
                char_count=char_count,
                paragraph_count=len(all_paras),
            )
        )

    for sec_title, owned in sections:
        _collect_section(sec_title, owned)

    # Fallback se TOC estava vazia ou não mapeou nenhum capítulo com texto
    if not chapters:
        for name, item in spine_items:
            if _is_boilerplate("", [name]):
                continue
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
                soup = BeautifulSoup(item.get_content(), "lxml")
            h = soup.find(["h1", "h2", "h3", "title"])
            sec_title = h.get_text(" ", strip=True) if h else ""
            if not sec_title:
                sec_title = f"Capítulo {len(chapters) + 1}"
            if _is_boilerplate(sec_title, [name]):
                continue
            _collect_section(sec_title, [(name, item)])

    if not chapters:
        raise ValueError(f"Nenhum capítulo com texto encontrado em '{path.name}'")

    return ParsedEpub(
        title=title,
        series_name=series_name,
        series_slug=series_slug,
        author=author,
        description=description,
        language=language,
        file_hash=file_hash,
        cover_bytes=cover_bytes,
        cover_mime=cover_mime,
        chapters=chapters,
        chapter_previews=previews,
    )


# ------------------------------------------------------------- capas locais

def _cover_dir(novel_id: int) -> Path:
    return settings.data_dir / "epub_covers" / str(novel_id)


def save_local_epub_cover(
    novel_id: int, volume_title: str | None, data: bytes, mime: str
) -> None:
    """Salva capa extraída de um EPUB em disco (por volume + default da série)."""
    folder = _cover_dir(novel_id)
    folder.mkdir(parents=True, exist_ok=True)
    ext = _EXT_BY_MIME.get(mime, ".jpg")
    vol_key = slugify(volume_title or "") or "default"
    (folder / f"{vol_key}{ext}").write_bytes(data)
    if not any(folder.glob("default.*")):
        (folder / f"default{ext}").write_bytes(data)


def load_local_epub_cover(
    novel_id: int, volume_title: str | None = None
) -> tuple[bytes, str] | None:
    """Carrega capa local salva para o volume (ou fallback 'default' da novel)."""
    folder = _cover_dir(novel_id)
    if not folder.is_dir():
        return None
    candidates = []
    if volume_title:
        vol_key = slugify(volume_title)
        if vol_key:
            candidates.append(vol_key)
    candidates.append("default")

    for stem in candidates:
        for ext, mime in _MIME_BY_EXT.items():
            p = folder / f"{stem}{ext}"
            if p.is_file():
                return p.read_bytes(), mime
    # Último fallback: qualquer imagem na pasta
    for p in sorted(folder.iterdir()):
        mime = _MIME_BY_EXT.get(p.suffix.lower())
        if mime and p.is_file():
            return p.read_bytes(), mime
    return None


def import_epub_to_cache(
    path: Path,
    *,
    novel_id: int | None = None,
    series_title: str | None = None,
    volume_title: str | None = None,
) -> dict:
    """Importa capítulos e capa de um .epub local para o SQLite cache (idempotente)."""
    parsed = parse_epub(path)
    cache = ChapterCache()

    if novel_id is not None:
        novel = cache.get_novel(novel_id)
        if novel is None:
            raise ValueError(f"Novel {novel_id} não encontrada na biblioteca")
        effective_series = novel["title"]
        source_url = novel["source_url"]
    else:
        effective_series = (series_title or parsed.series_name).strip() or parsed.title
        slug = slugify(effective_series) or parsed.series_slug
        source_url = f"epub://{slug}"
        novel_id = cache.upsert_novel(
            "epub",
            slug,
            NovelMeta(
                title=effective_series,
                author=parsed.author,
                description=parsed.description,
                source_url=source_url,
                cover_url=None,
                slug=slug,
            ),
        )

    # Idempotência: se o mesmo arquivo (file_hash) já foi importado nesta novel, reutiliza indices
    url_prefix = f"epub://{parsed.file_hash}/%"
    with get_session() as s:
        existing_indices = s.scalars(
            select(orm.Chapter.index).where(
                orm.Chapter.novel_id == novel_id,
                orm.Chapter.url.like(url_prefix),
            )
        ).all()

    if existing_indices:
        offset = min(existing_indices) - 1
        reused = True
    else:
        offset = max(cache.cached_indices(novel_id), default=0)
        reused = False

    for ch in parsed.chapters:
        cache.save_chapter(
            novel_id,
            ChapterContent(
                index=offset + ch.index,
                title=ch.title,
                html=ch.html,
                url=ch.url,
            ),
        )

    effective_vol_title = (volume_title or parsed.title).strip() or parsed.title
    if parsed.cover_bytes:
        save_local_epub_cover(
            novel_id,
            effective_vol_title,
            parsed.cover_bytes,
            parsed.cover_mime or "image/jpeg",
        )
        with get_session() as s:
            row = s.get(orm.Novel, novel_id)
            if row is not None and not row.cover_url:
                row.cover_url = f"/api/library/{novel_id}/cover"
                s.commit()

    return {
        "novel_id": novel_id,
        "source_url": source_url,
        "series_title": effective_series,
        "volume_title": effective_vol_title,
        "start": offset + 1,
        "end": offset + len(parsed.chapters),
        "chapter_count": len(parsed.chapters),
        "reused_existing": reused,
    }
