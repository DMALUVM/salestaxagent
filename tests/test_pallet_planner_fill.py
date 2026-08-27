"""Pallet fill: ≥50% partial is a card; under half is merge-or-hold."""
from __future__ import annotations

from src.inventory.pallet_planner import (
    AMAZON_CASES_PER_PALLET,
    CARTON_13X11X9_UNITS,
    LIP_BALM_SKUS,
    PALLET_MAX_UNITS,
    PALLET_PARTIAL_MIN_RATIO,
    allocate_pallet_cards,
    pallet_card_sizes,
    pallet_fill,
    pallet_partial_min_units,
)

PARTIAL_MIN = 8_775  # 50% of 17,550


def test_amazon_pallet_is_17550_not_19000():
    assert AMAZON_CASES_PER_PALLET == 65
    assert CARTON_13X11X9_UNITS == 270
    assert PALLET_MAX_UNITS == 17_550
    assert PALLET_MAX_UNITS == 65 * 270
    assert PALLET_MAX_UNITS != 19_000
    assert pallet_partial_min_units() == 8_775
    fill = pallet_fill(PALLET_MAX_UNITS)
    assert fill["full_pallets"] == 1
    assert fill["has_partial"] is False
    assert fill["held_units"] == 0
    assert pallet_card_sizes(fill) == [17_550]


def test_partial_min_is_half_a_pallet():
    assert PALLET_PARTIAL_MIN_RATIO == 0.5
    assert pallet_partial_min_units() == PARTIAL_MIN
    assert pallet_partial_min_units(PALLET_MAX_UNITS) == 8_775


def test_thousand_leftover_is_held_not_a_card():
    fill = pallet_fill(1_000)
    assert fill["full_pallets"] == 0
    assert fill["has_partial"] is False
    assert fill["held_units"] == 1_000
    assert fill["merge_or_hold"] is True
    assert fill["is_pallet_card"] is False
    assert pallet_card_sizes(fill) == []
    one_full_plus = pallet_fill(PALLET_MAX_UNITS + 1_000)
    assert one_full_plus["full_pallets"] == 1
    assert one_full_plus["held_units"] == 1_000
    assert one_full_plus["has_partial"] is False
    assert pallet_card_sizes(one_full_plus) == [17_550]


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
    assert pallet_card_sizes(fill) == [17_550, 17_550, 8_775]


def test_one_full_plus_under_half_holds_leftover():
    fill = pallet_fill(PALLET_MAX_UNITS + 4276)
    assert fill["full_pallets"] == 1
    assert fill["has_partial"] is False
    assert fill["held_units"] == 4276
    assert fill["pallet_cards"] == 1
    assert pallet_card_sizes(fill) == [17_550]


def test_allocate_emits_partial_and_holds_under_half():
    # 2 full + 8,775 partial — three cards, mix unlocked
    gaps = {
        "DDPE0001Shop": 11_000,
        "DDPE0002Shop": 11_000,
        "DDPE0003Shop": 11_000,
        "DDPE0004Shop": 10_875,
    }
    assert sum(gaps.values()) == 2 * PALLET_MAX_UNITS + PARTIAL_MIN
    cards, leftover, fill = allocate_pallet_cards(gaps, LIP_BALM_SKUS)
    assert fill["pallet_cards"] == 3
    assert len(cards) == 3
    assert cards[0]["total_units"] == 17_550
    assert cards[1]["total_units"] == 17_550
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
