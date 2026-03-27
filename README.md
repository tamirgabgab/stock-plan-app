# 📈 Stock Plan App

**An interactive tool for planning and simulating investment portfolios**

[![Python](https://img.shields.io/badge/Python-3.9+-blue?logo=python&logoColor=white)](https://www.python.org/)
[![Streamlit](https://img.shields.io/badge/Streamlit-App-FF4B4B?logo=streamlit&logoColor=white)](https://streamlit.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 🧠 What is this?

**Stock Plan App** is an interactive web application built with Streamlit that allows users to plan investment portfolios, run historical simulations, and analyze retirement strategies — all through a clean and intuitive interface.

The app fetches real-time stock data via `yfinance` and computes complex financial scenarios including leverage, taxation, and monthly withdrawals.

---

## ✨ Key Features

### 📊 Tab 1 — Investment Statistics
- Build a custom portfolio with stocks, weights, and leverage factors
- Run historical simulations across different time periods
- Calculate equivalent annual return, total deposits, and final balance
- Support for capital gains tax and tax-shield carry-over between portfolio stages

### 🏖️ Tab 2 — Trinity Study Research
- Retirement simulation inspired by the **4% Rule** (Trinity Study)
- Simulate monthly/annual withdrawal rates over real historical data
- Automatically solve for initial amount / withdrawal rate / final balance
- Support for multi-stage portfolios and flexible withdrawal strategies

---

## 📦 Supported Assets

Over **80 assets** organized by category:

| Category | Examples |
|---|---|
| 🇺🇸 Indices & ETFs | S&P 500, Nasdaq 100, Russell 2000 |
| 💻 Tech & AI | Apple, Nvidia, Microsoft, Meta |
| 🇮🇱 Israel | TA-35, Leumi, Hapoalim, Check Point |
| 🏦 Finance | Visa, JPMorgan, Goldman Sachs |
| 💊 Healthcare | Eli Lilly, Pfizer, Moderna |
| ₿ Crypto | Bitcoin, Ethereum, Solana |
| 🏗️ Bonds | TLT, BND, IEF |
| 🛢️ Commodities | Gold, Silver, Oil, Uranium |

---

## 🚀 Installation & Usage

```bash
# 1. Clone the repository
git clone https://github.com/tamirgabgab/stock-plan-app.git
cd stock-plan-app

# 2. Install dependencies
pip install -r requirements.txt

# 3. Run the app
python main.py
```

The app will open automatically in your browser at `http://localhost:8501`

---

## 🛠️ Tech Stack

| Library | Purpose |
|---|---|
| `streamlit` | Web UI framework |
| `yfinance` | Real-time market data |
| `pandas` / `numpy` | Data processing & calculations |
| `plotly` | Interactive charts |
| `scipy` | Mathematical optimization |
| `python-dateutil` | Date range management |

---

## 📁 Project Structure

```
stock-plan-app/
├── main.py              # App entry point
├── params.py            # Configuration, assets & styling
├── stock_statistics.py  # Investment statistics tab
├── stock_trinity.py     # Trinity study tab
├── utils.py             # Simulation & calculation logic
└── requirements.txt     # Project dependencies
```

---

## 👤 Author

**Tamir Gabgab** — [GitHub](https://github.com/tamirgabgab)

---

> ⚠️ **Disclaimer:** This app is intended for research and educational purposes only. It does not constitute financial advice or investment recommendations.
