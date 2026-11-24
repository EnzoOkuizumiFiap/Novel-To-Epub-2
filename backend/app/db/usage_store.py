"""Storage de chamadas pagas ao Gemini (cap, capa, brief)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, select

from app.db import models as orm
from app.db.database import get_session, init_db
from app.translation.pricing import calculate_cost


class UsageStore:
    def __init__(self) -> None:
        init_db()

    def record(
        self,
        *,
        op: str,
        model: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        novel_id: int | None = None,
        chapter_index: int | None = None,
        provider: str | None = None,
    ) -> float:
        """Registra uma chamada e devolve o custo em USD calculado."""
        # Infere provider se nao explicito (model "openrouter/..." → "openrouter")
        if provider is None:
            if "/" in model:
                provider = model.split("/", 1)[0]
            elif model.startswith("gemini"):
                provider = "gemini"
        cost = calculate_cost(model, op, input_tokens, output_tokens)
        stored_model = model
        if provider and stored_model.startswith(f"{provider}/{provider}/"):
            stored_model = stored_model[len(provider) + 1 :]
        with get_session() as s:
            row = orm.GeminiUsage(
                op=op, model=stored_model, provider=provider,
                input_tokens=input_tokens, output_tokens=output_tokens,
                cost_usd=cost, novel_id=novel_id, chapter_index=chapter_index,
                error_message=None,  # sucesso
            )
            s.add(row)
            s.commit()
        return cost

    def record_failure(
        self,
        *,
        op: str,
        model: str,
        provider: str,
        error_message: str,
        novel_id: int | None = None,
        chapter_index: int | None = None,
    ) -> None:
        """Registra TENTATIVA de chamada que falhou — cost=0, tokens=0.

        Aparece no Diagnóstico ajudando o user a descobrir POR QUE um provider
        está caindo no cascade (modelo errado, schema fail, 4xx, etc).
        """
        with get_session() as s:
            row = orm.GeminiUsage(
                op=op, model=model, provider=provider,
                input_tokens=0, output_tokens=0, cost_usd=0.0,
                novel_id=novel_id, chapter_index=chapter_index,
                error_message=error_message[:500],  # cap pra não inflar DB
            )
            s.add(row)
            s.commit()

    # ----------------------------------------------------------- queries

    def summary(self) -> dict:
        """Totais globais + dos ultimos 30 dias (custos e tokens)."""
        with get_session() as s:
            total_usd = s.scalar(select(func.coalesce(func.sum(orm.GeminiUsage.cost_usd), 0))) or 0
            total_ops = s.scalar(select(func.count(orm.GeminiUsage.id))) or 0
            total_in = s.scalar(select(func.coalesce(func.sum(orm.GeminiUsage.input_tokens), 0))) or 0
            total_out = s.scalar(select(func.coalesce(func.sum(orm.GeminiUsage.output_tokens), 0))) or 0
            distinct_chaps = (
                select(
                    orm.GeminiUsage.novel_id,
                    func.coalesce(orm.GeminiUsage.chapter_index, -orm.GeminiUsage.id).label("chap_key"),
                )
                .where(
                    orm.GeminiUsage.op == "translate_chapter",
                    orm.GeminiUsage.error_message.is_(None),
                )
                .distinct()
                .subquery()
            )
            chap_ops = s.scalar(select(func.count()).select_from(distinct_chaps)) or 0
            covers = s.scalar(
                select(func.count(orm.GeminiUsage.id)).where(
                    orm.GeminiUsage.op == "cover_image",
                    orm.GeminiUsage.error_message.is_(None),
                )
            ) or 0
            cutoff_30 = datetime.now(timezone.utc) - timedelta(days=30)
            last_30 = s.scalar(
                select(func.coalesce(func.sum(orm.GeminiUsage.cost_usd), 0))
                .where(orm.GeminiUsage.created_at >= cutoff_30)
            ) or 0
            last_30_tokens = s.scalar(
                select(
                    func.coalesce(
                        func.sum(orm.GeminiUsage.input_tokens + orm.GeminiUsage.output_tokens), 0
                    )
                ).where(orm.GeminiUsage.created_at >= cutoff_30)
            ) or 0
            cutoff_7 = datetime.now(timezone.utc) - timedelta(days=7)
            last_7 = s.scalar(
                select(func.coalesce(func.sum(orm.GeminiUsage.cost_usd), 0))
                .where(orm.GeminiUsage.created_at >= cutoff_7)
            ) or 0
            last_7_tokens = s.scalar(
                select(
                    func.coalesce(
                        func.sum(orm.GeminiUsage.input_tokens + orm.GeminiUsage.output_tokens), 0
                    )
                ).where(orm.GeminiUsage.created_at >= cutoff_7)
            ) or 0
            avg_per_chapter = (
                float(s.scalar(
                    select(func.coalesce(func.avg(orm.GeminiUsage.cost_usd), 0))
                    .where(orm.GeminiUsage.op == "translate_chapter")
                ) or 0)
            )
        return {
            "total_usd": float(total_usd),
            "total_ops": int(total_ops),
            "chapters_translated": int(chap_ops),
            "covers_generated": int(covers),
            "last_30d_usd": float(last_30),
            "last_7d_usd": float(last_7),
            "avg_per_chapter_usd": avg_per_chapter,
            "total_input_tokens": int(total_in),
            "total_output_tokens": int(total_out),
            "total_tokens": int(total_in) + int(total_out),
            "last_30d_tokens": int(last_30_tokens),
            "last_7d_tokens": int(last_7_tokens),
        }

    def by_day(self, days: int = 30) -> list[dict]:
        """Custo e tokens por dia (UTC), zero-fill nos dias sem uso pra grafico ficar continuo."""
        cutoff = datetime.now(timezone.utc) - timedelta(days=days - 1)
        with get_session() as s:
            rows = s.execute(
                select(
                    func.date(orm.GeminiUsage.created_at).label("day"),
                    func.sum(orm.GeminiUsage.cost_usd).label("usd"),
                    func.count(orm.GeminiUsage.id).label("ops"),
                    func.coalesce(func.sum(orm.GeminiUsage.input_tokens), 0).label("in_tok"),
                    func.coalesce(func.sum(orm.GeminiUsage.output_tokens), 0).label("out_tok"),
                )
                .where(orm.GeminiUsage.created_at >= cutoff)
                .group_by("day")
                .order_by("day")
            ).all()
        by_day = {
            str(r.day): {
                "usd": float(r.usd or 0),
                "ops": int(r.ops or 0),
                "in_tok": int(r.in_tok or 0),
                "out_tok": int(r.out_tok or 0),
            }
            for r in rows
        }
        out: list[dict] = []
        today = datetime.now(timezone.utc).date()
        for i in range(days):
            day = today - timedelta(days=days - 1 - i)
            key = day.isoformat()
            entry = by_day.get(key, {"usd": 0.0, "ops": 0, "in_tok": 0, "out_tok": 0})
            out.append(
                {
                    "day": key,
                    "cost_usd": entry["usd"],
                    "ops": entry["ops"],
                    "input_tokens": entry["in_tok"],
                    "output_tokens": entry["out_tok"],
                    "total_tokens": entry["in_tok"] + entry["out_tok"],
                }
            )
        return out

    def by_provider(self) -> list[dict]:
        """Custo e tokens agregados por provider, mais caro (ou com mais tokens) primeiro."""
        with get_session() as s:
            rows = s.execute(
                select(
                    func.coalesce(
                        orm.GeminiUsage.provider,
                        func.iif(
                            orm.GeminiUsage.model.like("%/%"),
                            func.substr(orm.GeminiUsage.model, 1, func.instr(orm.GeminiUsage.model, "/") - 1),
                            func.iif(orm.GeminiUsage.model.like("gemini%"), "gemini", "unknown"),
                        ),
                    ).label("p"),
                    func.sum(orm.GeminiUsage.cost_usd).label("usd"),
                    func.count(orm.GeminiUsage.id).label("ops"),
                    func.coalesce(func.sum(orm.GeminiUsage.input_tokens), 0).label("in_tok"),
                    func.coalesce(func.sum(orm.GeminiUsage.output_tokens), 0).label("out_tok"),
                )
                .group_by("p")
                .order_by(
                    func.sum(orm.GeminiUsage.cost_usd).desc(),
                    func.sum(orm.GeminiUsage.input_tokens + orm.GeminiUsage.output_tokens).desc(),
                )
            ).all()
        return [
            {
                "provider": r.p,
                "total_usd": float(r.usd or 0),
                "ops": int(r.ops or 0),
                "input_tokens": int(r.in_tok or 0),
                "output_tokens": int(r.out_tok or 0),
                "total_tokens": int(r.in_tok or 0) + int(r.out_tok or 0),
            }
            for r in rows
        ]

    def by_novel(self) -> list[dict]:
        """Custo e tokens agregados por novel, mais caro (ou com mais tokens) primeiro."""
        with get_session() as s:
            rows = s.execute(
                select(
                    orm.GeminiUsage.novel_id,
                    orm.Novel.title,
                    func.sum(orm.GeminiUsage.cost_usd).label("usd"),
                    func.count(orm.GeminiUsage.id).label("ops"),
                    func.count(
                        func.distinct(
                            func.iif(
                                and_(
                                    orm.GeminiUsage.op == "translate_chapter",
                                    orm.GeminiUsage.error_message.is_(None),
                                ),
                                func.coalesce(orm.GeminiUsage.chapter_index, -orm.GeminiUsage.id),
                                None,
                            )
                        )
                    ).label("chapters"),
                    func.sum(
                        func.iif(
                            and_(
                                orm.GeminiUsage.op == "cover_image",
                                orm.GeminiUsage.error_message.is_(None),
                            ),
                            1,
                            0,
                        )
                    ).label("covers"),
                    func.coalesce(func.sum(orm.GeminiUsage.input_tokens), 0).label("in_tok"),
                    func.coalesce(func.sum(orm.GeminiUsage.output_tokens), 0).label("out_tok"),
                )
                .outerjoin(orm.Novel, orm.Novel.id == orm.GeminiUsage.novel_id)
                .group_by(orm.GeminiUsage.novel_id, orm.Novel.title)
                .order_by(
                    func.sum(orm.GeminiUsage.cost_usd).desc(),
                    func.sum(orm.GeminiUsage.input_tokens + orm.GeminiUsage.output_tokens).desc(),
                )
            ).all()
        return [
            {
                "novel_id": r.novel_id,
                "novel_title": r.title or "(sem novel vinculada)",
                "total_usd": float(r.usd or 0),
                "ops": int(r.ops or 0),
                "chapters_translated": int(r.chapters or 0),
                "covers_generated": int(r.covers or 0),
                "input_tokens": int(r.in_tok or 0),
                "output_tokens": int(r.out_tok or 0),
                "total_tokens": int(r.in_tok or 0) + int(r.out_tok or 0),
            }
            for r in rows
        ]
