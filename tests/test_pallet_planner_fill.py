"""Pallet fill: ≥50% partial is a card; under half is merge-or-hold."""
from __future__ import annotations

from src.inventory.pallet_planner import (
    LIP_BALM_SKUS,
    PALLET_MAX_UNITS,
    PALLET_PARTIAL_MIN_RATIO,
    allocate_pallet_cards,
    pallet_card_sizes,
    pallet_fill,
    pallet_partial_min_units,
)

PARTIAL_MIN = 9_500  # 50% of 19,000


def test_partial_min_is_half_a_pallet():
    assert PALLET_PARTIAL_MIN_RATIO == 0.5
    assert pallet_partial_min_units() == PARTIAL_MIN
    assert pallet_partial_min_units(PALLET_MAX_UNITS) == 9_500


def test_4276_is_held_not_a_pallet_card():
    fill = pallet_fill(4276)
    assert fill["full_pallets"] == 0
    assert fill["has_partial"] is False
    assert fill["partial_units"] == 0
    assert fill["held_units"] == 4276
    assert fill["pallet_cards"] == 0
    assert fill["is_pallet_card"] is False
    assert fill["merge_or_hold"] is True
    assert fill["leftover_pct"] < 0.50
    assert pallet_card_sizes(fill) == []


def test_just_under_half_is_held():
    fill = pallet_fill(PARTIAL_MIN - 1)
    assert fill["has_partial"] is False
    assert fill["held_units"] == PARTIAL_MIN - 1
    assert fill["is_pallet_card"] is False
    assert fill["merge_or_hold"] is True
    assert pallet_card_sizes(fill) == []


def test_half_pallet_is_a_partial_card():
    fill = pallet_fill(PARTIAL_MIN)
    assert fill["full_pallets"] == 0
    assert fill["has_partial"] is True
    assert fill["partial_units"] == PARTIAL_MIN
    assert fill["held_units"] == 0
    assert fill["pallet_cards"] == 1
    assert fill["is_pallet_card"] is True
    assert fill["merge_or_hold"] is False
    assert pallet_card_sizes(fill) == [PARTIAL_MIN]


def test_two_full_plus_one_partial_is_fine():
    units = 2 * PALLET_MAX_UNITS + PARTIAL_MIN  # 47,500
    fill = pallet_fill(units)
    assert fill["full_pallets"] == 2
    assert fill["has_partial"] is True
    assert fill["partial_units"] == PARTIAL_MIN
    assert fill["held_units"] == 0
    assert fill["pallet_cards"] == 3
    assert fill["is_pallet_card"] is True
    assert pallet_card_sizes(fill) == [19_000, 19_000, 9_500]


def test_one_full_plus_under_half_holds_leftover():
    fill = pallet_fill(PALLET_MAX_UNITS + 4276)
    assert fill["full_pallets"] == 1
    assert fill["has_partial"] is False
    assert fill["held_units"] == 4276
    assert fill["pallet_cards"] == 1
    assert pallet_card_sizes(fill) == [19_000]


def test_allocate_emits_partial_and_holds_under_half():
    # 2 full + 9,500 partial — three cards, mix unlocked
    gaps = {
        "DDPE0001Shop": 12_000,
        "DDPE0002Shop": 12_000,
        "DDPE0003Shop": 12_000,
        "DDPE0004Shop": 11_500,
    }
    assert sum(gaps.values()) == 2 * PALLET_MAX_UNITS + PARTIAL_MIN
    cards, leftover, fill = allocate_pallet_cards(gaps, LIP_BALM_SKUS)
    assert fill["pallet_cards"] == 3
    assert len(cards) == 3
    assert cards[0]["total_units"] == 19_000
    assert cards[1]["total_units"] == 19_000
    assert cards[2]["partial"] is True
    assert cards[2]["total_units"] == PARTIAL_MIN
    assert all(c["locked"] is False for c in cards)
    assert leftover == {}

    # 4,276 leftover is held — not a fourth / first card
    tiny = {sku: 0 for sku in LIP_BALM_SKUS}
    tiny["DDPE0001Shop"] = 4276
    cards, leftover, fill = allocate_pallet_cards(tiny, LIP_BALM_SKUS)
    assert cards == []
    assert fill["merge_or_hold"] is True
    assert leftover["DDPE0001Shop"] == 4276
