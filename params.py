import streamlit as st
import pandas as pd

STOCK_OPTIONS = {
    # --- Indices & ETFs ---
    "S&P 500 (^GSPC)": "^GSPC",
    "Nasdaq 100 (^NDX)": "^NDX",
    "Nasdaq Comp (^IXIC)": "^IXIC",
    "Dow Jones (^DJI)": "^DJI",
    "Russell 2000 (^RUT)": "^RUT",
    "Nasdaq Tech ETF (QQQ)": "QQQ",
    "S&P 500 ETF (SPY)": "SPY",
    "US Market (VTI)": "VTI",
    "Nasdaq 3x Leveraged (TQQQ)": "TQQQ",
    "World Index (ACWI)": "ACWI",
    "Emerging Markets (VWO)": "VWO",
    "Fear Index (^VIX)": "^VIX",

    # --- Tech & AI ---
    "Apple (AAPL)": "AAPL",
    "Microsoft (MSFT)": "MSFT",
    "Google (GOOGL)": "GOOGL",
    "Amazon (AMZN)": "AMZN",
    "Meta (META)": "META",
    "Nvidia (NVDA)": "NVDA",
    "Tesla (TSLA)": "TSLA",
    "Netflix (NFLX)": "NFLX",
    "Palantir (PLTR)": "PLTR",
    "Salesforce (CRM)": "CRM",
    "Adobe (ADBE)": "ADBE",
    "Oracle (ORCL)": "ORCL",
    "Snowflake (SNOW)": "SNOW",

    # --- Semiconductors ---
    "AMD (AMD)": "AMD",
    "Intel (INTC)": "INTC",
    "TSMC (TSM)": "TSM",
    "Broadcom (AVGO)": "AVGO",
    "ASML (ASML)": "ASML",
    "Applied Materials (AMAT)": "AMAT",
    "Super Micro (SMCI)": "SMCI",
    "ARM (ARM)": "ARM",
    "Micron (MU)": "MU",
    "Qualcomm (QCOM)": "QCOM",

    # --- Israel ---
    "TA-35 (^TA35.TA)": "^TA35.TA",
    "TA-125 (^TA125.TA)": "^TA125.TA",
    "Leumi (LUMI.TA)": "LUMI.TA",
    "Hapoalim (POLI.TA)": "POLI.TA",
    "Discount (DSCT.TA)": "DSCT.TA",
    "Mizrahi (MZTF.TA)": "MZTF.TA",
    "Elbit (ESLT)": "ESLT",
    "Teva (TEVA)": "TEVA",
    "Nice (NICE)": "NICE",
    "Check Point (CHKP)": "CHKP",
    "Nova (NVMI)": "NVMI",
    "Camtek (CAMT)": "CAMT",
    "Tower (TSEM)": "TSEM",
    "Wix (WIX)": "WIX",
    "Monday (MNDY)": "MNDY",
    "SolarEdge (SEDG)": "SEDG",
    "CyberArk (CYBR)": "CYBR",
    "ICL (ICL)": "ICL",
    "Bezeq (BEZQ.TA)": "BEZQ.TA",

    # --- Finance ---
    "Visa (V)": "V",
    "Mastercard (MA)": "MA",
    "JPMorgan (JPM)": "JPM",
    "Goldman Sachs (GS)": "GS",
    "Berkshire (BRK-B)": "BRK-B",
    "PayPal (PYPL)": "PYPL",
    "Amex (AXP)": "AXP",
    "BlackRock (BLK)": "BLK",

    # --- Healthcare ---
    "Eli Lilly (LLY)": "LLY",
    "Novo Nordisk (NVO)": "NVO",
    "J&J (JNJ)": "JNJ",
    "Pfizer (PFE)": "PFE",
    "Moderna (MRNA)": "MRNA",
    "UnitedHealth (UNH)": "UNH",

    # --- Consumer ---
    "Walmart (WMT)": "WMT",
    "Costco (COST)": "COST",
    "Coca-Cola (KO)": "KO",
    "Pepsi (PEP)": "PEP",
    "McDonald's (MCD)": "MCD",
    "Starbucks (SBUX)": "SBUX",
    "Disney (DIS)": "DIS",
    "Nike (NKE)": "NKE",
    "Uber (UBER)": "UBER",
    "Airbnb (ABNB)": "ABNB",

    # --- Energy & Industrials ---
    "Exxon (XOM)": "XOM",
    "Chevron (CVX)": "CVX",
    "Boeing (BA)": "BA",
    "Lockheed (LMT)": "LMT",
    "Caterpillar (CAT)": "CAT",
    "GE Aerospace (GE)": "GE",

    # --- Real Estate ---
    "American Tower (AMT)": "AMT",
    "Prologis (PLD)": "PLD",
    "Realty Income (O)": "O",

    # --- Commodities ---
    "Gold (GLD)": "GLD",
    "Silver (SLV)": "SLV",
    "Oil (USO)": "USO",
    "Uranium (URA)": "URA",

    # --- Crypto ---
    "Bitcoin (BTC-USD)": "BTC-USD",
    "Ethereum (ETH-USD)": "ETH-USD",
    "Solana (SOL-USD)": "SOL-USD",
    "Coinbase (COIN)": "COIN",
    "MicroStrategy (MSTR)": "MSTR",

    # --- Bonds ---
    "Treasury 20Y+ (TLT)": "TLT",
    "Total Bond (BND)": "BND",
    "Treasury 7-10Y (IEF)": "IEF"
}

STOCK_OPTIONS = dict(sorted(STOCK_OPTIONS.items()))
STOCK_OPTIONS_KEYS = list(sorted(STOCK_OPTIONS.keys()))
DEFAULT_IDX = list(STOCK_OPTIONS.keys()).index("S&P 500 (^GSPC)")
DEFAULT_IDX_KEY = STOCK_OPTIONS_KEYS.index("S&P 500 (^GSPC)")

PAGE_CONFIG_LAYOUT = "wide"
HTML_STYLE = """<style>
            .block-container {
            padding-top: 2rem;
            padding-bottom: 0rem;
        }
        ::-webkit-scrollbar {
            width: 10px;
        }
        ::-webkit-scrollbar-thumb {
            background: #4A90E2;
            border-radius: 10px;
        }
        /* הקטנת מספרים במטריקות (כמו ה-5,000₪ ששלחת) */
        [data-testid="stMetricValue"] {
            font-size: 1.8rem !important;
        }
        </style>"""

SIDE_BAR = "תמיר המלך"

TABS_1 = "סטטיקה של השקעות"
TABS_2 = "מחקר טריניטי"

COL_STOCK = "מניה"
COL_WEIGHT = "(%) אחוז מהתיק"
COL_LEVERAGE = "מינוף (A)"

PRTFOLIO_COFIG = {
    COL_STOCK: st.column_config.SelectboxColumn(
        COL_STOCK,
        help="בחר מניה מהרשימה",
        options=STOCK_OPTIONS_KEYS,
        required=True,
    ),
    COL_WEIGHT: st.column_config.NumberColumn(
        COL_WEIGHT,
        help="הזן את משקל המניה בתיק (0-100)",
        min_value=0.0,
        max_value=100.0,
        step=0.1,
        format="%.2f%%",
        required=True,
    ),
    COL_LEVERAGE: st.column_config.NumberColumn(
        COL_LEVERAGE,
        help="מכפיל התשואה (למשל: 3 עבור מינוף פי 3)",
        min_value=0.0,
        max_value=10.0,
        step=0.1,
        format="%.1f",
        required=True,
    ),
}

DF_HISTORY_CFG = {
    "תאריך התחלה": st.column_config.DateColumn(
        "תאריך התחלה",
        format="DD/MM/YYYY"  # פורמט ישראלי ומיון תקין
    ),
    "תאריך סיום": st.column_config.DateColumn(
        "תאריך סיום",
        format="DD/MM/YYYY"
    ),
    "יתרה סופית": st.column_config.NumberColumn(
        "יתרה סופית",
        format="%,.2f ₪"
    ),
    "סך משיכות נומינלי": st.column_config.NumberColumn(
        "סך משיכות נומינלי",
        format="%,.2f ₪"
    )
}

DF_HISTORY_2_CFG = {
    "תאריך התחלה": st.column_config.DateColumn(
        "תאריך התחלה",
        format="DD/MM/YYYY"
    ),
    "תאריך סיום": st.column_config.DateColumn(
        "תאריך סיום",
        format="DD/MM/YYYY"
    ),
    "יתרה סופית": st.column_config.NumberColumn(
        "יתרה סופית",
        format="₪ %.2f"
    ),
    "סך הפקדות נומינלי": st.column_config.NumberColumn(
        "סך משיכות נומינלי",
        format="₪ %.2f"
    )
}

DEF_PORTFOLIO = [{COL_STOCK: "S&P 500 (^GSPC)", COL_WEIGHT: 100.0, COL_LEVERAGE: 1.0}]
DEF_PORTFOLIO_2 = pd.DataFrame(columns=[COL_STOCK, COL_WEIGHT, COL_LEVERAGE])
