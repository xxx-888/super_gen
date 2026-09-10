"""通用小工具"""


def escape_like(value: str) -> str:
    """转义 LIKE/ILIKE 模式中的通配符（% _ \）为字面量。

    PostgreSQL 默认转义符为反斜杠：\% 匹配字面 %。
    所有用户输入进 ilike 搜索的地方都必须先过这个函数，
    否则用户输入 % 可全表匹配（性能/枚举面）。
    """
    return (value or "").replace("\\", "\\\\").replace("%", "\%").replace("_", "\_")
