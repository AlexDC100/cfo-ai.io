"""Postgres adapter — read engine inputs from PG, persist daily decisions back.

Per CLAUDE.md architecture: ERP/Inventory/Treasury → n8n → Postgres warehouse → engine.
The engine never talks to ERP directly; it always reads from a snapshot in PG.

Schema is intentionally narrow — only what Phase 1 consumes. SKU-level tables
exist as columns/types but Phase 1 doesn't classify SKUs, so we read them but
don't require them.

Tested against sqlite (in-memory) so the test suite needs no live PG.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import date, datetime
from typing import Any, Dict, Iterator, List, Optional

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    Integer,
    String,
    create_engine,
    select,
)
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column
from sqlalchemy.pool import StaticPool

from ..models import CategoryRow, MasterOverride, Recommendation


class Base(DeclarativeBase):
    pass


class SchemaRecommendation(Base):
    """Stateful CFO action queue.

    One row per (target_type, target_id, generation) — when a target's bucket
    changes, the previous row is marked archived and a fresh row is inserted
    with `superseded_by` set on the old. When the underlying numbers move
    within the same bucket, we update the row in place (option A reconcile).
    """

    __tablename__ = "recommendations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_type: Mapped[str] = mapped_column(String(16), index=True)
    target_id: Mapped[str] = mapped_column(String(128), index=True)
    bucket: Mapped[str] = mapped_column(String(16), index=True)
    action_type: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(256))
    explanation: Mapped[str] = mapped_column(String(1024))
    expected_cash_impact_kron: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    expected_margin_impact_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    urgency: Mapped[str] = mapped_column(String(16), default="medium", index=True)
    owner: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="new", index=True)
    due_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    superseded_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    decision_hash: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)


class SchemaCategoryMetric(Base):
    """Mirror of `category_metrics` table — one row per (category, snapshot date)."""

    __tablename__ = "category_metrics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    snapshot_date: Mapped[date] = mapped_column(Date, index=True)
    category: Mapped[str] = mapped_column(String(64), index=True)
    business_unit: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    volume_tons: Mapped[float] = mapped_column(Float)
    niv_kron: Mapped[float] = mapped_column(Float)
    gm_pct: Mapped[float] = mapped_column(Float)
    dio_days: Mapped[int] = mapped_column(Integer)
    dso_days: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    dpo_days: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    ccc_days: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    woca_kron: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    abs_profit_kron: Mapped[Optional[float]] = mapped_column(Float, nullable=True)


class SchemaMasterOverride(Base):
    """Mirror of `master_skus` — strategic flags, protected windows, override notes."""

    __tablename__ = "master_skus"

    sku_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    strategic_flag: Mapped[bool] = mapped_column(Boolean, default=False)
    protected_until: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    override_reason: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)


class DailyDecisionRow(Base):
    """One row per (run_date, category) — write target for engine output.

    Stores the JSON payload so the briefing generator and Power BI export can
    read it back without re-running the engine.
    """

    __tablename__ = "daily_decisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_date: Mapped[date] = mapped_column(Date, index=True)
    category: Mapped[str] = mapped_column(String(64), index=True)
    flag: Mapped[str] = mapped_column(String(32), index=True)
    reason: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    recommendation: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    real_margin_pct: Mapped[float] = mapped_column(Float)
    volume_tons: Mapped[float] = mapped_column(Float)
    abs_profit_kron: Mapped[float] = mapped_column(Float)
    dio_days: Mapped[int] = mapped_column(Integer)
    do_not_eliminate: Mapped[bool] = mapped_column(Boolean, default=False)
    capital_freed_kron: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    payload: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ChatMessage(Base):
    """Persisted chat messages between the user and CFO AI.

    Used both for transcript history and for sending the last N turns back
    to the model on follow-up questions. Stored per company so a workspace
    has a single thread (multi-thread is a future feature).
    """

    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    company_id: Mapped[Optional[str]] = mapped_column(String(64), index=True, nullable=True)
    dataset_id: Mapped[Optional[str]] = mapped_column(String(64), index=True, nullable=True)
    role: Mapped[str] = mapped_column(String(16))  # 'user' | 'ai'
    content: Mapped[str] = mapped_column(String(4096))
    blocks_json: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class SessionLog(Base):
    """One row per identified session. Lets every team member see who else
    has used the platform — name, IP (forwarded by Caddy), user-agent fragment,
    first/last seen. Updated on identity-set and on a periodic heartbeat.

    A "session" is keyed by (name, ip) — multiple distinct users on the same IP
    are kept apart, and the same user across browsers gets one row. New device
    of the same user updates last_seen on whichever row matches the IP, or
    creates a fresh one.
    """

    __tablename__ = "session_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(64), index=True)
    ip: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    first_seen: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    visit_count: Mapped[int] = mapped_column(Integer, default=1)


def create_engine_from_url(url: str, echo: bool = False) -> Engine:
    """Build a SQLAlchemy engine. Use 'sqlite:///:memory:' for tests.

    For in-memory sqlite we pin to a single connection (StaticPool) — without
    it, every new connection sees a fresh empty DB and CREATE TABLE / SELECT
    can't find each other's state.
    """
    if url == "sqlite:///:memory:":
        return create_engine(
            url,
            echo=echo,
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
    return create_engine(url, echo=echo, future=True)


class PostgresAdapter:
    """Read inputs from / write outputs to the warehouse.

    Methods are intentionally narrow — they map 1:1 to the engine's needs and
    don't expose SQLAlchemy details to callers.
    """

    def __init__(self, engine: Engine):
        self.engine = engine

    # ─────────── DDL ───────────

    def create_all(self) -> None:
        """Create tables if missing. Safe to call repeatedly (CREATE IF NOT EXISTS)."""
        Base.metadata.create_all(self.engine)

    # ─────────── Reads ───────────

    def load_categories(self, snapshot_date: date) -> List[CategoryRow]:
        """Pull the category snapshot for a given date."""
        with self._session() as s:
            stmt = select(SchemaCategoryMetric).where(
                SchemaCategoryMetric.snapshot_date == snapshot_date
            )
            return [_row_to_category(r) for r in s.scalars(stmt)]

    def load_overrides(self) -> Dict[str, MasterOverride]:
        with self._session() as s:
            return {
                r.sku_id: MasterOverride(
                    sku_id=r.sku_id,
                    strategic_flag=r.strategic_flag,
                    protected_until=r.protected_until.isoformat() if r.protected_until else None,
                    override_reason=r.override_reason,
                )
                for r in s.scalars(select(SchemaMasterOverride))
            }

    # ─────────── Writes ───────────

    def insert_categories(
        self, snapshot_date: date, rows: List[CategoryRow]
    ) -> None:
        """Insert category snapshot. Idempotent: deletes existing rows for this date first."""
        with self._session() as s:
            s.query(SchemaCategoryMetric).filter(
                SchemaCategoryMetric.snapshot_date == snapshot_date
            ).delete()
            for r in rows:
                s.add(
                    SchemaCategoryMetric(
                        snapshot_date=snapshot_date,
                        category=r.category,
                        business_unit=r.business_unit,
                        volume_tons=r.volume_tons,
                        niv_kron=r.niv_kron,
                        gm_pct=r.gm_pct,
                        dio_days=r.dio_days,
                        dso_days=r.dso_days,
                        dpo_days=r.dpo_days,
                        ccc_days=r.ccc_days,
                        woca_kron=r.woca_kron,
                        abs_profit_kron=r.abs_profit_kron,
                    )
                )
            s.commit()

    def write_decisions(self, payload: Dict[str, Any]) -> int:
        """Persist the daily-decisions JSON. Returns count of rows written.

        Idempotent: deletes any existing rows for `run_date` before inserting.
        """
        run_date = date.fromisoformat(payload["run_date"])
        # Flatten: each decision in any flag-group becomes one row
        flag_groups = ("anchor", "anchor_alerts", "anchor_review",
                       "eliminate", "warning", "scale", "keep")
        with self._session() as s:
            s.query(DailyDecisionRow).filter(DailyDecisionRow.run_date == run_date).delete()
            count = 0
            for group in flag_groups:
                for d in payload.get(group, []):
                    s.add(
                        DailyDecisionRow(
                            run_date=run_date,
                            category=d["id"],
                            flag=_group_to_flag(group, d),
                            reason=d.get("reason"),
                            recommendation=d.get("recommendation"),
                            real_margin_pct=d["real_margin_pct"],
                            volume_tons=d["volume_tons"],
                            abs_profit_kron=d["abs_profit_kron"],
                            dio_days=d["dio_days"],
                            do_not_eliminate=d.get("do_not_eliminate", False),
                            capital_freed_kron=d.get("capital_freed_kron"),
                            payload=d,
                        )
                    )
                    count += 1
            s.commit()
        return count

    def fetch_decisions(self, run_date: date) -> List[Dict[str, Any]]:
        with self._session() as s:
            stmt = select(DailyDecisionRow).where(DailyDecisionRow.run_date == run_date)
            return [_decision_to_dict(r) for r in s.scalars(stmt)]

    # ─────────── Recommendations (CFO action queue) ───────────

    def list_recommendations(
        self,
        status: Optional[str] = None,
        bucket: Optional[str] = None,
        limit: int = 200,
    ) -> List[Recommendation]:
        """Fetch recommendations, optionally filtered by status/bucket."""
        with self._session() as s:
            stmt = select(SchemaRecommendation)
            if status:
                stmt = stmt.where(SchemaRecommendation.status == status)
            if bucket:
                stmt = stmt.where(SchemaRecommendation.bucket == bucket)
            stmt = stmt.order_by(
                SchemaRecommendation.urgency.desc(),
                SchemaRecommendation.due_date.asc(),
            ).limit(limit)
            return [_rec_row_to_model(r) for r in s.scalars(stmt)]

    def upsert_recommendation(self, rec: Recommendation) -> Recommendation:
        """Insert if rec.id is None, else update the existing row."""
        with self._session() as s:
            if rec.id is None:
                row = SchemaRecommendation(
                    target_type=rec.target_type,
                    target_id=rec.target_id,
                    bucket=rec.bucket,
                    action_type=rec.action_type,
                    title=rec.title,
                    explanation=rec.explanation,
                    expected_cash_impact_kron=rec.expected_cash_impact_kron,
                    expected_margin_impact_pct=rec.expected_margin_impact_pct,
                    urgency=rec.urgency,
                    owner=rec.owner,
                    status=rec.status,
                    due_date=rec.due_date,
                    created_at=rec.created_at,
                    updated_at=rec.updated_at,
                    closed_at=rec.closed_at,
                    superseded_by=rec.superseded_by,
                    decision_hash=rec.decision_hash,
                )
                s.add(row)
                s.commit()
                s.refresh(row)
                return _rec_row_to_model(row)
            existing = s.get(SchemaRecommendation, rec.id)
            if existing is None:
                raise ValueError(f"Recommendation id={rec.id} not found")
            existing.bucket = rec.bucket
            existing.action_type = rec.action_type
            existing.title = rec.title
            existing.explanation = rec.explanation
            existing.expected_cash_impact_kron = rec.expected_cash_impact_kron
            existing.expected_margin_impact_pct = rec.expected_margin_impact_pct
            existing.urgency = rec.urgency
            existing.owner = rec.owner
            existing.status = rec.status
            existing.due_date = rec.due_date
            existing.updated_at = datetime.utcnow()
            existing.closed_at = rec.closed_at
            existing.superseded_by = rec.superseded_by
            existing.decision_hash = rec.decision_hash
            s.commit()
            s.refresh(existing)
            return _rec_row_to_model(existing)

    def update_recommendation_status(
        self, rec_id: int, status: str, owner: Optional[str] = None
    ) -> Optional[Recommendation]:
        """Move a recommendation along its workflow (in_review/approved/etc)."""
        with self._session() as s:
            row = s.get(SchemaRecommendation, rec_id)
            if row is None:
                return None
            row.status = status
            if owner is not None:
                row.owner = owner
            row.updated_at = datetime.utcnow()
            if status in ("done", "rejected", "archived"):
                row.closed_at = datetime.utcnow()
            s.commit()
            s.refresh(row)
            return _rec_row_to_model(row)

    # ─────────── Chat history ───────────

    def insert_chat_message(
        self,
        role: str,
        content: str,
        company_id: Optional[str] = None,
        dataset_id: Optional[str] = None,
        blocks: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Persist a chat turn. Returns the row as a dict for the caller."""
        with self._session() as s:
            row = ChatMessage(
                company_id=company_id,
                dataset_id=dataset_id,
                role=role,
                content=content[:4096],
                blocks_json=blocks,
            )
            s.add(row)
            s.commit()
            s.refresh(row)
            return {
                "id": row.id,
                "role": row.role,
                "content": row.content,
                "blocks": row.blocks_json,
                "created_at": row.created_at.isoformat(),
            }

    def list_chat_messages(
        self,
        company_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """Recent chat history, oldest-first (so callers can render as a transcript)."""
        with self._session() as s:
            stmt = select(ChatMessage)
            if company_id:
                stmt = stmt.where(ChatMessage.company_id == company_id)
            stmt = stmt.order_by(ChatMessage.created_at.desc()).limit(limit)
            rows = list(s.scalars(stmt))
            rows.reverse()
            return [
                {
                    "id": r.id,
                    "role": r.role,
                    "content": r.content,
                    "blocks": r.blocks_json,
                    "created_at": r.created_at.isoformat(),
                }
                for r in rows
            ]

    # ─────────── Sessions (multi-user awareness) ───────────

    def upsert_session(
        self,
        name: str,
        ip: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Record a session for `name`. If a row exists for (name, ip), bump
        last_seen and visit_count; otherwise insert. Returns the row as dict.
        """
        from sqlalchemy import and_, update
        with self._session() as s:
            stmt = select(SessionLog).where(
                and_(SessionLog.name == name, SessionLog.ip == ip)
            )
            existing = s.scalars(stmt).first()
            now = datetime.utcnow()
            if existing:
                existing.last_seen = now
                existing.visit_count = (existing.visit_count or 0) + 1
                if user_agent and not existing.user_agent:
                    existing.user_agent = user_agent[:256]
                s.commit()
                return _session_to_dict(existing)
            row = SessionLog(
                name=name[:64],
                ip=ip[:64] if ip else None,
                user_agent=user_agent[:256] if user_agent else None,
                first_seen=now,
                last_seen=now,
                visit_count=1,
            )
            s.add(row)
            s.commit()
            s.refresh(row)
            return _session_to_dict(row)

    def list_sessions(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Recent sessions, newest activity first."""
        with self._session() as s:
            stmt = (
                select(SessionLog)
                .order_by(SessionLog.last_seen.desc())
                .limit(limit)
            )
            return [_session_to_dict(r) for r in s.scalars(stmt)]

    # ─────────── Internals ───────────

    @contextmanager
    def _session(self) -> Iterator[Session]:
        s = Session(self.engine, future=True)
        try:
            yield s
        finally:
            s.close()


def _row_to_category(r: SchemaCategoryMetric) -> CategoryRow:
    return CategoryRow(
        category=r.category,
        business_unit=r.business_unit,
        volume_tons=r.volume_tons,
        niv_kron=r.niv_kron,
        gm_pct=r.gm_pct,
        dio_days=r.dio_days,
        dso_days=r.dso_days,
        dpo_days=r.dpo_days,
        ccc_days=r.ccc_days,
        woca_kron=r.woca_kron,
        abs_profit_kron=r.abs_profit_kron,
    )


def _group_to_flag(group: str, decision_payload: Dict[str, Any]) -> str:
    """Map output-group key back to the engine's flag enum."""
    return {
        "anchor": "ANCHOR",
        "anchor_alerts": "ANCHOR_ALERT",
        "anchor_review": "ANCHOR_REVIEW",
        "eliminate": "ELIMINATE",
        "warning": "WARNING",
        "scale": "SCALE",
        "keep": "KEEP",
    }[group]


def _session_to_dict(r: SessionLog) -> Dict[str, Any]:
    return {
        "id": r.id,
        "name": r.name,
        "ip": r.ip,
        "user_agent": r.user_agent,
        "first_seen": r.first_seen.isoformat() if r.first_seen else None,
        "last_seen": r.last_seen.isoformat() if r.last_seen else None,
        "visit_count": r.visit_count or 0,
    }


def _rec_row_to_model(r: SchemaRecommendation) -> Recommendation:
    return Recommendation(
        id=r.id,
        target_type=r.target_type,
        target_id=r.target_id,
        bucket=r.bucket,
        action_type=r.action_type,
        title=r.title,
        explanation=r.explanation,
        expected_cash_impact_kron=r.expected_cash_impact_kron,
        expected_margin_impact_pct=r.expected_margin_impact_pct,
        urgency=r.urgency,
        owner=r.owner,
        status=r.status,
        due_date=r.due_date,
        created_at=r.created_at,
        updated_at=r.updated_at,
        closed_at=r.closed_at,
        superseded_by=r.superseded_by,
        decision_hash=r.decision_hash,
    )


def _decision_to_dict(r: DailyDecisionRow) -> Dict[str, Any]:
    return {
        "run_date": r.run_date.isoformat(),
        "category": r.category,
        "flag": r.flag,
        "reason": r.reason,
        "recommendation": r.recommendation,
        "real_margin_pct": r.real_margin_pct,
        "volume_tons": r.volume_tons,
        "abs_profit_kron": r.abs_profit_kron,
        "dio_days": r.dio_days,
        "do_not_eliminate": r.do_not_eliminate,
        "capital_freed_kron": r.capital_freed_kron,
    }
