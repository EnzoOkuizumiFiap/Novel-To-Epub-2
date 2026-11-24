"""Tabela de precos da Gemini API (USD).

Fonte: https://ai.google.dev/gemini-api/docs/pricing (mai 2026).
Valores em USD por 1M de tokens, exceto imagens que cobram por unidade.

Quando aparecer modelo novo nao mapeado, retorna 0 e loga warning (nao quebra
fluxo — so esmaece o numero do dashboard).
"""

from __future__ import annotations

from app.logging_conf import get_logger

log = get_logger("pricing")

# (input_usd_per_1m, output_usd_per_1m) — pra modelos por-token.
# Chaves aceitam tanto o modelo "puro" quanto com prefix "provider/modelo".
_TEXT_PRICES: dict[str, tuple[float, float]] = {
    # Gemini (Google)
    "gemini-4-hydrogen": (1.50, 7.50),
    "gemini-4-neon": (3.00, 15.00),
    "gemini-4-carbon": (4.00, 20.00),  # intro $2.00/$10.00 até 30/11/2026
    "gemini-3.8-flash": (0.75, 3.75),
    "gemini-3.5-flash-lite": (0.30, 2.50),
    # OpenRouter free models (sufixo :free)
    "google/gemma-4-31b-it:free": (0.0, 0.0),
    "google/gemma-4-26b-a4b-it:free": (0.0, 0.0),
    "nvidia/nemotron-3-ultra-550b-a55b:free": (0.0, 0.0),
    "nvidia/nemotron-3.5-super-vl:free": (0.0, 0.0),
    "baidu/ernie-5.5-flash-preview:free": (0.0, 0.0),
    "inclusionai/ling-3.2-flash:free": (0.0, 0.0),
    "openrouter/free": (0.0, 0.0),
    # Claude (Anthropic, API 1st-party; USD por 1M tokens). Cache: leitura ~0,1x e
    # escrita ~1,25x do input — o dashboard conta tudo como input normal, entao
    # o custo exibido fica um pouco ACIMA do real quando o cache acerta.
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),  # prompts ate 100k tokens
    "claude-opus-4-8": (5.00, 25.00),  # possivel destino do fallback de recusa
    "claude-opus-5": (5.00, 25.00),
    "claude-sonnet-5": (2.00, 10.00),
    # Cerebras (free generoso)
    "gpt-oss-120b": (0.0, 0.0),
}

# Modelos cobrados por imagem gerada (token count e irrelevante)
_IMAGE_PRICES: dict[str, float] = {
    "gemini-2.5-flash-image": 0.039,  # $0.039/image (1024px)
}


def _normalize_model(model: str) -> str:
    """Tira prefix 'provider/' se presente, mas mantem sufixo ':free'."""
    return model.split("/", 1)[-1] if "/" in model else model


def calculate_cost(
    model: str, op: str, input_tokens: int, output_tokens: int,
) -> float:
    """Devolve custo em USD pra uma chamada. 0.0 se modelo desconhecido."""
    if op == "cover_image":
        price = _IMAGE_PRICES.get(model) or _IMAGE_PRICES.get(_normalize_model(model))
        if price is None:
            log.warning("pricing_unknown_image_model", model=model)
            return 0.0
        return price
    # Modelos ':free' (ex: OpenRouter) sao sempre gratuitos
    norm = _normalize_model(model)
    if model.endswith(":free") or norm in ("openrouter/free", "free"):
        return 0.0
    # Tenta exato (com prefix) primeiro, depois normalizado
    prices = _TEXT_PRICES.get(model) or _TEXT_PRICES.get(norm)
    if prices is None:
        log.warning("pricing_unknown_text_model", model=model)
        return 0.0
    in_usd = (input_tokens / 1_000_000) * prices[0]
    out_usd = (output_tokens / 1_000_000) * prices[1]
    return round(in_usd + out_usd, 6)
