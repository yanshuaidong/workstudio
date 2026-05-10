def clamp_pagination(skip: int, limit: int) -> tuple[int, int]:
    s = max(skip, 0)
    lim = min(max(limit, 1), 500)
    return s, lim
