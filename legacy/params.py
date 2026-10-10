import streamlit as st
import pandas as pd
from dateutil.relativedelta import relativedelta
from datetime import datetime

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
/* 1. בסיס וטיפוגרפיה */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@400;700&family=Geist:wght@400;700&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

html, body, [data-testid="stAppViewContainer"] {
    font-family: "Inter", sans-serif;
    background-color: var(--background-color) !important;
    color: var(--text-color) !important;
}

/* 1. ביטול המרחק בין הטבלה למסגרת של ה-Form */
[data-testid="stForm"] {
    padding: 0px 5px !important; /* הוספת מרווח קטן של 5px מונעת את החיתוך והגלילה */
    overflow-x: hidden !important;
}

/* ביטול המסגרת (Border) שעוטפת את ה-DataFrame */
[data-testid="stDataFrame"] {
    margin: 0px !important;
    width: 100% !important; /* בדיוק 100%, בלי פלוס 4 פיקסלים */
    max-width: 100% !important;
}

/* 1. הקטנה משמעותית של הפונט והריווחים כדי שהכל ייכנס ברוחב אחד */
[data-testid="stDataFrame"] td, [data-testid="stDataFrame"] th {
    font-size: 10px !important; /* פונט קטן יותר חוסך המון רוחב */
    padding: 2px 4px !important; /* צמצום הריווח בין עמודות */
    white-space: nowrap !important;
}

/* 2. ביטול הגלילה הרוחבית בתוך המיכל של הטבלה */
[data-testid="stDataFrame"] > div {
    overflow-x: hidden !important; 
}

/* 3. מניעת "קפיצה" של הטבלה החוצה מה-Form */
[data-testid="stDataFrame"] canvas {
    max-width: 100% !important;
}

/* אם הטבלה בתוך אקספנדר או פורם, נשמור רק על המסגרת החיצונית שלהם */
.stDataFrame iframe {
    border: none !important;
}

/* מונע מהטבלה לחרוג מהגבולות של ה-Form או ה-Expander */
[data-testid="stDataFrame"] {
    margin: 0px !important;
    width: 100% !important;
    max-width: 100% !important;
    overflow-x: auto !important; /* מוסיף פס גלילה פנימי אם חסר מקום, במקום לחרוג */
}

/* עיצוב המדדים והטבלאות כך שישתלבו בשני המצבים */
[data-testid="stMetric"], [data-testid="stDataFrame"], [data-testid="stTable"] {
    background-color: var(--secondary-background-color) !important;
    border: 1px solid rgba(128, 128, 128, 0.1);
}

.block-container {
    max-width: 1200px;
    padding-top: 3rem !important;
}

/* החרגה למספרים בטבלאות ובמדדים - כדי שייראו מקצועיים יותר */
[data-testid="stMetricValue"], .stDataFrame, code {
    font-family: 'Inter', monospace !important;
}

/* 1. הגדרות בסיסיות לכל המכשירים */
h1 {
    margin-bottom: 0.5rem !important;
    padding-top: 0.5rem !important;
}

/* 1. החזרת המרווח האנכי הבריא בין שורות */
[data-testid="stVerticalBlock"] {
    gap: 1.5rem !important; /* מגדיל חזרה את המרווח בין האלמנטים */
}

[data-testid="stVerticalBlock"] > div { 
    gap: 1.6rem !important; 
}

/* ביטול חסימת הרוחב כדי שהכל ייכנס בשורה אחת */
[data-testid="column"] {
    flex: 1 1 auto !important;
    min-width: 0 !important;
    display: flex !important;
    flex-direction: column !important;
    justify-content: flex-end !important; /* מוודא שכל התיבות "יושבות" על הרצפה */
}

/* יישור גובה ה-Segmented Control לשדות המספר */
div[data-baseweb="segmented-control"] {
    margin-top: 0px !important;
    height: 42px !important; /* גובה זהה לשדות המספר */
    display: flex !important;
    align-items: center !important;
}

/* 4. צמצום הפדינג הפנימי של שדות המספר כדי לחסוך מקום */
[data-testid="stNumberInput"] div[data-baseweb="input"] {
    min-width: 60px !important;
}

/* מבטיח שכל הכותרות מעל השדות יתפסו גובה זהה ויצמדו לשדה למטה */
[data-testid="stWidgetLabel"] {
    min-height: unset !important; 
    height: auto !important;
    margin-bottom: 2px !important; /* צמצום מ-8px ל-2px */
    display: flex !important;
    align-items: flex-end !important;
}

/* 3. עיצוב מדדים (Metrics) עם Hover */
[data-testid="stMetric"] {
    padding: 0.6rem 0.8rem !important;
    border-radius: 12px;
    background: var(--secondary-background-color) !important;
    border: 1px solid rgba(128, 128, 128, 0.1);
    transition: all 0.3s ease;
}

/* Hover חכם שלא "בולע" את הטקסט */
[data-testid="stMetric"]:hover {
    transform: translateY(-4px);
    background: rgba(128, 128, 128, 0.05) !important;
    box-shadow: 0 10px 20px rgba(0,0,0,0.1);
}

/* מבטיח שהמספר תמיד יהיה בצבע הטקסט הראשי של המערכת */
[data-testid="stMetricValue"] {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.3rem !important;
    color: var(--text-color) !important;
}

/* 4. עיצוב כפתורים - שקופים עם Hover אפור (Ghost Design) */
.stButton>button, [data-testid="column"] button {
    background: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(0, 0, 0, 0.1) !important;
    color: #475569 !important;
    border-radius: 10px !important;
    transition: all 0.3s ease-in-out !important;
    display: inline-flex !important;
    justify-content: center !important;
    align-items: center !important;
    height: 42px !important;
}

/* כפתורי אייקונים (ריבוע) */
[data-testid="column"] button { min-width: 42px !important; max-width: 42px !important; }

/* אפקט Hover אפור יוקרתי */
.stButton>button:hover, [data-testid="column"] button:hover {
    background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%) !important;
    border: 1px solid #cbd5e1 !important;
    color: #1e293b !important;
    transform: translateY(-2px);
}

/* 5. מרכוז מושלם של האייקונים בתוך הכפתור */
[data-testid="column"] button div, 
[data-testid="column"] button p, 
[data-testid="column"] button span {
    display: flex !important;
    justify-content: center !important;
    align-items: center !important;
    margin: 0 !important;
    width: 100% !important;
}

/* 1. ביטול המרווח התחתון המובנה של כל הווידג'טים בשורה */
[data-testid="column"] [data-testid="stVerticalBlock"] > div {
    margin-bottom: 0px !important;
    padding-bottom: 0px !important;
}

/* מבטל את הרווח הנסתר שדוחף את שדה המספר למעלה */
[data-testid="column"] div[data-testid="stVerticalBlock"] > div {
    padding-bottom: 0px !important;
    margin-bottom: 0px !important;
}

/* 7. עיצוב טבלאות ו-Dataframes */
[data-testid="stDataFrame"], [data-testid="stTable"] {
    background-color: white;
    border-radius: 15px;
    padding: 10px;
}

/* 1. תיקון למחשב (מעל 768 פיקסלים) */
@media (min-width: 768px) {
    [data-testid="stHorizontalBlock"] {
        flex-wrap: nowrap !important;
        gap: 1.5rem !important; /* הגדלת הרווח בין השדות למראה נקי */
        align-items: flex-end !important;
        display: flex !important;
    }

    [data-testid="column"] {
        flex: 1 1 auto !important;
        min-width: 0 !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: flex-end !important;
    }

    /* איפוס המרווח הפנימי ש-Streamlit דוחף מתחת לכל שדה קלט */
    [data-testid="column"] div[data-testid="stVerticalBlock"] > div {
        padding-bottom: 0px !important;
        margin-bottom: 0px !important;
    }
    [data-testid="stSliderTickBarMin"], [data-testid="stSliderTickBarMax"] {
        display: none;
    }
    [data-testid="stNumberInputStepDown"], [data-testid="stNumberInputStepUp"] {
        display: none;
    }
    
}

/* 2. תיקון למובייל (מתחת ל-768 פיקסלים) - צמצום הרווחים שסימנת באדום */
@media (max-width: 767px) {
    [data-testid="column"] {
        margin-bottom: -15px !important; /* מושך את השדה הבא למעלה ומבטל את ה"בור" */
        padding-bottom: 0px !important;
    }

    /* צמצום הרווח בתוך המיכל הכללי במובייל */
    [data-testid="stVerticalBlock"] {
        gap: 0.5rem !important;
    }

    /* הצמדת הכותרת (Label) לשדה מתחתיה */
    [data-testid="stWidgetLabel"] {
        margin-bottom: 2px !important;
        height: auto !important;
        min-height: unset !important;
    }
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
    "תאריך התחלה": st.column_config.DateColumn("תאריך התחלה", format="DD/MM/YYYY"),
    "תאריך סיום": st.column_config.DateColumn("תאריך סיום", format="DD/MM/YYYY"),
    "יתרה התחלתית": st.column_config.NumberColumn("יתרה התחלתית", format="₪ %.2f"),
    "סך משיכות": st.column_config.NumberColumn("סך משיכות", format="₪ %.2f"),
    "יתרה סופית": st.column_config.NumberColumn("יתרה סופית", format="₪ %.2f"),
}


DF_HISTORY_2_CFG = {
    "תאריך התחלה": st.column_config.DateColumn("תאריך התחלה", format="DD/MM/YYYY", width="small"),
    "תאריך סיום": st.column_config.DateColumn("תאריך סיום", format="DD/MM/YYYY", width="small"),
    "יתרה התחלתית": st.column_config.NumberColumn("יתרה התחלתית", format="₪ %.2f", width=None),
    "סך הפקדות": st.column_config.NumberColumn("סך הפקדות", format="₪ %.2f", width=None),
    "יתרה סופית": st.column_config.NumberColumn("יתרה סופית", format="₪ %.2f", width=None),
    "תשואה שנתית שקולה": st.column_config.NumberColumn("תשואה שנתית שקולה", format="%.2f %%", width=None)
}

DEF_PORTFOLIO = [{COL_STOCK: "S&P 500 (^GSPC)", COL_WEIGHT: 100.0, COL_LEVERAGE: 1.0}]
DEF_PORTFOLIO_2 = pd.DataFrame(columns=[COL_STOCK, COL_WEIGHT, COL_LEVERAGE])

BACKWARD_DAYS = 7
LAST_DAY_DATA = (datetime.now() - relativedelta(days=BACKWARD_DAYS)).date()
