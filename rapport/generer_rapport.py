#!/usr/bin/env python3
"""
Skredvarsel Fv 609 Heilevang – Historisk terskelrapport
========================================================
Henter daglige nedbørsverdier fra Frost API (Botnen i Førde, SN57480)
og døgnnedbør fra seNorge/gts.nve.no for siste 365 dager + 5-årshistorikk.
Genererer en PDF-rapport med terskloverskridelser for jordskredvarsling.

NB: SN57480 har kun daglige observasjoner (P1D). Timesterskel (10/15 mm/t)
kan ikke kontrolleres fra denne stasjonen og vises som N/A.

Kjør:  python generer_rapport.py
Krav:  pip install requests pandas matplotlib
"""

import requests
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
from matplotlib.backends.backend_pdf import PdfPages
from datetime import datetime, timedelta
import os, math

# ─── Konfigurasjon ────────────────────────────────────────────────────────────
CLIENT_ID    = 'ff18c1d5-0abc-4af7-bccb-e4e3fe8ff3ad'
STATION_ID   = 'SN57480'
STATION_NAME = 'Botnen i Førde (SN57480)'

# Representativt punkt innenfor Fv609-korridoren (for seNorge-rutenett)
LAT, LON = 61.4387, 5.5463

# Terskelverdier (fra beredskapsplan)
SCENARIO1 = {'no': 1, 'threshH': 10, 'threshD': 40,
             'desc': 'Fuktig jord (≥70 % vannmetning)'}
SCENARIO2 = {'no': 2, 'threshH': 15, 'threshD': 60,
             'desc': 'Tørr jord (<70 % vannmetning)'}


# ─── Hjelpefunksjoner ─────────────────────────────────────────────────────────
def latlon_to_utm33(lat, lon):
    try:
        from pyproj import Proj
        p = Proj(proj='utm', zone=33, datum='WGS84')
        x, y = p(lon, lat)
        return int(round(x)), int(round(y))
    except ImportError:
        REF_LAT, REF_LON, REF_X, REF_Y = 61.46, 5.85, 326000, 6820000
        dx = (lon - REF_LON) * math.cos(math.radians(lat)) * 111320
        dy = (lat - REF_LAT) * 111320
        return int(REF_X + dx), int(REF_Y + dy)


def stil_akse(ax):
    ax.set_facecolor('#161b22')
    ax.tick_params(colors='#8b949e')
    ax.xaxis.label.set_color('#8b949e')
    ax.yaxis.label.set_color('#8b949e')
    for spine in ['top', 'right']:
        ax.spines[spine].set_visible(False)
    for spine in ['bottom', 'left']:
        ax.spines[spine].set_color('#30363d')
    ax.grid(axis='y', color='#21262d', linewidth=0.5)


# ─── Datahenting ──────────────────────────────────────────────────────────────
def hent_frost(dager=365):
    """Henter daglige nedbørsverdier fra Frost API (P1D)."""
    print(f"  Henter daglige verdier fra Frost API ({STATION_NAME}) …")
    now = datetime.utcnow()
    fra = now - timedelta(days=dager)
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

    recs = []
    for d in j.get('data', []):
        dato = datetime.strptime(d['referenceTime'][:10], '%Y-%m-%d')
        recs.append({'dato': dato, 'mm_stasjon': d['observations'][0]['value'] or 0})

    df = pd.DataFrame(recs).sort_values('dato').set_index('dato')
    print(f"    → {len(df)} dagsverdier")
    return df


def hent_gts(dager=365):
    """Henter daglig nedbør fra seNorge rutenett via gts.nve.no."""
    print("  Henter døgnnedbør fra seNorge/gts.nve.no …")
    x, y = latlon_to_utm33(LAT, LON)
    now = datetime.utcnow()
    fra = now - timedelta(days=dager)
    url = (f"https://gts.nve.no/api/GridTimeSeries/{x}/{y}"
           f"/{fra:%Y-%m-%d}/{now:%Y-%m-%d}/rr.csv")
    r = requests.get(url, timeout=30)
    lines = [l for l in r.text.strip().split('\n')
             if not l.startswith('#') and ';' in l]
    lines.pop(0)  # fjern header

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
    print(f"    → {len(df)} dagsverdier (seNorge)")
    return df


# ─── Analyse ──────────────────────────────────────────────────────────────────
def analyser(df_stasjon, df_gts):
    df = df_gts.join(df_stasjon, how='outer').fillna(0)
    for sc in [SCENARIO1, SCENARIO2]:
        n = sc['no']
        # Kun døgnterskler (ingen timesdata fra SN57480)
        df[f'sc{n}_d']   = (df['mm_d'] >= sc['threshD']) | (df['mm_stasjon'] >= sc['threshD'])
        df[f'sc{n}_any'] = df[f'sc{n}_d']
    return df


# ─── Rapport-generering ───────────────────────────────────────────────────────
def generer_pdf(df, df_5ar, filnavn):
    plt.rcParams.update({'font.family': 'sans-serif', 'font.size': 9})
    BG, PANEL = '#0d1117', '#161b22'

    sc1_n     = int(df['sc1_any'].sum())
    sc2_n     = int(df['sc2_any'].sum())
    max_dogn  = float(df[['mm_d', 'mm_stasjon']].max().max())
    periode_f = df.index.min().strftime('%d.%m.%Y')
    periode_t = df.index.max().strftime('%d.%m.%Y')

    with PdfPages(filnavn) as pdf:

        # ── Side 1: Forside ──────────────────────────────────────────────────
        fig = plt.figure(figsize=(11.69, 8.27))
        fig.patch.set_facecolor(BG)
        ax = fig.add_subplot(111); ax.axis('off'); ax.set_facecolor(BG)

        ax.text(0.5, 0.88, 'Skredvarsel Fv 609 Heilevang',
                transform=ax.transAxes, ha='center', fontsize=26,
                fontweight='bold', color='white')
        ax.text(0.5, 0.80, 'Historisk analyse av terskloverskridelser for jordskred',
                transform=ax.transAxes, ha='center', fontsize=13, color='#8b949e')
        ax.text(0.5, 0.73, f'Periode: {periode_f} – {periode_t}',
                transform=ax.transAxes, ha='center', fontsize=11, color='#c9d1d9')

        sammendrag = (
            f"SAMMENDRAG\n\n"
            f"Scenario 1  (fuktig jord ≥70 %, terskel {SCENARIO1['threshD']} mm/d)\n"
            f"   → {sc1_n} dag{'er' if sc1_n != 1 else ''} med overskridelse\n\n"
            f"Scenario 2  (tørr jord <70 %, terskel {SCENARIO2['threshD']} mm/d)\n"
            f"   → {sc2_n} dag{'er' if sc2_n != 1 else ''} med overskridelse\n\n"
            f"Høyeste døgnnedbør: {max_dogn:.1f} mm\n\n"
            f"⚠  Timesterskel ({SCENARIO1['threshH']}/{SCENARIO2['threshH']} mm/t) kontrolleres ikke –\n"
            f"   {STATION_NAME} har kun daglige observasjoner (P1D).\n\n"
            f"Datakilder:\n"
            f"   • Daglige observasjoner: MET Frost API – {STATION_NAME}\n"
            f"   • Rutenett-nedbør: seNorge GridTimeSeries (gts.nve.no)\n\n"
            f"Generert: {datetime.now():%d.%m.%Y kl. %H:%M}"
        )
        ax.text(0.5, 0.38, sammendrag, transform=ax.transAxes,
                ha='center', va='center', fontsize=10, color='#c9d1d9', linespacing=1.6,
                bbox=dict(boxstyle='round,pad=1', facecolor=PANEL, edgecolor='#30363d'))

        ax.text(0.5, 0.04, 'Utviklet av Norconsult Norge AS v/Torgeir Fiskum Hansvik',
                transform=ax.transAxes, ha='center', fontsize=8, color='#484f58')
        pdf.savefig(fig, facecolor=BG); plt.close()

        # ── Side 2: Tidsserie – to grafer ───────────────────────────────────
        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11.69, 8.27),
                                        sharex=True, gridspec_kw={'hspace': 0.35})
        fig.patch.set_facecolor(BG)
        fig.suptitle('Døgnnedbør siste 365 dager – med tersklinjer',
                     color='white', fontsize=12, fontweight='bold')

        def fargekod(series, sc1, sc2):
            return ['#e94560' if v >= sc2 else '#f5c000' if v >= sc1 else '#2171b5'
                    for v in series]

        # seNorge rutenett
        stil_akse(ax1)
        ax1.bar(df.index, df['mm_d'], color=fargekod(df['mm_d'], SCENARIO1['threshD'], SCENARIO2['threshD']), width=0.9)
        ax1.axhline(SCENARIO1['threshD'], color='#f5c000', lw=1.2, ls='--',
                    label=f"Sc.1 {SCENARIO1['threshD']} mm/d")
        ax1.axhline(SCENARIO2['threshD'], color='#e94560', lw=1.2, ls='--',
                    label=f"Sc.2 {SCENARIO2['threshD']} mm/d")
        ax1.set_ylabel('mm/døgn')
        ax1.set_title('Døgnnedbør – seNorge rutenett (Fv609)', color='#c9d1d9', fontsize=10)
        ax1.legend(facecolor=PANEL, edgecolor='#30363d', labelcolor='#c9d1d9', fontsize=8)

        # Botnen stasjon
        stil_akse(ax2)
        ax2.bar(df.index, df['mm_stasjon'],
                color=fargekod(df['mm_stasjon'], SCENARIO1['threshD'], SCENARIO2['threshD']), width=0.9)
        ax2.axhline(SCENARIO1['threshD'], color='#f5c000', lw=1.2, ls='--',
                    label=f"Sc.1 {SCENARIO1['threshD']} mm/d")
        ax2.axhline(SCENARIO2['threshD'], color='#e94560', lw=1.2, ls='--',
                    label=f"Sc.2 {SCENARIO2['threshD']} mm/d")
        ax2.set_ylabel('mm/døgn')
        ax2.set_title(f'Døgnnedbør – {STATION_NAME}', color='#c9d1d9', fontsize=10)
        ax2.legend(facecolor=PANEL, edgecolor='#30363d', labelcolor='#c9d1d9', fontsize=8)
        ax2.xaxis.set_major_formatter(mdates.DateFormatter('%b %Y'))
        ax2.xaxis.set_major_locator(mdates.MonthLocator())
        plt.setp(ax2.xaxis.get_majorticklabels(), rotation=30, ha='right')

        from matplotlib.patches import Patch
        fig.legend(handles=[
            Patch(facecolor='#2171b5', label='Under Sc.1'),
            Patch(facecolor='#f5c000', label='Over Sc.1-terskel'),
            Patch(facecolor='#e94560', label='Over Sc.2-terskel'),
        ], loc='lower center', ncol=3,
            facecolor=PANEL, edgecolor='#30363d', labelcolor='#c9d1d9',
            fontsize=8, bbox_to_anchor=(0.5, 0.0))
        fig.subplots_adjust(bottom=0.12)
        pdf.savefig(fig, facecolor=BG); plt.close()

        # ── Side 3: Månedlig ────────────────────────────────────────────────
        mn = df.groupby(df.index.to_period('M')).agg(
            sc1=('sc1_any', 'sum'), sc2=('sc2_any', 'sum'),
            sum_gts=('mm_d', 'sum'), sum_stasjon=('mm_stasjon', 'sum'))
        mn.index = mn.index.to_timestamp()

        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11.69, 8.27),
                                        gridspec_kw={'hspace': 0.4})
        fig.patch.set_facecolor(BG)
        fig.suptitle('Månedlig sammendrag', color='white', fontsize=12, fontweight='bold')

        x = np.arange(len(mn)); w = 0.35
        stil_akse(ax1)
        ax1.bar(x - w/2, mn['sc1'], w, color='#f5c000cc', label='Sc.1 overskridelser')
        ax1.bar(x + w/2, mn['sc2'], w, color='#e9456099', label='Sc.2 overskridelser')
        ax1.set_xticks(x)
        ax1.set_xticklabels([d.strftime('%b\n%Y') for d in mn.index], fontsize=8)
        ax1.set_ylabel('Antall dager')
        ax1.set_title('Dager med terskloverskridelse per måned', color='#c9d1d9', fontsize=10)
        ax1.legend(facecolor=PANEL, edgecolor='#30363d', labelcolor='#c9d1d9', fontsize=8)
        for i, (s1, s2) in enumerate(zip(mn['sc1'], mn['sc2'])):
            if s1: ax1.text(i-w/2, s1+.05, str(int(s1)), ha='center', va='bottom', fontsize=7, color='#f5c000')
            if s2: ax1.text(i+w/2, s2+.05, str(int(s2)), ha='center', va='bottom', fontsize=7, color='#e94560')

        stil_akse(ax2)
        ax2.bar(x - w/2, mn['sum_gts'],     w, color='#2171b5aa', label='seNorge rutenett (mm)')
        ax2.bar(x + w/2, mn['sum_stasjon'], w, color='#1d6fa4cc', label=f'Botnen stasjon (mm)')
        ax2.set_xticks(x)
        ax2.set_xticklabels([d.strftime('%b\n%Y') for d in mn.index], fontsize=8)
        ax2.set_ylabel('mm/måned')
        ax2.set_title('Månedlig totalnedbør – begge datakilder', color='#c9d1d9', fontsize=10)
        ax2.legend(facecolor=PANEL, edgecolor='#30363d', labelcolor='#c9d1d9', fontsize=8)
        pdf.savefig(fig, facecolor=BG); plt.close()

        # ── Side 4: 5-årshistorikk ──────────────────────────────────────────
        if df_5ar is not None and not df_5ar.empty:
            mn5 = df_5ar.groupby(df_5ar.index.to_period('M'))['mm_stasjon'].sum()
            mn5.index = mn5.index.to_timestamp()
            ar5 = df_5ar.groupby(df_5ar.index.year)['mm_stasjon'].sum()

            farger5 = ['#1d6fa4','#2ecc71','#e67e22','#9b59b6','#e94560']
            ar5_liste = list(ar5.index)
            mn_farger = [farger5[ar5_liste.index(d.year) % len(farger5)] + 'cc'
                         if d.year in ar5_liste else '#888888cc'
                         for d in mn5.index]

            fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11.69, 8.27),
                                            gridspec_kw={'hspace': 0.45})
            fig.patch.set_facecolor(BG)
            fig.suptitle(f'Nedbørshistorikk – {STATION_NAME} (siste 5 år)',
                         color='white', fontsize=12, fontweight='bold')

            # Månedsgraf
            stil_akse(ax1)
            mn_labels = [d.strftime('%b\'%y') for d in mn5.index]
            ax1.bar(range(len(mn5)), mn5.values, color=mn_farger, width=0.8)
            ax1.set_xticks(range(len(mn5)))
            ax1.set_xticklabels(mn_labels, fontsize=7, rotation=45, ha='right')
            ax1.set_ylabel('mm/måned')
            ax1.set_title('Månedlig nedbør – fargekodet per år', color='#c9d1d9', fontsize=10)

            # Fargeforklaring for år
            from matplotlib.patches import Patch
            legend_el = [Patch(facecolor=farger5[i % len(farger5)], label=str(yr))
                         for i, yr in enumerate(ar5.index)]
            ax1.legend(handles=legend_el, facecolor=PANEL, edgecolor='#30363d',
                       labelcolor='#c9d1d9', fontsize=8, ncol=len(ar5))

            # Årstotal
            stil_akse(ax2)
            bar_farger = [farger5[i % len(farger5)] + 'cc' for i in range(len(ar5))]
            bars = ax2.bar(range(len(ar5)), ar5.values, color=bar_farger,
                           width=0.5, edgecolor='#30363d')
            ax2.set_xticks(range(len(ar5)))
            ax2.set_xticklabels([str(yr) for yr in ar5.index], fontsize=11)
            ax2.set_ylabel('mm/år')
            ax2.set_title('Årstotal nedbør', color='#c9d1d9', fontsize=10)
            for bar, val in zip(bars, ar5.values):
                ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 5,
                         f'{val:.0f} mm', ha='center', va='bottom',
                         fontsize=10, color='#c9d1d9', fontweight='bold')

            pdf.savefig(fig, facecolor=BG); plt.close()

        # ── Side 5: Hendelsestabell ──────────────────────────────────────────
        hend = df[df['sc1_any']].copy()
        hend['Dato']                = hend.index.strftime('%d.%m.%Y')
        hend['seNorge (mm/d)']      = hend['mm_d'].round(1)
        hend['Botnen (mm/d)']       = hend['mm_stasjon'].round(1)
        hend['Sc.1 (≥40 mm/d)']    = hend['sc1_d'].map({True: '✓', False: ''})
        hend['Sc.2 (≥60 mm/d)']    = hend['sc2_d'].map({True: '✓', False: ''})
        cols = ['Dato', 'seNorge (mm/d)', 'Botnen (mm/d)', 'Sc.1 (≥40 mm/d)', 'Sc.2 (≥60 mm/d)']
        tabell = hend[cols]

        N = 30
        for ci, chunk in enumerate([tabell.iloc[i:i+N] for i in range(0, max(len(tabell), 1), N)]):
            fig = plt.figure(figsize=(11.69, 8.27))
            fig.patch.set_facecolor(BG)
            ax = fig.add_subplot(111); ax.axis('off'); ax.set_facecolor(BG)

            tittel = 'Hendelser – overskridelse av Scenario 1 (≥40 mm/døgn)'
            if len(tabell) > N:
                tittel += f'  ({ci+1}/{math.ceil(len(tabell)/N)})'
            ax.set_title(tittel, color='white', fontsize=11, fontweight='bold', pad=12)

            if len(chunk) == 0:
                ax.text(0.5, 0.5, 'Ingen overskridelser i perioden.',
                        transform=ax.transAxes, ha='center', color='#8b949e', fontsize=12)
            else:
                t = ax.table(cellText=chunk.values.tolist(), colLabels=cols,
                             loc='center', cellLoc='center')
                t.auto_set_font_size(False)
                t.set_fontsize(9)
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
                     f'⚠ Timesterskel ({SCENARIO1["threshH"]}/{SCENARIO2["threshH"]} mm/t) '
                     f'ikke tilgjengelig fra {STATION_NAME} (kun P1D)',
                     ha='center', color='#e67e22', fontsize=8)
            pdf.savefig(fig, facecolor=BG); plt.close()

        d = pdf.infodict()
        d['Title']  = 'Skredvarsel Fv609 Heilevang – Historisk terskelrapport'
        d['Author'] = 'Norconsult Norge AS v/Torgeir Fiskum Hansvik'

    print(f"  ✅  Rapport lagret: {filnavn}")


# ─── Kjør ─────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print("Skredvarsel Fv609 – genererer historisk rapport\n")
    try:
        print("Henter 365-dagers data:")
        df_stasjon = hent_frost(dager=365)
        df_gts     = hent_gts(dager=365)
        df         = analyser(df_stasjon, df_gts)

        print("\nHenter 5-årsdata:")
        df_5ar = hent_frost(dager=int(5 * 365.25))

        fil = f"skredvarsel_fv609_rapport_{datetime.now():%Y%m%d}.pdf"
        print(f"\nGenererer PDF …")
        generer_pdf(df, df_5ar, fil)

        if os.name == 'nt':
            os.startfile(fil)
        else:
            os.system(f'open "{fil}"')

    except Exception as e:
        print(f"\n❌ Feil: {e}")
        raise
