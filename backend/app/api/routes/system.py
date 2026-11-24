"""Saude, sites suportados e configuracoes do app."""

from __future__ import annotations


from fastapi import APIRouter, HTTPException

from app import __version__
from app.api.schemas import (
    SettingsOut,
    SettingsUpdate,
    SiteInfo,
)
from app.db.settings_store import SettingsStore
from app.translation.factory import with_known_providers
from app.translation.openai_compatible_provider import is_openrouter_free_model
from app.scraper.registry import registry

router = APIRouter()


_VALID_GEMINI_MODELS = {
    "gemini-4-hydrogen",
    "gemini-4-neon",
    "gemini-4-carbon",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
}


def _normalize_gemini_model(raw: str | None) -> str:
    if raw and raw in _VALID_GEMINI_MODELS:
        return raw
    return "gemini-3.5-flash-lite"


def _settings_out(cfg: dict) -> SettingsOut:
    raw_order = cfg.get("cascade_order") or "openrouter,cerebras,gemini,claude"
    raw_list = (
        [p.strip() for p in raw_order.split(",") if p.strip()]
        if isinstance(raw_order, str)
        else list(raw_order)
    )
    order = with_known_providers(raw_list)
    raw_styles = cfg.get("cover_styles_enabled") or ""
    cover_styles = (
        [s.strip() for s in raw_styles.split(",") if s.strip()]
        if isinstance(raw_styles, str)
        else list(raw_styles)
    )
    return SettingsOut(
        smtp_host=cfg["smtp_host"],
        smtp_port=cfg["smtp_port"],
        smtp_user=cfg["smtp_user"],
        smtp_password_set=bool(cfg["smtp_password"]),
        smtp_use_tls=cfg["smtp_use_tls"],
        smtp_from=cfg["smtp_from"],
        kindle_email=cfg["kindle_email"],
        gemini_api_key_set=bool(cfg.get("gemini_api_key")),
        target_language=cfg.get("target_language") or "pt-BR",
        translation_model=_normalize_gemini_model(cfg.get("translation_model")),
        openrouter_api_key_set=bool(cfg.get("openrouter_api_key")),
        cerebras_api_key_set=bool(cfg.get("cerebras_api_key")),
        claude_api_key_set=bool(cfg.get("claude_api_key")),
        openrouter_model=cfg.get("openrouter_model") or None,
        cerebras_model=cfg.get("cerebras_model") or None,
        claude_model=cfg.get("claude_model") or None,
        cover_brief_provider=cfg.get("cover_brief_provider") or "gemini",
        default_models=_provider_defaults(),
        cascade_order=order,
        cover_styles_enabled=cover_styles,
        gemini_use_vertex=bool(cfg.get("gemini_use_vertex")),
        gemini_vertex_project=cfg.get("gemini_vertex_project") or None,
        gemini_vertex_location=cfg.get("gemini_vertex_location") or "us-central1",
        gemini_vertex_credentials_set=bool(cfg.get("gemini_vertex_credentials_path")),
    )


def _provider_defaults() -> dict[str, str]:
    """Espelha factory.DEFAULT_MODELS pra UI mostrar como placeholder."""
    from app.translation.factory import DEFAULT_MODELS
    return dict(DEFAULT_MODELS)


@router.get("/health")
def health() -> dict:
    return {"status": "ok", "version": __version__}


@router.get("/sites", response_model=list[SiteInfo])
def sites() -> list[SiteInfo]:
    return [SiteInfo(name=c.name, domains=c.domains) for c in registry.adapters]


@router.get("/settings", response_model=SettingsOut)
def get_settings() -> SettingsOut:
    return _settings_out(SettingsStore().get())


@router.put("/settings", response_model=SettingsOut)
def update_settings(body: SettingsUpdate) -> SettingsOut:
    payload = body.model_dump(exclude_unset=True)
    if payload.get("openrouter_model") and not is_openrouter_free_model(
        payload["openrouter_model"]
    ):
        raise HTTPException(
            status_code=400,
            detail="OpenRouter permite apenas modelos gratuitos (terminados em ':free' ou 'openrouter/free').",
        )
    # cascade_order chega como lista no JSON, serializa pra CSV no DB
    if "cascade_order" in payload and isinstance(payload["cascade_order"], list):
        payload["cascade_order"] = ",".join(with_known_providers(payload["cascade_order"]))
    # Permite limpar uma key enviando string vazia "" (normaliza para None)
    for key_field in (
        "gemini_api_key",
        "openrouter_api_key",
        "cerebras_api_key",
        "claude_api_key",
    ):
        if key_field in payload and payload[key_field] == "":
            payload[key_field] = None
    # cover_styles_enabled idem: lista de ids → CSV
    if "cover_styles_enabled" in payload and isinstance(payload["cover_styles_enabled"], list):
        payload["cover_styles_enabled"] = ",".join(payload["cover_styles_enabled"])
    cfg = SettingsStore().update(payload)
    return _settings_out(cfg)
