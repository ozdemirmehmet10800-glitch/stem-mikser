"""Yapıştır-hizala ek düzeltmesi: TEKRAR EDEN KITADA SIKIŞAN KOPYA (2026-11-28).

Sorun ("холод по спине"): metinde nakarat art arda iki kez yazılı, seste o noktada bir kez söyleniyor (ikinci tekrar şarkının
ilerisinde). Sıralı eşleştirme (Needleman-Wunsch) otomatik kelimeleri İKİNCİ kopyaya bağladı; birinci kopya iki çapa arasındaki
1,5 sn'lik boşluğa sıkıştı (satır başı 0,24 sn) ve ekran o satırları bir anda geçti.

Düzeltme: eşleşmeyen ("free") ardışık satırların penceresi satır başına MIN_SECONDS_PER_LINE'dan kısaysa ve hemen ardından (ya da
hemen önünden) AYNI metinli, eşleşmiş bir kopya geliyorsa, eşleşmeler o kopyadan sıkışan kopyaya taşınır: sıkışan kopya çapa olur,
öbür kopya serbest kalır ve geniş pencereye (sonraki çapaya / şarkı sonuna kadar) yerleşir. Değişiklik ancak yeni plan daha iyiyse
(sıkışan satır sayısı azalıyorsa) kabul edilir. Başka hiçbir durumda eşleşmelere dokunulmaz.

app.py'nin satır sayısı Modal imaj önbelleğine girdiği için ayrı dosya (bkz. coverart.py). Saf Python, GPU/ağ yok:
tests/test_lyricsfix.py.
"""

MIN_SECONDS_PER_LINE = 1.0
MAX_ROUNDS = 4


def _free_runs(plan):
    runs, i, n = [], 0, len(plan)
    while i < n:
        if plan[i]["kind"] == "free":
            j = i
            while j < n and plan[j]["kind"] == "free":
                j += 1
            runs.append((i, j))
            i = j
        else:
            i += 1
    return runs


def _window(plan, a, b, duration):
    if a > 0:
        prev = plan[a - 1]
        lo = prev.get("end", prev.get("start", 0.0)) if prev["kind"] == "anchor" else prev.get("start", 0.0)
    else:
        lo = 0.0
    hi = plan[b]["start"] if b < len(plan) and "start" in plan[b] else float(duration)
    return max(hi - lo, 0.0)


def squeezed_lines(plan, duration):
    """Sıkışan serbest satırların sayısı (pencere < satır sayısı x MIN_SECONDS_PER_LINE)."""
    total = 0
    for a, b in _free_runs(plan):
        if _window(plan, a, b, duration) < MIN_SECONDS_PER_LINE * (b - a):
            total += b - a
    return total


def _offsets(line_tokens):
    out, offset = [], 0
    for tokens in line_tokens:
        out.append(offset)
        offset += len(tokens)
    return out


def _move(pairs, line_tokens, offsets, src, dst, count):
    """src..src+count satırlarının eşleşmelerini dst..dst+count satırlarına taşır (satır içi konum aynı)."""
    moved = dict(pairs)
    for k in range(count):
        s_line, d_line = src + k, dst + k
        for pos in range(len(line_tokens[s_line])):
            key = offsets[s_line] + pos
            if key in moved:
                moved[offsets[d_line] + pos] = moved.pop(key)
    return moved


def reassign_squeezed(line_tokens, pairs, plan_fn, duration):
    """Eşleşmeleri gerekirse taşır. plan_fn(pairs) -> plan (app.py _lyr_plan). Dönen: (pairs, bilgi listesi)."""
    offsets = _offsets(line_tokens)
    notes = []
    for _ in range(MAX_ROUNDS):
        plan = plan_fn(pairs)
        before = squeezed_lines(plan, duration)
        if not before:
            break
        changed = False
        for a, b in _free_runs(plan):
            k = b - a
            if _window(plan, a, b, duration) >= MIN_SECONDS_PER_LINE * k:
                continue
            same = lambda x, y: all(line_tokens[x + i] == line_tokens[y + i] for i in range(k))
            anchored = lambda x: all(plan[x + i]["kind"] == "anchor" for i in range(k))
            for other in (b, a - k):                         # önce hemen arkasındaki, sonra hemen önündeki kopya
                if other < 0 or other + k > len(plan) or not anchored(other) or not same(a, other):
                    continue
                trial = _move(pairs, line_tokens, offsets, other, a, k)
                after = squeezed_lines(plan_fn(trial), duration)
                if after < before:
                    pairs = trial
                    notes.append({"squeezed": [a, b], "from": [other, other + k], "squeezed_before": before, "squeezed_after": after})
                    changed = True
                    break
            if changed:
                break
        if not changed:
            break
    return pairs, notes
