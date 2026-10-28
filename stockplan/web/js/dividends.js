// Default dividend yields (percent a year, roughly the recent yield) for the built-in symbols.
// They only matter in a regular account, where every dividend pays capital-gains tax. The
// price series are total-return (dividends reinvested), except the indexes that start with
// "^" (^GSPC, ^NDX...), which are price-only, so their dividends were never in the price.
const YIELDS = {
  "^SP500TR": 1.3, SPY: 1.3, VOO: 1.3, IVV: 1.3, VTI: 1.3, QQQ: 0.6, VT: 2.0, VXUS: 3.0, VEA: 3.2,
  VWO: 3.0, EEM: 2.5, EFA: 3.0, ACWI: 1.8, URTH: 1.6, IWM: 1.2, DIA: 1.6, SCHD: 3.6, VIG: 1.7,
  VNQ: 3.9, XLK: 0.7, XLF: 1.5, XLE: 3.2, XLV: 1.6, SMH: 0.4, SOXX: 0.6, TQQQ: 0.2, QLD: 0.2,
  UPRO: 0.5, SSO: 0.5, BND: 3.6, AGG: 3.6, TLT: 4.0, IEF: 3.5, SHY: 3.8, BIL: 4.5, EIS: 2.0,
  AAPL: 0.5, MSFT: 0.8, GOOGL: 0.4, GOOG: 0.4, META: 0.4, AVGO: 1.3, TSM: 1.4, ASML: 0.9,
  QCOM: 2.0, AMAT: 0.9, MU: 0.5, ORCL: 1.0, CRM: 0.6, ESLT: 0.5, ICL: 3.0,
};

export function defaultDividend(ticker) {
  const t = (ticker || "").trim().toUpperCase();
  return YIELDS[t] ?? 0;
}

// Plans saved before the dividend field existed get the default yields.
export const withDividends = (holdings) =>
  holdings.map((h) => (h.dividend === undefined ? { ...h, dividend: defaultDividend(h.ticker) } : h));
