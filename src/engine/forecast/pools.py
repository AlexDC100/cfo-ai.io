"""Cost pools — how the anchor's operating costs split and how each part
moves (plan_contract_v2 section 5, S1; plan/2 B4b).

The anchor's ``statement_line_items`` rows are the ONLY pool source (5.1):
the rows whose bucket is ``operatingExpenses`` are split into the pools of
``packs/forecast/cost_behaviour.yaml#prefix_to_pool`` by longest account
prefix, the rows whose bucket is ``cogs`` are the cost_of_sales pool, and
``envelope.leaves`` is never read. Each row enters with the sign the
assembled statement used, so the pools plus the unallocated residual equal
``assembled_pl.opex_excluding_cogs_and_da`` to the cent.

Every pool then resolves a FIXED SHARE down its ladder (5.2):

  0. nil pool          base 0            -> 0, convention #nil_pool
     negative pool     base < 0          -> 0, convention #negative_pool
  1. book two-point fit                  -> B7 (recorded absent here)
  2. sector                              -> absent, no sector source
  3. convention classification           -> fixed-classified / pool amount
  cap: variable base above the pack's share of revenue -> 1, convention

cost_of_sales is fixed_share 0 by convention (#cogs_variable); the
unallocated residual follows the amount-weighted share of the pooled costs
(#unallocated_follows_allocated). A split that cannot be made — more than
the pack's share unallocated, rows that do not sum to the assembled figure,
or no rows at all — REFUSES BY NAME into one pool ``operating_costs`` at the
share the pack's rule states; it never guesses a split.

Amounts are integer cents, shares integer micros. No cutoff or sentence
lives in this module (TC-10): each comes from the pack with its address.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .errors import AssumptionError
from .money import MICRO, cents_from, fmt, mul_div

PACK_FILE = "packs/forecast/cost_behaviour.yaml"
SCHEMA_VERSION = "cost_behaviour/1"

OPEX_BUCKET = "operatingExpenses"
COGS_BUCKET = "cogs"

COST_OF_SALES = "cost_of_sales"
UNALLOCATED = "unallocated_operating"
REFUSED_POOL = "operating_costs"

TEMPLATE_FIXED_SHARE = "pool_fixed_share.*"
TEMPLATE_LEVEL = "pool_level.*"
FIXED_SHARE_PREFIX = "pool_fixed_share."
LEVEL_PREFIX = "pool_level."

_HISTORY_NOT_READ = "prior periods are not read in this build"
_NO_SECTOR_SOURCE = "no sector source loaded"


class PackError(RuntimeError):
    """The cost-behaviour pack is malformed; nothing is guessed."""


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / PACK_FILE).is_file():
            return parent
    raise PackError("%s not found above %s" % (PACK_FILE, here))


def _decimal(raw: Any, where: str) -> Decimal:
    if isinstance(raw, bool) or not isinstance(raw, str):
        raise PackError("%s: a value is a decimal STRING, got %r" % (where, raw))
    try:
        return Decimal(raw.strip())
    except Exception:  # noqa: BLE001
        raise PackError("%s: %r is not a decimal" % (where, raw))


def _sentence(raw: Any, where: str, placeholder: bool = False) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise PackError("%s: sentence missing" % where)
    text = " ".join(raw.split())
    if any(ch.isdigit() for ch in text):
        raise PackError("%s: a pack sentence carries no numeral: %r" % (where, text))
    if "{amount}" in text and not placeholder:
        raise PackError("%s: {amount} is not declared for this sentence" % where)
    return text


class Rule(object):
    __slots__ = ("key", "rule_id", "sentence", "value")

    def __init__(self, key: str, sentence: str, value: Optional[Decimal] = None) -> None:
        self.key = key
        self.rule_id = "%s#%s" % (PACK_FILE, key)
        self.sentence = sentence
        self.value = value

    def render(self, amount_cents: Optional[int] = None) -> str:
        if "{amount}" in self.sentence:
            if amount_cents is None:
                raise PackError("%s: {amount} needs an amount to render" % self.key)
            return self.sentence.replace("{amount}", fmt(amount_cents))
        return self.sentence


class CostBehaviourPack(object):
    """The pack, loaded once and read everywhere."""

    __slots__ = ("path", "pools", "prefixes", "nature", "rules")

    def __init__(self, path: Path) -> None:
        import yaml

        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        where = str(path)
        if not isinstance(raw, dict) or raw.get("schema_version") != SCHEMA_VERSION:
            raise PackError("%s: schema_version must be %r" % (where, SCHEMA_VERSION))
        self.path = path
        pools_raw = raw.get("prefix_to_pool")
        if not isinstance(pools_raw, dict) or not pools_raw:
            raise PackError("%s: prefix_to_pool is empty" % where)
        self.pools = tuple(str(k) for k in pools_raw)  # pack order
        self.prefixes = {}  # type: Dict[str, str]
        for pool, prefixes in pools_raw.items():
            if not isinstance(prefixes, list) or not prefixes:
                raise PackError("%s: pool %r lists no prefix" % (where, pool))
            for prefix in prefixes:
                prefix = str(prefix)
                if prefix in self.prefixes:
                    raise PackError("%s: prefix %r is listed under two pools (%s, %s)"
                                    % (where, prefix, self.prefixes[prefix], pool))
                self.prefixes[prefix] = str(pool)
        nature_raw = raw.get("nature") or {}
        self.nature = {}  # type: Dict[str, str]
        for kind in ("fixed", "variable"):
            for prefix in nature_raw.get(kind) or []:
                prefix = str(prefix)
                if prefix in self.nature:
                    raise PackError("%s: prefix %r classified twice" % (where, prefix))
                self.nature[prefix] = kind
        unclassified = sorted(p for p in self.prefixes if p not in self.nature)
        if unclassified:
            raise PackError("%s: pooled prefixes with no nature: %s"
                            % (where, ", ".join(unclassified)))
        self.rules = {}  # type: Dict[str, Rule]
        for key in ("max_unallocated_share", "variable_base_max_share_of_revenue"):
            block = raw.get(key)
            if not isinstance(block, dict):
                raise PackError("%s: %s needs value and sentence" % (where, key))
            self.rules[key] = Rule(key, _sentence(block.get("sentence"), where + "#" + key,
                                                  placeholder=(key == "max_unallocated_share")),
                                   _decimal(block.get("value"), where + "#" + key))
        for key, placeholder in (("cogs_variable", False), ("classification", True),
                                 ("nil_pool", False), ("negative_pool", False),
                                 ("unallocated_follows_allocated", True),
                                 ("no_line_items", False), ("rows_disagree", False)):
            block = raw.get(key)
            if not isinstance(block, dict):
                raise PackError("%s: %s needs a sentence" % (where, key))
            self.rules[key] = Rule(key, _sentence(block.get("sentence"), where + "#" + key,
                                                  placeholder=placeholder))

    def pool_of(self, code: str) -> Optional[str]:
        """Longest declared prefix wins; None when no prefix matches."""
        code = str(code or "").strip()
        best = None  # type: Optional[str]
        for prefix in self.prefixes:
            if code.startswith(prefix) and (best is None or len(prefix) > len(best)):
                best = prefix
        return self.prefixes[best] if best is not None else None

    def nature_of(self, code: str) -> Optional[str]:
        code = str(code or "").strip()
        best = None  # type: Optional[str]
        for prefix in self.nature:
            if code.startswith(prefix) and (best is None or len(prefix) > len(best)):
                best = prefix
        return self.nature[best] if best is not None else None

    def rule(self, key: str) -> Rule:
        return self.rules[key]

    def micros(self, key: str) -> int:
        """A pack value as exact micros (a decimal string, never a float)."""
        value = self.rules[key].value
        if value is None:
            raise PackError("%s carries no value" % key)
        scaled = value * MICRO
        if scaled != scaled.to_integral_value():
            raise PackError("%s: %s is finer than a micro" % (key, value))
        return int(scaled)


_CACHE = {}  # type: Dict[str, CostBehaviourPack]


def load_cost_behaviour(path: Optional[Path] = None) -> CostBehaviourPack:
    path = Path(path) if path is not None else _repo_root() / PACK_FILE
    key = str(path.resolve())
    if key not in _CACHE:
        _CACHE[key] = CostBehaviourPack(path)
    return _CACHE[key]


class Pool(object):
    """One cost pool of the anchor: its base and its resolved fixed share."""

    __slots__ = ("name", "kind", "base_cents", "fixed_share_micros", "tier",
                 "rule_id", "evidence", "fallback_steps", "sentence",
                 "row_count", "fixed_classified_cents", "variable_classified_cents",
                 "capped", "prefixes")

    def __init__(self, name: str, kind: str, base_cents: int, *, fixed_share_micros: int,
                 tier: str, rule_id: str, evidence: Dict[str, Any],
                 fallback_steps: Sequence[Dict[str, str]], sentence: str,
                 row_count: int = 0, fixed_classified_cents: int = 0,
                 variable_classified_cents: int = 0, capped: bool = False,
                 prefixes: Sequence[str] = ()) -> None:
        self.name = name
        self.kind = kind
        self.base_cents = int(base_cents)
        self.fixed_share_micros = int(fixed_share_micros)
        self.tier = tier
        self.rule_id = rule_id
        self.evidence = evidence
        self.fallback_steps = tuple(fallback_steps)
        self.sentence = sentence
        self.row_count = row_count
        self.fixed_classified_cents = fixed_classified_cents
        self.variable_classified_cents = variable_classified_cents
        self.capped = capped
        self.prefixes = tuple(prefixes)

    @property
    def variable_base_cents(self) -> int:
        return self.base_cents - mul_div(self.base_cents, self.fixed_share_micros, MICRO)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name, "kind": self.kind, "base_minor": self.base_cents,
            "fixed_share_micros": self.fixed_share_micros, "tier": self.tier,
            "rule_id": self.rule_id, "capped": self.capped, "row_count": self.row_count,
            "fixed_classified_minor": self.fixed_classified_cents,
            "variable_classified_minor": self.variable_classified_cents,
            "fallback_steps": [dict(s) for s in self.fallback_steps],
        }


class PoolSplit(object):
    """The anchor's cost pools: cost_of_sales, then the opex pools in served
    order (pack order, then unallocated_operating; or the single
    operating_costs pool when the split refused)."""

    __slots__ = ("cost_of_sales", "opex", "refused", "refusal_rule_id",
                 "unallocated_cents", "unallocated_share_micros", "revenue_cents",
                 "opex_total_cents", "source")

    def __init__(self, cost_of_sales: Pool, opex: Sequence[Pool], *, refused: bool,
                 refusal_rule_id: Optional[str], unallocated_cents: int,
                 unallocated_share_micros: Optional[int], revenue_cents: int,
                 opex_total_cents: int, source: str) -> None:
        self.cost_of_sales = cost_of_sales
        self.opex = tuple(opex)
        self.refused = refused
        self.refusal_rule_id = refusal_rule_id
        self.unallocated_cents = unallocated_cents
        self.unallocated_share_micros = unallocated_share_micros
        self.revenue_cents = revenue_cents
        self.opex_total_cents = opex_total_cents
        self.source = source

    def pools(self) -> Tuple[Pool, ...]:
        return (self.cost_of_sales,) + self.opex

    def opex_names(self) -> Tuple[str, ...]:
        return tuple(p.name for p in self.opex)

    def pool(self, name: str) -> Pool:
        for p in self.pools():
            if p.name == name:
                return p
        raise AssumptionError("pools", "this book serves no pool %r; served: %s"
                              % (name, ", ".join(p.name for p in self.pools())))

    def fixed_share_keys(self) -> Tuple[str, ...]:
        """pool_fixed_share.* expanded: cost_of_sales first, then the opex
        pools in served order (3a.2)."""
        return tuple(FIXED_SHARE_PREFIX + p.name for p in self.pools())

    def level_keys(self) -> Tuple[str, ...]:
        """pool_level.* expanded over the opex pools only (3a.2)."""
        return tuple(LEVEL_PREFIX + p.name for p in self.opex)

    @property
    def opex_sum_cents(self) -> int:
        return sum(p.base_cents for p in self.opex)

    def aggregate_fixed_share_micros(self) -> Optional[int]:
        """The amount-weighted fixed share of the served opex pools (the
        one opex fixed share engine.forecast_drivers publishes, contract
        4). None when the opex base is not positive."""
        base = sum(p.base_cents for p in self.opex if p.base_cents > 0)
        if base <= 0:
            return None
        fixed = sum(mul_div(p.base_cents, p.fixed_share_micros, MICRO)
                    for p in self.opex if p.base_cents > 0)
        return mul_div(fixed, MICRO, base)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source, "refused": self.refused,
            "refusal_rule_id": self.refusal_rule_id,
            "unallocated_minor": self.unallocated_cents,
            "unallocated_share_micros": self.unallocated_share_micros,
            "revenue_minor": self.revenue_cents, "opex_total_minor": self.opex_total_cents,
            "pools": [p.as_dict() for p in self.pools()],
        }


def _convention(rule: Rule, facts: Sequence[Tuple[str, Any, str]] = ()) -> Dict[str, Any]:
    return {"rule_id": rule.rule_id, "pack_address": rule.rule_id,
            "evidence": [{"fact": fact, field: value} for fact, value, field in facts]}


def _step(tier: str, outcome: str, reason: str) -> Dict[str, str]:
    return {"tier": tier, "outcome": outcome, "reason": reason}


def _ladder_steps() -> List[Dict[str, str]]:
    """Rungs 1 and 2 of the opex ladder (5.2), passed over in this build."""
    return [_step("book", "absent", _HISTORY_NOT_READ),
            _step("sector", "absent", _NO_SECTOR_SOURCE)]


def _cost_of_sales_pool(pack: CostBehaviourPack, base_cents: int, row_count: int) -> Pool:
    rule = pack.rule("cogs_variable")
    return Pool(COST_OF_SALES, "cost_of_sales", base_cents, fixed_share_micros=0,
                tier="convention", rule_id=rule.rule_id,
                evidence=_convention(rule, (("line_items.cogs", base_cents, "value_minor"),)),
                fallback_steps=(), sentence=rule.render(), row_count=row_count)


def _classified_pool(pack: CostBehaviourPack, name: str, base_cents: int, row_count: int,
                     fixed_cents: int, variable_cents: int, prefixes: Sequence[str],
                     revenue_cents: int) -> Pool:
    steps = _ladder_steps()
    facts = (("line_items.%s" % name, base_cents, "value_minor"),
             ("line_items.%s.fixed_classified" % name, fixed_cents, "value_minor"),
             ("line_items.%s.variable_classified" % name, variable_cents, "value_minor"))
    if base_cents == 0:
        rule = pack.rule("nil_pool")
        steps.append(_step("convention", "rejected", "nil pool"))
        return Pool(name, "opex", 0, fixed_share_micros=0, tier="convention",
                    rule_id=rule.rule_id, evidence=_convention(rule, facts),
                    fallback_steps=steps, sentence=rule.render(), row_count=row_count,
                    fixed_classified_cents=fixed_cents, variable_classified_cents=variable_cents,
                    prefixes=prefixes)
    if base_cents < 0:
        rule = pack.rule("negative_pool")
        steps.append(_step("convention", "rejected", "the pool is a net credit"))
        return Pool(name, "opex", base_cents, fixed_share_micros=0, tier="convention",
                    rule_id=rule.rule_id, evidence=_convention(rule, facts),
                    fallback_steps=steps, sentence=rule.render(), row_count=row_count,
                    fixed_classified_cents=fixed_cents, variable_classified_cents=variable_cents,
                    prefixes=prefixes)
    rule = pack.rule("classification")
    share = mul_div(fixed_cents, MICRO, base_cents)
    share = max(0, min(MICRO, share))
    sentence = rule.render(fixed_cents)
    return _cap(pack, Pool(name, "opex", base_cents, fixed_share_micros=share,
                           tier="convention", rule_id=rule.rule_id,
                           evidence=_convention(rule, facts), fallback_steps=steps,
                           sentence=sentence, row_count=row_count,
                           fixed_classified_cents=fixed_cents,
                           variable_classified_cents=variable_cents, prefixes=prefixes),
                revenue_cents)


def _cap(pack: CostBehaviourPack, pool: Pool, revenue_cents: int) -> Pool:
    """5.2 cap: a variable base above the pack's share of revenue is served
    fully fixed, the rejected rung kept in fallback_steps."""
    if pool.kind != "opex":
        return pool
    limit = mul_div(max(revenue_cents, 0), pack.micros("variable_base_max_share_of_revenue"), MICRO)
    if pool.variable_base_cents <= limit:
        return pool
    rule = pack.rule("variable_base_max_share_of_revenue")
    steps = list(pool.fallback_steps) + [
        _step("convention", "rejected",
              "%s: variable base %s exceeds %s of revenue %s"
              % (pool.rule_id, fmt(pool.variable_base_cents),
                 str(rule.value), fmt(revenue_cents)))]
    return Pool(pool.name, pool.kind, pool.base_cents, fixed_share_micros=MICRO,
                tier="convention", rule_id=rule.rule_id,
                evidence=_convention(rule, (("line_items.%s" % pool.name, pool.base_cents, "value_minor"),
                                            ("assembled_pl.revenue", revenue_cents, "value_minor"))),
                fallback_steps=steps, sentence=rule.render(), row_count=pool.row_count,
                fixed_classified_cents=pool.fixed_classified_cents,
                variable_classified_cents=pool.variable_classified_cents, capped=True,
                prefixes=pool.prefixes)


def _unallocated_pool(pack: CostBehaviourPack, amount_cents: int, row_count: int,
                      pooled: Sequence[Pool], revenue_cents: int) -> Pool:
    rule = pack.rule("unallocated_follows_allocated")
    base = sum(p.base_cents for p in pooled if p.base_cents > 0)
    if base > 0:
        fixed = sum(mul_div(p.base_cents, p.fixed_share_micros, MICRO)
                    for p in pooled if p.base_cents > 0)
        share = mul_div(fixed, MICRO, base)
    else:
        share = 0
    facts = (("line_items.%s" % UNALLOCATED, amount_cents, "value_minor"),
             ("line_items.pooled_operating_costs", base, "value_minor"),
             ("line_items.pooled_operating_costs.fixed", mul_div(base, share, MICRO), "value_minor"))
    pool = Pool(UNALLOCATED, "opex", amount_cents, fixed_share_micros=share,
                tier="convention", rule_id=rule.rule_id, evidence=_convention(rule, facts),
                fallback_steps=_ladder_steps(), sentence=rule.render(amount_cents),
                row_count=row_count)
    return _cap(pack, pool, revenue_cents)


def refused_split(rule_key: str, *, opex_total_cents: int, cogs_total_cents: int,
                  revenue_cents: int, share_micros: int = 0, amount_cents: Optional[int] = None,
                  pack: Optional[CostBehaviourPack] = None, source: str = "refused") -> PoolSplit:
    """One pool ``operating_costs`` at the share the named rule states."""
    pack = pack or load_cost_behaviour()
    rule = pack.rule(rule_key)
    facts = (("assembled_pl.opex_excluding_cogs_and_da", opex_total_cents, "value_minor"),)
    pool = Pool(REFUSED_POOL, "opex", opex_total_cents, fixed_share_micros=share_micros,
                tier="convention", rule_id=rule.rule_id, evidence=_convention(rule, facts),
                fallback_steps=_ladder_steps() + [_step("convention", "rejected", rule.render(amount_cents) if "{amount}" in rule.sentence else rule.render())],
                sentence=rule.render(amount_cents) if "{amount}" in rule.sentence else rule.render())
    return PoolSplit(_cost_of_sales_pool(pack, cogs_total_cents, 0), (pool,), refused=True,
                     refusal_rule_id=rule.rule_id, unallocated_cents=opex_total_cents
                     if amount_cents is None else amount_cents,
                     unallocated_share_micros=None, revenue_cents=revenue_cents,
                     opex_total_cents=opex_total_cents, source=source)


def split_pools(line_items: Optional[Iterable[Dict[str, Any]]], *, revenue_cents: int,
                opex_total_cents: int, cogs_total_cents: int,
                pack: Optional[CostBehaviourPack] = None) -> PoolSplit:
    """The anchor's pools from its line items (5.1, 5.2)."""
    pack = pack or load_cost_behaviour()
    if line_items is None:
        return refused_split("no_line_items", opex_total_cents=opex_total_cents,
                             cogs_total_cents=cogs_total_cents, revenue_cents=revenue_cents,
                             pack=pack, source="no_line_items")
    sums = dict((name, 0) for name in pack.pools)  # type: Dict[str, int]
    rows = dict((name, 0) for name in pack.pools)  # type: Dict[str, int]
    fixed = dict((name, 0) for name in pack.pools)  # type: Dict[str, int]
    variable = dict((name, 0) for name in pack.pools)  # type: Dict[str, int]
    unallocated = 0
    unallocated_rows = 0
    cogs_sum = 0
    cogs_rows = 0
    saw_rows = False
    for row in line_items:
        if not isinstance(row, dict):
            continue
        bucket = str(row.get("bucket") or "")
        if bucket not in (OPEX_BUCKET, COGS_BUCKET):
            continue
        saw_rows = True
        amount = cents_from(row.get("amount") or 0)
        if bucket == COGS_BUCKET:
            cogs_sum += amount
            cogs_rows += 1
            continue
        code = str(row.get("ro_account_code") or row.get("code") or "").strip()
        pool = pack.pool_of(code)
        if pool is None:
            unallocated += amount
            unallocated_rows += 1
            continue
        sums[pool] += amount
        rows[pool] += 1
        nature = pack.nature_of(code)
        if nature == "fixed":
            fixed[pool] += amount
        else:
            variable[pool] += amount
    if not saw_rows:
        return refused_split("no_line_items", opex_total_cents=opex_total_cents,
                             cogs_total_cents=cogs_total_cents, revenue_cents=revenue_cents,
                             pack=pack, source="no_line_items")
    if sum(sums.values()) + unallocated != opex_total_cents or cogs_sum != cogs_total_cents:
        return refused_split("rows_disagree", opex_total_cents=opex_total_cents,
                             cogs_total_cents=cogs_total_cents, revenue_cents=revenue_cents,
                             pack=pack, source="rows_disagree")
    if opex_total_cents != 0:
        share = mul_div(abs(unallocated), MICRO, abs(opex_total_cents))
    else:
        share = 0
    if share > pack.micros("max_unallocated_share"):
        classified_base = sum(v for v in sums.values() if v > 0)
        classified_fixed = sum(fixed[n] for n in sums if sums[n] > 0)
        aggregate = mul_div(classified_fixed, MICRO, classified_base) if classified_base > 0 else 0
        aggregate = max(0, min(MICRO, aggregate))
        return refused_split("max_unallocated_share", opex_total_cents=opex_total_cents,
                             cogs_total_cents=cogs_total_cents, revenue_cents=revenue_cents,
                             share_micros=aggregate, amount_cents=unallocated, pack=pack,
                             source="line_items")
    pooled = [_classified_pool(pack, name, sums[name], rows[name], fixed[name], variable[name],
                               [p for p, n in pack.prefixes.items() if n == name], revenue_cents)
              for name in pack.pools]
    opex = pooled + [_unallocated_pool(pack, unallocated, unallocated_rows, pooled, revenue_cents)]
    return PoolSplit(_cost_of_sales_pool(pack, cogs_sum, cogs_rows), opex, refused=False,
                     refusal_rule_id=None, unallocated_cents=unallocated,
                     unallocated_share_micros=share, revenue_cents=revenue_cents,
                     opex_total_cents=opex_total_cents, source="line_items")


def split_for_payload(payload: Dict[str, Any]) -> PoolSplit:
    """The pool split of a period payload: its line items against its
    assembled P&L totals."""
    statements = payload.get("statements") if isinstance(payload, dict) else None
    pl = (statements or {}).get("assembled_pl") if isinstance(statements, dict) else None
    pl = pl if isinstance(pl, dict) else {}
    revenue = cents_from(pl.get("revenue") or 0)
    opex = cents_from(pl.get("opex_excluding_cogs_and_da") or 0)
    cogs = cents_from(pl.get("cogs") or 0)
    items = payload.get("line_items") if isinstance(payload, dict) else None
    return split_pools(items if isinstance(items, list) else None, revenue_cents=revenue,
                       opex_total_cents=opex, cogs_total_cents=cogs)
