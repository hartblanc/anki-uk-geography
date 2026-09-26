import random
import string


def generate_anki_guid() -> str:
    """Return a base91-encoded 64bit random number."""

    def base62(num: int, extra: str = "") -> str:
        s = string
        table = s.ascii_letters + s.digits + extra
        buf = ""
        while num:
            num, i = divmod(num, len(table))
            buf = table[i] + buf
        return buf

    _base91_extra_chars = "!#$%&()*+,-./:;<=>?@[]^_`{|}~"

    def base91(num: int) -> str:
        # all printable characters minus quotes, backslash and separators
        return base62(num, _base91_extra_chars)

    return base91(random.randint(0, 2**64 - 1))


print(generate_anki_guid())
