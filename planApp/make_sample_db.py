#!/usr/bin/env python3
"""
Generate a sample parts database (data/parts.db).

Your own database can use ANY table/column names -- map them in Settings.
Default expected columns:
    part_no, description, category, unit, cost, retail, labour
where `labour` = labour hours per unit (per item, or per metre for cable).
"""
import os, sqlite3
HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "data", "parts.db")

PARTS = [
    # part_no, description, category, unit, cost, retail, labour(hrs/unit)
    ("EL-GPO-1", "Single GPO 10A white", "electrical", "each", 4.20, 11.50, 0.35),
    ("EL-GPO-2", "Double GPO 10A white", "electrical", "each", 6.10, 16.90, 0.45),
    ("EL-SW-1", "1 gang light switch", "electrical", "each", 3.40, 9.50, 0.30),
    ("EL-SW-2", "2 gang light switch", "electrical", "each", 4.80, 13.20, 0.40),
    ("EL-LED-DL", "LED downlight 10W dimmable", "electrical", "each", 9.80, 28.00, 0.40),
    ("EL-BATTEN", "LED batten 1200mm", "electrical", "each", 18.50, 49.00, 0.50),
    ("EL-EXH", "Exhaust fan 250mm", "electrical", "each", 32.00, 79.00, 0.80),
    ("EL-SMOKE", "Photoelectric smoke alarm 240V", "electrical", "each", 22.00, 59.00, 0.40),
    ("EL-DB", "Distribution board 12 pole", "electrical", "each", 85.00, 210.00, 2.50),
    ("CBL-TPS-2.5", "2.5mm2 TPS twin & earth cable", "electrical", "m", 1.85, 3.90, 0.06),
    ("CBL-TPS-1.5", "1.5mm2 TPS twin & earth cable", "electrical", "m", 1.30, 2.80, 0.05),
    ("CBL-TPS-6", "6mm2 TPS twin & earth cable", "electrical", "m", 3.60, 7.40, 0.08),
    ("CON-20", "20mm corrugated conduit", "electrical", "m", 0.95, 2.10, 0.04),
    ("CON-25", "25mm corrugated conduit", "electrical", "m", 1.25, 2.80, 0.05),
    ("DT-RJ45", "Cat6 RJ45 data outlet", "data", "each", 5.50, 15.00, 0.40),
    ("DT-WAP", "Wireless access point mount/point", "data", "each", 12.00, 35.00, 0.60),
    ("DT-PP24", "24 port Cat6 patch panel", "data", "each", 48.00, 120.00, 1.50),
    ("DT-RACK", "9RU wall mount comms cabinet", "data", "each", 145.00, 360.00, 2.00),
    ("DT-PHONE", "Telephone outlet RJ12", "data", "each", 4.20, 12.00, 0.40),
    ("DT-TV", "TV / coax outlet", "data", "each", 6.00, 16.50, 0.40),
    ("CBL-CAT6", "Cat6 U/UTP data cable", "data", "m", 0.65, 1.85, 0.05),
    ("CBL-CAT6A", "Cat6A F/UTP data cable", "data", "m", 1.20, 3.10, 0.06),
    ("CBL-COAX", "RG6 quad shield coax", "data", "m", 0.80, 2.20, 0.05),
    ("CBL-FIBRE", "OM4 multimode fibre 2 core", "data", "m", 2.40, 6.50, 0.10),
    ("MX-DIFF", "Supply air square diffuser 300mm", "mechanical", "each", 28.00, 72.00, 0.60),
    ("MX-GRILLE", "Return air grille 400x400", "mechanical", "each", 34.00, 85.00, 0.60),
    ("MX-FCU", "Fan coil unit ceiling cassette", "mechanical", "each", 420.00, 980.00, 3.00),
    ("MX-STAT", "Wall thermostat / controller", "mechanical", "each", 38.00, 95.00, 0.50),
    ("MX-HEAD", "Split system indoor head 2.5kW", "mechanical", "each", 360.00, 820.00, 4.00),
    ("MX-COND", "Split system condenser 2.5kW", "mechanical", "each", 410.00, 940.00, 4.00),
    ("DUCT-200", "Flexible duct 200mm insulated", "mechanical", "m", 7.50, 18.00, 0.15),
    ("DUCT-250", "Flexible duct 250mm insulated", "mechanical", "m", 9.20, 22.00, 0.18),
    ("PIPE-CU-1/4", "Copper refrigerant pipe 1/4 inch", "mechanical", "m", 4.10, 9.80, 0.12),
    ("PIPE-CU-3/8", "Copper refrigerant pipe 3/8 inch", "mechanical", "m", 5.40, 12.50, 0.14),
    ("MX-CTRL-CBL", "2 core mechanical control cable", "mechanical", "m", 1.10, 2.60, 0.05),
]

def build():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    if os.path.exists(DB_PATH): os.remove(DB_PATH)
    con = sqlite3.connect(DB_PATH); cur = con.cursor()
    cur.execute("""CREATE TABLE parts (
        part_no TEXT PRIMARY KEY, description TEXT NOT NULL, category TEXT,
        unit TEXT, cost REAL, retail REAL, labour REAL)""")
    cur.executemany("INSERT INTO parts VALUES (?,?,?,?,?,?,?)", PARTS)
    con.commit()
    n = cur.execute("SELECT COUNT(*) FROM parts").fetchone()[0]; con.close()
    print(f"Wrote {n} parts to {DB_PATH}")

if __name__ == "__main__":
    build()
