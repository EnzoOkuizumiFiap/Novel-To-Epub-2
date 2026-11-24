"""Fabrica de Translator: monta cascade de providers a partir das settings."""

from __future__ import annotations

import os

from app.db.settings_store import SettingsStore
from app.gemini_client import vertex_cfg
from app.logging_conf import get_logger
from app.translation.cascade import CascadeTranslator
from app.translation.claude_provider import DEFAULT_MODEL as CLAUDE_DEFAULT_MODEL
from app.translation.claude_provider import ClaudeProvider
from app.translation.gemini_provider import GeminiProvider
from app.translation.openai_compatible_provider import (
    PROVIDER_BASE_URLS,
    OpenAICompatibleProvider,
)
from app.translation.provider import TranslationProvider
from app.translation.translator import Translator

log = get_logger("factory")


class TranslationConfigError(RuntimeError):
    """Faltam credenciais ou config p/ traduzir."""


# Modelos default por provider (modelo "principal" de cada).
# Usuario pode sobrescrever via settings.<provider>_model (futuro).
DEFAULT_MODELS: dict[str, str] = {
    # OpenRouter: Nemotron 3 Ultra 550B free (1M ctx, suporte oficial PT-BR, disponível sem 429)
    "openrouter": "nvidia/nemotron-3-ultra-550b-a55b:free",
    # Cerebras: llama-3.3-70b foi DECOMISSIONADO; gpt-oss-120b é o substituto
    # oficial recomendado por eles (https://inference-docs.cerebras.ai/support/deprecation)
    "cerebras": "gpt-oss-120b",
    "gemini": "gemini-3.5-flash-lite",
    # Claude (API da Anthropic, pago por token — ver translation/pricing.py)
    "claude": CLAUDE_DEFAULT_MODEL,
}

# Todos os providers conhecidos. Um provider novo que ainda nao esta no
# cascade_order salvo entra no FIM — so vira fallback ate o usuario reordenar.
KNOWN_PROVIDERS = ["openrouter", "cerebras", "gemini", "claude"]


def with_known_providers(order: list[str]) -> list[str]:
    cleaned = [p for p in order if p in KNOWN_PROVIDERS]
    return cleaned + [p for p in KNOWN_PROVIDERS if p not in cleaned]


def _read_keys(cfg: dict) -> dict[str, str | None]:
    """Lê todas as keys de provider (env tem prioridade sobre DB)."""
    return {
        "gemini": (
            os.environ.get("GEMINI_API_KEY")
            or os.environ.get("GOOGLE_API_KEY")
            or cfg.get("gemini_api_key")
        ),
        "openrouter": (
            os.environ.get("OPENROUTER_API_KEY") or cfg.get("openrouter_api_key")
        ),
        "cerebras": os.environ.get("CEREBRAS_API_KEY") or cfg.get("cerebras_api_key"),
        "claude": os.environ.get("ANTHROPIC_API_KEY") or cfg.get("claude_api_key"),
    }


# Modelo pro qual o Gemini ESCALA quando o primário (Flash) bate guardrail de
# conteúdo. Pro às vezes passa onde o Flash bloqueia. Se o usuário já escolheu o
# Pro como principal, não há pra onde escalar (_gemini_escalation devolve None).
_GEMINI_ESCALATION_MODEL = "gemini-4-neon"


def _gemini_escalation(primary_model: str) -> str | None:
    """Modelo intermediário como fallback de bloqueio — exceto se o primário já for topo de linha."""
    low = primary_model.lower()
    if any(tok in low for tok in ("carbon", "neon", "pro")):
        return None
    return _GEMINI_ESCALATION_MODEL


def _build_provider(name: str, key: str, model: str | None) -> TranslationProvider:
    model = model or DEFAULT_MODELS[name]
    if name == "gemini":
        return GeminiProvider(
            api_key=key, model=model, escalation_model=_gemini_escalation(model)
        )
    if name == "claude":
        return ClaudeProvider(api_key=key, model=model)
    if name in PROVIDER_BASE_URLS:
        return OpenAICompatibleProvider(provider_name=name, api_key=key, model=model)
    raise TranslationConfigError(f"provider desconhecido: {name}")


def build_translator(
    target_language: str,
    *,
    novel_id: int | None = None,
    volume_title: str | None = None,
) -> Translator:
    """Monta cascade a partir das settings.

    Ordem efetiva = cascade_order do settings, com providers SEM key descartados.
    Se nenhum provider configurado → erro cedo. Pelo menos 1 key precisa estar setada.
    """
    cfg = SettingsStore().get()
    keys = _read_keys(cfg)
    vtx_use, vtx_project, vtx_location, vtx_creds = vertex_cfg(cfg)

    # Ordem do cascade vem do settings (lista de nomes); fallback default
    raw_order = cfg.get("cascade_order")
    if isinstance(raw_order, str):
        # CSV no DB
        order = [p.strip() for p in raw_order.split(",") if p.strip()]
    elif isinstance(raw_order, list):
        order = list(raw_order)
    else:
        # Default: free primeiro, paid último
        order = ["openrouter", "cerebras", "gemini", "claude"]
    order = with_known_providers(order)

    providers: list[TranslationProvider] = []
    skipped: list[str] = []
    for name in order:
        key = keys.get(name)
        # Gemini em modo Vertex usa ADC (sem API key) — nao pode ser pulado por
        # falta de key; os demais providers ainda exigem key.
        gemini_vertex = name == "gemini" and vtx_use
        if not key and not gemini_vertex:
            skipped.append(name)
            continue
        # O modelo do gemini vem de `translation_model` (campo "modelo principal"
        # da UI); os demais providers usam `<name>_model`.
        model_key = "translation_model" if name == "gemini" else f"{name}_model"
        model = cfg.get(model_key)  # opcional
        try:
            if gemini_vertex:
                gem_model = model or DEFAULT_MODELS["gemini"]
                providers.append(
                    GeminiProvider(
                        model=gem_model,
                        escalation_model=_gemini_escalation(gem_model),
                        use_vertex=True,
                        project=vtx_project,
                        location=vtx_location,
                        credentials_path=vtx_creds,
                    )
                )
            else:
                providers.append(_build_provider(name, key, model))
        except Exception as exc:
            log.warning("provider_build_failed", provider=name, error=str(exc))
            skipped.append(name)

    if not providers:
        raise TranslationConfigError(
            "nenhum provider configurado — adicione pelo menos 1 API key em /api/settings "
            f"(OpenRouter/Cerebras/Gemini/Claude). Skipped: {skipped}"
        )

    log.info(
        "cascade_built",
        active=[p.name for p in providers], skipped=skipped,
        novel_id=novel_id, volume_title=volume_title,
    )

    # Se só 1 provider configurado, podemos usar ele direto (sem overhead do cascade).
    # Mas como o cascade já trata pin e cooldown bonitinho, deixamos sempre.
    cascade = CascadeTranslator(providers, novel_id=novel_id, volume_title=volume_title)
    return Translator(
        provider=cascade,
        target_language=target_language,
        volume_title=volume_title,
    )
