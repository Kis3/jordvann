#!/usr/bin/env python3
"""
Skredvarsel Fv 609 Heilevang – Scenarioanalyse
===============================================
Henter historisk vannmetning (seNorge ODM/HBV pikselekstraksjon) og nedbør
(Frost API + seNorge GTS) for siste 365 dager. Kobler faktisk vannmetnings-
klasse med nedbørsdata for å bestemme aktivt scenario per dag og flagge dager
der BÅDE vannmetning OG nedbør overskred de aktive tersklene.

Kjør:  python scenarioanalyse.py
Krav:  pip install requests pandas matplotlib Pillow
"""

import requests
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import matplotlib.patches as mpatches
import numpy as np
from matplotlib.backends.backend_pdf import PdfPages
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
import matplotlib.image as mpimg
import os, math, time

# ─── Konfigurasjon ────────────────────────────────────────────────────────────
CLIENT_ID    = 'ff18c1d5-0abc-4af7-bccb-e4e3fe8ff3ad'
STATION_ID   = 'SN57480'
STATION_NAME = 'Botnen i Førde (SN57480)'

# Senter for pikselhenting (Fv609-korridoren)
LAT, LON = 61.4387, 5.5463

# Terskelverdier
SCENARIO1 = {'no': 1, 'threshD': 40, 'threshH': 10,
             'desc': 'Fuktig jord (≥70 % vannmetning)'}
SCENARIO2 = {'no': 2, 'threshD': 60, 'threshH': 15,
             'desc': 'Tørr jord (<70 % vannmetning)'}

# seNorge ImageServer
SENORGE_URL = ('https://gis3.nve.no/image/rest/services/seNorgeGrid'
               '/odmhbv_ssspct/ImageServer/exportImage')

# Faktiske pikselfarger fra seNorge (RGB 0-255)
SM_COLORS = [
    {'r': 204, 'g':   0, 'b':   0, 'label': 'Over 90 %',  'midPct': 95, 'color': '#cc0000'},
    {'r': 248, 'g': 196, 'b':   0, 'label': '80–90 %',    'midPct': 85, 'color': '#e07820'},
    {'r': 248, 'g': 252, 'b':   0, 'label': '70–80 %',    'midPct': 75, 'color': '#f5c000'},
    {'r':  40, 'g': 212, 'b':  96, 'label': '60–70 %',    'midPct': 65, 'color': '#91cf60'},
    {'r': 229, 'g': 229, 'b': 229, 'label': 'Under 60 %', 'midPct': 30, 'color': '#d0d0d0'},
]
SM_COLOR_LABELS = [c['label'] for c in SM_COLORS]
SM_COLOR_HEX    = [c['color'] for c in SM_COLORS]


# ─── Hjelpefunksjoner ─────────────────────────────────────────────────────────
def latlon_to_utm33(lat, lon):
    try:
        from pyproj import Proj
        p = Proj(proj='utm', zone=33, datum='WGS84')
        x, y = p(lon, lat)
        return int(round(x)), int(round(y))
    except ImportError:
        # Eksakt WGS84 → UTM sone 33 (Krüger-serien), riktig også 9–10° fra
        # sentralmeridianen (15° Ø), der Vestlandet ligger. Den tidligere
        # lineære tilnærmingen rundt «Førde = 326000/6820000» brukte i praksis
        # sone 32-tall og plasserte punktene ~300 km for langt øst (Østerdalen).
        a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996
        n = f / (2 - f)
        A = a / (1 + n) * (1 + n**2 / 4 + n**4 / 64)
        alfa = (n / 2 - 2 * n**2 / 3 + 5 * n**3 / 16,
                13 * n**2 / 48 - 3 * n**3 / 5,
                61 * n**3 / 240)
        phi, dlam = math.radians(lat), math.radians(lon - 15)
        c = 2 * math.sqrt(n) / (1 + n)
        t = math.sinh(math.atanh(math.sin(phi)) - c * math.atanh(c * math.sin(phi)))
        xi = math.atan2(t, math.cos(dlam))
        eta = math.atanh(math.sin(dlam) / math.sqrt(1 + t * t))
        x = 500000 + k0 * A * (eta + sum(al * math.cos(2 * (j + 1) * xi) * math.sinh(2 * (j + 1) * eta)
                                         for j, al in enumerate(alfa)))
        y = k0 * A * (xi + sum(al * math.sin(2 * (j + 1) * xi) * math.cosh(2 * (j + 1) * eta)
                               for j, al in enumerate(alfa)))
        return int(round(x)), int(round(y))


def latlon_to_merc(lat, lon):
    """WGS84 → EPSG:3857."""
    R = 6378137
    x = lon * math.pi / 180 * R
    y = math.log(math.tan(math.pi / 4 + lat * math.pi / 360)) * R
    return x, y


def match_sm_class(r, g, b, alpha):
    """Matcher RGB-piksel mot kjente seNorge-farger. Returnerer SM_COLORS-entry eller None."""
    if alpha < 30:
        return None                          # gjennomsiktig = utenfor domene
    if r < 15 and g < 15 and b < 15:
        return None                          # nesten svart = hav/vann
    best, min_d = None, float('inf')
    for cls in SM_COLORS:
        d = math.sqrt((r - cls['r'])**2 + (g - cls['g'])**2 + (b - cls['b'])**2)
        if d < min_d:
            min_d = d
            best = cls
    return best if min_d < 120 else None


def stil_akse(ax):
    ax.set_facecolor('#161b22')
    ax.tick_params(colors='#8b949e')
    ax.xaxis.label.set_color('#8b949e')
    ax.yaxis.label.set_color('#8b949e')
    for sp in ['top', 'right']:  ax.spines[sp].set_visible(False)
    for sp in ['bottom', 'left']: ax.spines[sp].set_color('#30363d')
    ax.grid(axis='y', color='#21262d', linewidth=0.5)


# ─── Datahenting ──────────────────────────────────────────────────────────────
def hent_sm_dag(dato):
    """
    Henter vannmetningsklasse for ett punkt for én dato via seNorge ImageServer.
    Returnerer (dato, SM_COLORS-entry eller None).
    """
    # Epoch i ms for kl 12:00 UTC den aktuelle datoen
    epoch = int(datetime(dato.year, dato.month, dato.day, 12).timestamp() * 1000)

    d = 0.5   # stor nok bbox for at serveren skal rendre (≥ ~50 km)
    sw_x, sw_y = latlon_to_merc(LAT - d, LON - d)
    ne_x, ne_y = latlon_to_merc(LAT + d, LON + d)
    sz = 256

    params = (
        f"bbox={sw_x:.0f},{sw_y:.0f},{ne_x:.0f},{ne_y:.0f}"
        f"&bboxSR=3857&size={sz},{sz}&imageSR=3857"
        f"&format=png32&transparent=true&f=image&time={epoch}"
    )
    url = f"{SENORGE_URL}?{params}"

    try:
        resp = requests.get(url, timeout=20)
        if resp.status_code != 200 or len(resp.content) < 200:
            return dato, None

        img = mpimg.imread(BytesIO(resp.content))  # shape (sz, sz, 4) float 0-1
        cx = cy = sz // 2
        px = img[cy, cx]

        # Konverter float [0,1] → int [0,255]
        r, g, b = int(px[0]*255), int(px[1]*255), int(px[2]*255)
        a = int(px[3]*255) if img.shape[2] == 4 else 255

        return dato, match_sm_class(r, g, b, a)

    except Exception:
        return dato, None


def hent_sm_serie(datoer, max_workers=6):
    """Henter vannmetning for en liste med datoer parallelt."""
    resultater = {}
    total = len(datoer)
    ferdig = [0]

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(hent_sm_dag, d): d for d in datoer}
        for fut in as_completed(futures):
            dato, cls = fut.result()
            resultater[dato] = cls
            ferdig[0] += 1
            if ferdig[0] % 20 == 0 or ferdig[0] == total:
                print(f"    → {ferdig[0]}/{total} dager hentet …")

    return resultater


def hent_frost():
    print("  Henter daglige nedbørsverdier fra Frost API …")
    now = datetime.utcnow()
    fra = now - timedelta(days=365)
    r = requests.get(
        'https://frost.met.no/observations/v0.jsonld',
        params={
            'sources': f'{STATION_ID}:0',
            'elements': 'sum(precipitation_amount P1D)',
            'referencetime': f"{fra:%Y-%m-%dT%H:%M:%SZ}/{now:%Y-%m-%dT%H:%M:%SZ}",
            'limit': 10000,
        },
        auth=(CLIENT_ID, ''), timeout=60,
    )
    j = r.json()
    if 'error' in j:
        raise RuntimeError(f"Frost: {j['error'].get('reason', j['error'])}")

    recs = [{'dato': datetime.strptime(d['referenceTime'][:10], '%Y-%m-%d'),
             'mm_stasjon': d['observations'][0]['value'] or 0}
            for d in j.get('data', [])]
    df = pd.DataFrame(recs).sort_values('dato').set_index('dato')
    print(f"    → {len(df)} dagsverdier")
    return df


def hent_gts():
    print("  Henter døgnnedbør fra seNorge/gts.nve.no …")
    x, y = latlon_to_utm33(LAT, LON)
    now = datetime.utcnow()
    fra = now - timedelta(days=365)
    url = (f"https://gts.nve.no/api/GridTimeSeries/{x}/{y}"
           f"/{fra:%Y-%m-%d}/{now:%Y-%m-%d}/rr.csv")
    r = requests.get(url, timeout=30)
    lines = [l for l in r.text.strip().split('\n')
             if not l.startswith('#') and ';' in l]
    lines.pop(0)
    recs = []
    for l in lines:
        p = l.split(';')
        try:
            d, m, yr = p[0].strip().split(' ')[0].split('.')
            recs.append({'dato': datetime(int(yr), int(m), int(d)),
                         'mm_d': float(p[1].strip())})
        except Exception:
            pass
    df = pd.DataFrame(recs).sort_values('dato').set_index('dato')
    print(f"    → {len(df)} dagsverdier (seNorge rutenett)")
    return df


# ─── Analyse ──────────────────────────────────────────────────────────────────
def analyser(df_stasjon, df_gts, sm_serie):
    df = df_gts.join(df_stasjon, how='outer').fillna(0)

    sm_midpct  = {}
    sm_label   = {}
    sm_color   = {}
    for dato, cls in sm_serie.items():
        d = dato.date() if hasattr(dato, 'date') else dato
        key = datetime.combine(d, datetime.min.time())
        sm_midpct[key] = cls['midPct'] if cls else None
        sm_label[key]  = cls['label']  if cls else 'Ingen data'
        sm_color[key]  = cls['color']  if cls else '#444444'

    df['sm_pct']   = df.index.map(sm_midpct)
    df['sm_label'] = df.index.map(sm_label).fillna('Ingen data')
    df['sm_color'] = df.index.map(sm_color).fillna('#444444')

    # Aktivt scenario per dag
    def scenario(row):
        pct = row['sm_pct']
        if pd.isna(pct):
            return None
        return SCENARIO1 if pct >= 70 else SCENARIO2

    df['scenario'] = df.apply(scenario, axis=1)

    # Nedbør (maks av stasjon og seNorge)
    df['nedbor'] = df[['mm_d', 'mm_stasjon']].max(axis=1)

    # Terskeloverskridelse: riktig scenario aktivt OG nedbør over terskel
    def flag(row):
        sc = row['scenario']
        if sc is None:
            return False
        return row['nedbor'] >= sc['threshD']

    df['roed']  = df.apply(flag, axis=1)
    df['sc_no'] = df['scenario'].apply(lambda s: s['no'] if s else None)

    return df


# ─── Rapport ──────────────────────────────────────────────────────────────────
def generer_pdf(df, filnavn):
    plt.rcParams.update({'font.family': 'sans-serif', 'font.size': 9})
    BG, PANEL = '#0d1117', '#161b22'

    roed_n     = int(df['roed'].sum())
    sc1_roed   = int(((df['sc_no'] == 1) & df['roed']).sum())
    sc2_roed   = int(((df['sc_no'] == 2) & df['roed']).sum())
    sm_kjent   = df['sm_pct'].notna().sum()
    sm_total   = len(df)
    max_dogn   = float(df['nedbor'].max())
    periode_f  = df.index.min().strftime('%d.%m.%Y')
    periode_t  = df.index.max().strftime('%d.%m.%Y')
    genDato    = datetime.now().strftime('%d.%m.%Y kl. %H:%M')

    # Månedlig fordeling
    mn = df.groupby(df.index.to_period('M')).agg(
        roed=('roed', 'sum'),
        sc1=('sc_no', lambda x: ((x == 1) & df.loc[x.index, 'roed']).sum()),
        sc2=('sc_no', lambda x: ((x == 2) & df.loc[x.index, 'roed']).sum()),
        nedbor_sum=('nedbor', 'sum'),
    )
    mn.index = mn.index.to_timestamp()
    mnKeys = list(mn.index)

    with PdfPages(filnavn) as pdf:

        # ── Side 1: Forside ──────────────────────────────────────────────────
        fig = plt.figure(figsize=(11.69, 8.27))
        fig.patch.set_facecolor(BG)
        ax = fig.add_subplot(111); ax.axis('off'); ax.set_facecolor(BG)

        ax.text(0.5, 0.90, 'Skredvarsel Fv 609 Heilevang',
                transform=ax.transAxes, ha='center', fontsize=26,
                fontweight='bold', color='white')
        ax.text(0.5, 0.82, 'Scenarioanalyse – vannmetning × nedbør\nHistoriske varselsdager siste 365 dager',
                transform=ax.transAxes, ha='center', fontsize=13, color='#8b949e', linespacing=1.5)
        ax.text(0.5, 0.74, f'Periode: {periode_f} – {periode_t}',
                transform=ax.transAxes, ha='center', fontsize=11, color='#c9d1d9')

        tekst = (
            f"SAMMENDRAG\n\n"
            f"Dager med rød status (riktig scenario + nedbør over terskel):\n"
            f"   Totalt: {roed_n} dager\n"
            f"   · Scenario 1 (fuktig jord ≥70 %, terskel {SCENARIO1['threshD']} mm/d): {sc1_roed} dager\n"
            f"   · Scenario 2 (tørr jord <70 %, terskel {SCENARIO2['threshD']} mm/d): {sc2_roed} dager\n\n"
            f"Vannmetningsdata tilgjengelig: {sm_kjent}/{sm_total} dager\n"
            f"Høyeste døgnnedbør: {max_dogn:.1f} mm\n\n"
            f"Metode:\n"
            f"   Vannmetning: seNorge ODM/HBV pikselekstraksjon per dag (1×1 km)\n"
            f"   Nedbør: MET Frost API ({STATION_NAME}) + seNorge rutenett\n"
            f"   Scenario aktiveres av faktisk vannmetningsklasse den aktuelle datoen\n\n"
            f"Generert: {genDato}"
        )
        ax.text(0.5, 0.40, tekst, transform=ax.transAxes,
                ha='center', va='center', fontsize=10, color='#c9d1d9', linespacing=1.6,
                bbox=dict(boxstyle='round,pad=1', facecolor=PANEL, edgecolor='#30363d'))
        ax.text(0.5, 0.04, 'Utviklet av Norconsult Norge AS v/Torgeir Fiskum Hansvik',
                transform=ax.transAxes, ha='center', fontsize=8, color='#484f58')
        pdf.savefig(fig, facecolor=BG); plt.close()

        # ── Side 2: Tidsserie – vannmetning og nedbør ────────────────────────
        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11.69, 8.27),
                                        sharex=True, gridspec_kw={'hspace': 0.10})
        fig.patch.set_facecolor(BG)
        fig.suptitle('Vannmetning og nedbør – siste 365 dager',
                     color='white', fontsize=12, fontweight='bold')

        # Øvre: vannmetningsklasse som fargebånd
        stil_akse(ax1)
        for _, row in df.iterrows():
            ax1.axvspan(row.name - timedelta(hours=12),
                        row.name + timedelta(hours=12),
                        color=row['sm_color'], alpha=0.7, linewidth=0)
        ax1.set_ylabel('Vannmetning')
        ax1.set_yticks([])
        ax1.set_title('Vannmetningsklasse per dag (ODM/HBV)', color='#c9d1d9', fontsize=10)

        # Forklaring vannmetning
        sm_patches = [mpatches.Patch(color=c['color'], label=c['label']) for c in SM_COLORS]
        sm_patches.append(mpatches.Patch(color='#444444', label='Ingen data'))
        ax1.legend(handles=sm_patches, loc='upper right', facecolor=PANEL,
                   edgecolor='#30363d', labelcolor='#c9d1d9', fontsize=7, ncol=3)

        # Nedre: nedbør med varselsmarkering
        stil_akse(ax2)
        farger = ['#e94560' if r else '#2171b5' for r in df['roed']]
        ax2.bar(df.index, df['nedbor'], color=farger, width=0.9)

        # Terskellinjer
        ax2.axhline(SCENARIO1['threshD'], color='#f5c000', lw=1.2, ls='--',
                    label=f"Sc.1 terskel {SCENARIO1['threshD']} mm/d")
        ax2.axhline(SCENARIO2['threshD'], color='#e94560', lw=1.2, ls='--',
                    label=f"Sc.2 terskel {SCENARIO2['threshD']} mm/d")
        ax2.set_ylabel('mm/døgn')
        ax2.set_title('Døgnnedbør – rød = rød varselsstatus', color='#c9d1d9', fontsize=10)
        ax2.legend(facecolor=PANEL, edgecolor='#30363d', labelcolor='#c9d1d9', fontsize=8)
        ax2.xaxis.set_major_formatter(mdates.DateFormatter('%b %Y'))
        ax2.xaxis.set_major_locator(mdates.MonthLocator())
        plt.setp(ax2.xaxis.get_majorticklabels(), rotation=30, ha='right')

        fig.subplots_adjust(bottom=0.12)
        pdf.savefig(fig, facecolor=BG); plt.close()

        # ── Side 3: Månedlig sammendrag ──────────────────────────────────────
        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11.69, 8.27),
                                        gridspec_kw={'hspace': 0.4})
        fig.patch.set_facecolor(BG)
        fig.suptitle('Månedlig sammendrag', color='white', fontsize=12, fontweight='bold')

        x = np.arange(len(mnKeys)); w = 0.35
        stil_akse(ax1)
        b1 = ax1.bar(x - w/2, mn['sc1'], w, color='#f5c000cc', label='Sc.1 røde dager')
        b2 = ax1.bar(x + w/2, mn['sc2'], w, color='#e9456099', label='Sc.2 røde dager')
        ax1.set_xticks(x)
        ax1.set_xticklabels([d.strftime('%b\n%Y') for d in mnKeys], fontsize=8)
        ax1.set_ylabel('Antall dager')
        ax1.set_title('Røde varseldager per måned (nedbør + riktig scenario)',
                      color='#c9d1d9', fontsize=10)
        ax1.legend(facecolor=PANEL, edgecolor='#30363d', labelcolor='#c9d1d9', fontsize=8)
        for i, (s1, s2) in enumerate(zip(mn['sc1'], mn['sc2'])):
            if s1: ax1.text(i-w/2, s1+.05, str(int(s1)), ha='center', va='bottom',
                            fontsize=7, color='#f5c000')
            if s2: ax1.text(i+w/2, s2+.05, str(int(s2)), ha='center', va='bottom',
                            fontsize=7, color='#e94560')

        stil_akse(ax2)
        ax2.bar(mnKeys, mn['nedbor_sum'], width=20, color='#2171b5aa',
                label='Totalnedbør (mm)')
        ax2.set_ylabel('mm/måned')
        ax2.set_title('Månedlig totalnedbør', color='#c9d1d9', fontsize=10)
        ax2.xaxis.set_major_formatter(mdates.DateFormatter('%b %Y'))
        ax2.legend(facecolor=PANEL, edgecolor='#30363d', labelcolor='#c9d1d9', fontsize=8)
        pdf.savefig(fig, facecolor=BG); plt.close()

        # ── Side 4+: Hendelsestabell ─────────────────────────────────────────
        hend = df[df['roed']].copy()
        hend['Dato']            = hend.index.strftime('%d.%m.%Y')
        hend['Vannmetning']     = hend['sm_label']
        hend['Scenario']        = hend['sc_no'].apply(lambda n: f'Scenario {int(n)}' if pd.notna(n) else '–')
        hend['Terskel (mm/d)']  = hend['scenario'].apply(
            lambda s: str(s['threshD']) if s else '–')
        hend['Nedbør (mm/d)']   = hend['nedbor'].round(1)
        hend['Botnen (mm)']     = hend['mm_stasjon'].round(1)
        hend['seNorge (mm)']    = hend['mm_d'].round(1)

        cols = ['Dato', 'Vannmetning', 'Scenario', 'Terskel (mm/d)',
                'Nedbør (mm/d)', 'Botnen (mm)', 'seNorge (mm)']
        tabell = hend[cols]

        N = 25
        sider = [tabell.iloc[i:i+N] for i in range(0, max(len(tabell), 1), N)]
        for ci, chunk in enumerate(sider):
            fig = plt.figure(figsize=(11.69, 8.27))
            fig.patch.set_facecolor(BG)
            ax = fig.add_subplot(111); ax.axis('off'); ax.set_facecolor(BG)

            tittel = f'Røde varseldager – nedbør over scenarioterskelen ({roed_n} totalt)'
            if len(sider) > 1:
                tittel += f'  ({ci+1}/{len(sider)})'
            ax.set_title(tittel, color='white', fontsize=11, fontweight='bold', pad=12)

            if len(chunk) == 0:
                ax.text(0.5, 0.5, 'Ingen røde varseldager i perioden.',
                        transform=ax.transAxes, ha='center', color='#8b949e', fontsize=12)
            else:
                t = ax.table(cellText=chunk.values.tolist(), colLabels=cols,
                             loc='center', cellLoc='center')
                t.auto_set_font_size(False)
                t.set_fontsize(8.5)
                t.scale(1, 1.5)
                for (row, col), cell in t.get_celld().items():
                    cell.set_edgecolor('#30363d')
                    if row == 0:
                        cell.set_facecolor('#1c2128')
                        cell.set_text_props(color='#e6edf3', fontweight='bold')
                    else:
                        cell.set_facecolor('#161b22' if row % 2 == 0 else '#1c2128')
                        cell.set_text_props(color='#c9d1d9')

            fig.text(0.5, 0.03,
                     'Rød status = nedbør over aktiv scenarioterskel den dagen vannmetningsklassen ble bestemt',
                     ha='center', color='#484f58', fontsize=8)
            pdf.savefig(fig, facecolor=BG); plt.close()

        d = pdf.infodict()
        d['Title']  = 'Skredvarsel Fv609 – Scenarioanalyse (vannmetning × nedbør)'
        d['Author'] = 'Norconsult Norge AS v/Torgeir Fiskum Hansvik'

    print(f"  ✅  Rapport lagret: {filnavn}")


# ─── Kjør ─────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print("Skredvarsel Fv609 – Scenarioanalyse\n")

    try:
        # 1. Nedbørsdata
        print("Steg 1: Nedbørsdata")
        df_stasjon = hent_frost()
        df_gts     = hent_gts()

        # 2. Historisk vannmetning (én API-kall per dag)
        now = datetime.utcnow()
        datoer = [now - timedelta(days=i) for i in range(365, 0, -1)]
        datoer = [datetime(d.year, d.month, d.day) for d in datoer]

        print(f"\nSteg 2: Henter vannmetning for {len(datoer)} dager "
              f"(parallelt, 6 tråder) …")
        t0 = time.time()
        sm_serie = hent_sm_serie(datoer, max_workers=6)
        print(f"  → Ferdig på {time.time()-t0:.0f} sekunder")

        # 3. Analyser
        print("\nSteg 3: Analyserer …")
        df = analyser(df_stasjon, df_gts, sm_serie)
        roed = df['roed'].sum()
        print(f"  → {int(roed)} røde varseldager funnet")

        # 4. PDF
        fil = f"skredvarsel_fv609_scenarioanalyse_{datetime.now():%Y%m%d}.pdf"
        print(f"\nSteg 4: Genererer PDF …")
        generer_pdf(df, fil)

        if os.name == 'nt':
            os.startfile(fil)
        else:
            os.system(f'open "{fil}"')

    except Exception as e:
        print(f"\n❌ Feil: {e}")
        raise
