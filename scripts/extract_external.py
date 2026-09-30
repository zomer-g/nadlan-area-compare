"""Extract the lookup tables from the user-supplied Excel files into
data/external/*.csv, and write data/external/sources.json describing them.

These tables are an EXTERNAL source: they do not come from OVER, they were
compiled by hand by a site user. The manifest records that, per table, so the
page can attribute every number that passes through one of them.

    python scripts/extract_external.py <enrichment.xlsx> <analysis.xlsx>

Re-running overwrites the CSVs; nothing else reads the Excel files.
"""
import csv
import json
import sys
from datetime import date
from pathlib import Path

import openpyxl

OUT = Path(__file__).resolve().parent.parent / "data" / "external"


def helper_rows(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    return list(wb.worksheets[0].iter_rows(values_only=True))  # "גיליון עזר"


def block(rows, c0, c1):
    """One side-by-side table of a helper sheet: header row + non-empty rows."""
    out = [tuple(r[c0:c1]) for r in rows if any(v not in (None, "") for v in r[c0:c1])]
    return out[0], out[1:]


def clean(v):
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, str):
        return v.strip()
    return v


def write(name, header, rows):
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / f"{name}.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows([[clean(v) for v in r] for r in rows])
    return len(rows)


def dedupe(rows, key=0):
    """Keep the first row per key; report keys that map to two values."""
    seen, out, conflicts = {}, [], []
    for r in rows:
        k = clean(r[key])
        if k in (None, ""):
            continue
        if k in seen:
            if seen[k] != r:
                conflicts.append(k)
            continue
        seen[k] = r
        out.append(r)
    return out, conflicts


def main(enrich_path, analysis_path):
    e = helper_rows(enrich_path)
    a = helper_rows(analysis_path)
    tables = {}
    origin_e = {"file": Path(enrich_path).name, "sheet": "גיליון עזר"}
    origin_a = {"file": Path(analysis_path).name, "sheet": "גיליון עזר"}

    # 1. deal nature -> asset type, the classification the analysis file uses
    _, rows = block(a, 1, 3)
    rows, conf = dedupe(rows)
    tables["nature_asset_type"] = {
        "title": "סיווג מהות עסקה לסוג נכס (קטגוריות מפ\"י)",
        "columns": {"deal_nature": "מהות העסקה כפי שמופיעה במאגר רשות המסים", "asset_type": "סוג נכס"},
        "rows": write("nature_asset_type", ["deal_nature", "asset_type"], rows),
        "origin": {**origin_a, "columns": "B:C"},
        "join": "deal_nature = deals.deal_nature (טקסט מדויק)",
        "conflicts": conf,
    }

    # 2. deal nature -> use, the finer classification in the enrichment file
    _, rows = block(e, 0, 2)
    rows, conf = dedupe(rows)
    tables["nature_use"] = {
        "title": "סיווג מהות עסקה לשימוש (גרסת קובץ ההעשרה)",
        "columns": {"deal_nature": "מהות העסקה", "use": "שימוש"},
        "rows": write("nature_use", ["deal_nature", "use"], rows),
        "origin": {**origin_e, "columns": "A:B"},
        "join": "deal_nature = deals.deal_nature (טקסט מדויק)",
        "conflicts": conf,
    }

    # 3. size groups: the file's VLOOKUP bounds verbatim, plus the half-open
    # interval they actually implement (lower_raw is 'previous upper + 1 − ε').
    _, rows = block(a, 5, 8)
    out = []
    for lo, hi, label in rows:
        out.append([lo, hi, label])
    tables["size_groups"] = {
        "title": "קבוצות גודל לפי שטח הנכס",
        "columns": {"lower_raw": "גבול תחתון כפי שבקובץ (VLOOKUP מקורב)", "upper_raw": "גבול עליון כפי שבקובץ", "label": "תווית בקובץ"},
        "rows": write("size_groups", ["lower_raw", "upper_raw", "label"], out),
        "origin": {**origin_a, "columns": "F:H"},
        "note": "ב-VLOOKUP מקורב שטח נופל לשורה עם הגבול התחתון הגדול ביותר שאינו עולה עליו, ולכן התוויות אינן הגבולות בפועל: 'ללא גודל' מכסה 0 עד פחות מ-1.999999, '1-54' מכסה 1.999999 עד פחות מ-54.999999, וכן הלאה. ביישום יוגדרו גבולות מפורשים.",
    }

    # 4. gush -> neighbourhood (approximate: a gush is not always one neighbourhood)
    # A gush that spans two neighbourhoods is listed once per neighbourhood. The
    # file's VLOOKUP silently took the first; here both rows stay, flagged.
    _, rows = block(a, 13, 16)
    counts = {}
    for r in rows:
        counts[clean(r[0])] = counts.get(clean(r[0]), 0) + 1
    conf = sorted(k for k, n in counts.items() if n > 1)
    rows = [list(r) + [counts[clean(r[0])] > 1] for r in rows]
    tables["gush_neighborhood"] = {
        "title": "מיפוי גוש לשכונה",
        "columns": {"gush": "מספר גוש", "neighborhood": "שם השכונה", "authority": "רשות",
                    "ambiguous": "הגוש מופיע ביותר משכונה אחת"},
        "rows": write("gush_neighborhood", ["gush", "neighborhood", "authority", "ambiguous"], rows),
        "origin": {**origin_a, "columns": "N:P"},
        "join": "gush = deals.gush",
        "note": "קירוב: גוש אינו תמיד חופף לשכונה. ברירת המחדל בקובץ לגוש שלא ממופה היא 'רחבי העיר'. חלק מהשורות ללא רשות. גושים שמופיעים בשתי שכונות מסומנים ambiguous — בקובץ המקורי נבחרה הראשונה.",
        "conflicts": conf,
    }

    # 5. building year -> period
    _, rows = block(e, 8, 10)
    rows, conf = dedupe(rows)
    tables["building_year_period"] = {
        "title": "שנת בנייה לתקופת בנייה",
        "columns": {"year_built": "שנת בנייה", "period": "תקופה"},
        "rows": write("building_year_period", ["year_built", "period"], rows),
        "origin": {**origin_e, "columns": "I:J"},
        "join": "year_built = deals.year_built",
        "note": "ערכים לא סבירים (0, 1, 99, שנים עתידיות) ממופים ל'לא ידוע'.",
    }

    # 6. month -> quarter
    _, rows = block(e, 3, 5)
    tables["month_quarter"] = {
        "title": "חודש לרבעון",
        "columns": {"month": "חודש", "quarter": "רבעון"},
        "rows": write("month_quarter", ["month", "quarter"], rows),
        "origin": {**origin_e, "columns": "D:E"},
    }

    # 7. settlements with CBS attributes (the copy that carries the CBS code)
    hdr, rows = block(e, 33, 47)
    cols = ["name", "code", "founded", "district_code", "district", "subdistrict", "natural_region",
            "metropolin", "settlement_type_code", "settlement_type", "municipal_status",
            "authority_cluster", "authority_cluster_code", "area"]
    rows, conf = dedupe(rows)
    tables["settlements_cbs"] = {
        "title": "יישובים ומאפייני הלמ\"ס",
        "columns": dict(zip(cols, [clean(h) for h in hdr])),
        "rows": write("settlements_cbs", cols, rows),
        "origin": {**origin_e, "columns": "AH:AU"},
        "join": "code = over_settlement_code(deals.settlement) — לא לפי שם",
        "note": "נתוני הלמ\"ס כפי שהועתקו לקובץ. OVER מחזיק בחלק מהשדות (over_settlements: מחוז, נפה, מעמד מוניציפלי) אך לא באזור טבעי, מטרופולין, צורת יישוב ואשכול רשויות.",
        "conflicts": conf,
    }

    # 8. the definitions of the computed columns, as documentation
    _, rows = block(e, 26, 30)
    tables["computed_parameters"] = {
        "title": "הגדרות הפרמטרים המחושבים בקובץ ההעשרה",
        "columns": {"parameter": "שם הפרמטר", "ref1": "פרמטר ייחוס 1", "ref2": "פרמטר ייחוס 2", "operator": "אופרטור"},
        "rows": write("computed_parameters", ["parameter", "ref1", "ref2", "operator"], rows),
        "origin": {**origin_e, "columns": "AA:AD"},
    }

    manifest = {
        "sources": {
            "over": {
                "type": "api",
                "title": "גרסאות לעם (OVER)",
                "url": "https://www.over.org.il",
                "note": "מקור הנתונים העיקרי: מאגר העסקאות, שכבת החלקות ושכבות מרחביות.",
            },
            "user_feedback_2026_09": {
                "type": "external",
                "title": "טבלאות עזר ממשתמש האתר",
                "received": str(date.today()),
                "note": "טבלאות שנבנו ידנית על ידי משתמש האתר ונמסרו כחלק מפידבק. אינן מקור רשמי; כל תוצאה שעוברת דרכן מסומנת בהתאם.",
                "tables": tables,
            },
        }
    }
    (OUT / "sources.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    for k, t in tables.items():
        print(f"{k}: {t['rows']} rows" + (f"  conflicts={t['conflicts']}" if t.get("conflicts") else ""))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
