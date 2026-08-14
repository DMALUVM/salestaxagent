from __future__ import annotations

from src.config import load_fc_codes


_fc_map: dict[str, str] | None = None


def _get_fc_map() -> dict[str, str]:
    global _fc_map
    if _fc_map is None:
        _fc_map = load_fc_codes()
    return _fc_map


def fc_to_state(fc_code: str) -> str | None:
    fc_map = _get_fc_map()
    normalized = fc_code.strip().upper()
    if normalized in fc_map:
        return fc_map[normalized]
    prefix = "".join(c for c in normalized if c.isalpha())
    for key, state in fc_map.items():
        key_prefix = "".join(c for c in key if c.isalpha())
        if key_prefix == prefix:
            return state
    return None


def get_unknown_fcs(fc_codes: list[str]) -> list[str]:
    return [fc for fc in fc_codes if fc_to_state(fc) is None]


def add_fc_mapping(fc_code: str, state_code: str) -> None:
    fc_map = _get_fc_map()
    fc_map[fc_code.strip().upper()] = state_code.strip().upper()
