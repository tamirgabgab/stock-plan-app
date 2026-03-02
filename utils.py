import streamlit as st
import yfinance as yf
import pandas as pd
import numpy as np
import time

from scipy.optimize import fsolve
from dateutil.relativedelta import relativedelta
from datetime import datetime
from params import *


def apply_leverage(df_data: pd.DataFrame, leverage_factor: float, base_value: float = None) -> pd.DataFrame:
    if base_value is None:
        base_value = df_data.iloc[0, 0]
    returns = df_data.pct_change().dropna()
    leveraged_returns = np.maximum(1 + (returns * leverage_factor), 0)

    leveraged_df = leveraged_returns.cumprod()
    leveraged_df = leveraged_df * base_value
    first_row = pd.DataFrame([base_value], index=[df_data.index[0]], columns=df_data.columns)
    leveraged_df = pd.concat([first_row, leveraged_df])

    return leveraged_df


def apply_leverage_numpy(data_array: np.ndarray, leverage_factor: float, base_price: float = None) -> np.ndarray:
    if base_price is None:
        base_price = data_array[0]

    returns = (data_array[1:] / data_array[:-1]) - 1
    leveraged_returns = np.maximum(1 + (returns * leverage_factor), 0)
    leveraged_prices = np.cumprod(leveraged_returns) * base_price
    return np.insert(leveraged_prices, 0, base_price)


@st.cache_data(show_spinner=False)
def calculate_portfolot_stats(start_amount: float, end_amount: float, min_start_date: datetime,
                              max_start_date: datetime, res_days: int, transition_tax: bool,
                              gain_tax: float, portfolio_list: list, x_var: str) -> dict:
    result = calculate_date_range(min_start_date=min_start_date, max_start_date=max_start_date,
                                  res_days=res_days, portfolio_list=portfolio_list)

    ticker_data_dict = result['ticker_data_dict']
    start_date_arr = result['start_date_arr']
    total_motnhs = result['total_motnhs']
    coeff_p_avg = result['coeff_p_avg']
    all_dates_map = result['all_dates_map']
    lev_np_dict = result['lev_np_dict']

    def sim_one_date(x_val: float, month_indices: np.ndarray):
        s_amt = x_val if x_var == "סכום התחלתי" else start_amount
        d_amt = x_val if x_var == "הפקדה חודשית" else None
        t_end = x_val if x_var == "סכום סופי" else end_amount

        start_money = s_amt
        final_money = s_amt
        total_deposit = 0
        for idx, portfolio in enumerate(portfolio_list):
            sum_weights = 0
            taxable_money = 0
            sheild_tax = 0
            next_stocks = []

            monthly_deposit = portfolio['הפקדה חודשית'] if d_amt is None else d_amt

            for row in portfolio['הרכב התיק']:
                sum_weights = sum_weights + row[COL_WEIGHT]
                if idx <= len(portfolio_list) - 2:
                    next_portfolio = portfolio_list[idx + 1]
                    for next_row_0 in next_portfolio['הרכב התיק']:
                        next_stocks.append(next_row_0[COL_STOCK])

            start_deposit = final_money + portfolio['הפקדה התחלתית']
            total_deposit = total_deposit + start_money + portfolio['הפקדה התחלתית']
            total_deposit = total_deposit + portfolio["מספר חודשים"] * monthly_deposit

            for row in portfolio['הרכב התיק']:
                stock, weight, leaverage = row[COL_STOCK], row[COL_WEIGHT] / sum_weights, row[COL_LEVERAGE]
                lev_key = f"{row[COL_STOCK]}_{row[COL_LEVERAGE]}"

                start_price = lev_np_dict[lev_key][month_indices[:-1]]
                end_price = np.ones(shape=(portfolio["מספר חודשים"],)) * lev_np_dict[lev_key][month_indices[-1]]

                num_stocks = (monthly_deposit * weight) / start_price
                num_stocks[0] = num_stocks[0] + (start_deposit * weight) / start_price[0]

                start_money = start_money + np.dot(num_stocks, start_price)
                final_money = final_money + np.dot(num_stocks, end_price)

                if idx == len(portfolio_list) - 1 or (transition_tax and stock not in next_stocks):
                    taxable_money = taxable_money + final_money - start_money

            final_money = final_money - (gain_tax / 100) * max(taxable_money - sheild_tax, 0)
            sheild_tax = max(sheild_tax - taxable_money, 0)

        return final_money - t_end, final_money, total_deposit

    progress_bar = st.progress(value=0)
    total_depos_list = []
    x_opt_list = []
    results_data = []
    x_0 = get_initial_guess_stats(start_amount=start_amount, end_amount=end_amount, deposit_val=coeff_p_avg,
                                  total_motnhs=total_motnhs, r_assume_p=6.0, x_var=x_var)
    last_x_opt = x_0
    for i, start_date in enumerate(start_date_arr):
        val_complete = i / len(start_date_arr)
        progress_bar.progress(value=val_complete, text=f"מעבד נתונים : {int(100 * val_complete)}%")

        current_indices = all_dates_map[i]

        if x_var == "סכום סופי":
            _, end_money, total_depos = sim_one_date(x_val=0, month_indices=current_indices)
            x_opt = end_money
        else:
            x_opt = fsolve(lambda x: sim_one_date(x_val=x, month_indices=current_indices)[0], x0=last_x_opt)[0]
            _, end_money, total_depos = sim_one_date(x_val=x_opt, month_indices=current_indices)
            last_x_opt = x_opt

        end_money, total_depos = round(end_money, 2), round(total_depos, 2)

        x_opt_list.append(x_opt)
        total_depos_list.append(total_depos)

        next_row = {
            "יתרה התחלתית": f"₪ {round(start_amount, 2)}",
            "תאריך התחלה": start_date,
            "תאריך סיום": start_date + relativedelta(months=total_motnhs),
            f"{x_var}": f"₪ {round(x_opt, 2)}",
            "יתרה סופית": float(end_money),
            "סך הפקדות נומינלי": float(total_depos)
        }
        if x_var == "סכום התחלתי":
            next_row.pop(f"{x_var}")
        elif x_var == "סכום סופי":
            next_row.pop(f"{x_var}")
        results_data.append(next_row)

    progress_bar.empty()
    x_opt_np = np.array(x_opt_list)
    min_idx = np.argmin(x_opt_np)
    max_idx = np.argmax(x_opt_np)
    min_val = x_opt_np[min_idx]
    max_val = x_opt_np[max_idx]

    min_date_str = start_date_arr[min_idx].strftime('%d/%m/%Y')
    min_end_date_str = (start_date_arr[min_idx] + relativedelta(months=total_motnhs)).strftime('%d/%m/%Y')
    min_date_str_range = f"{min_date_str} - {min_end_date_str}"

    max_date_str = start_date_arr[max_idx].strftime('%d/%m/%Y')
    max_end_date_str = (start_date_arr[max_idx] + relativedelta(months=total_motnhs)).strftime('%d/%m/%Y')
    max_date_str_range = f"{max_date_str} - {max_end_date_str}"
    stats_data = {'min_val': min_val, 'min_date_range': min_date_str_range,
                  'max_val': max_val, 'max_date_range': max_date_str_range}

    total_depos_avg = sum(total_depos_list) / len(total_depos_list)

    return {'stats_data': stats_data, 'hist_data': x_opt_np, 'x_var_name': x_var,
            'results_data': results_data, 'total_depos_avg': total_depos_avg}


@st.cache_data(show_spinner=False)
def get_ticker_first_date(ticker_symbol: str) -> datetime:
    try:
        data = yf.Ticker(ticker_symbol).history(period="max")
        return data.index[0].date()
    except Exception:
        return None


def get_stock_dates_bounds(portfolio_list: list):
    if not portfolio_list:
        return datetime(1990, 1, 1).date(), LAST_DAY_DATA

    tickers = set()
    total_months = 0
    for portfolio in portfolio_list:
        total_months += portfolio.get('מספר חודשים', 0)
        for row in portfolio.get('הרכב התיק', []):
            if row.get(COL_STOCK):
                tickers.add(row[COL_STOCK])

    if not tickers:
        default_start = datetime(1990, 1, 1).date()
        return default_start, LAST_DAY_DATA

    first_start_date_list = []
    for ticker in tickers:
        f_date = get_ticker_first_date(ticker_symbol=STOCK_OPTIONS[ticker])
        if f_date:
            first_start_date_list.append(f_date)

    if not first_start_date_list:
        first_start_date = datetime(1990, 1, 1).date()
    else:
        first_start_date = max(first_start_date_list)

    final_start_date = LAST_DAY_DATA

    return first_start_date, final_start_date


@st.cache_data(show_spinner=False)
def calculate_date_range(min_start_date: datetime, max_start_date: datetime,
                         res_days: int, portfolio_list: list) -> dict:
    tickers = set()
    coeff_p = []
    total_motnhs = 0
    for portfolio in portfolio_list:
        total_motnhs = total_motnhs + portfolio['מספר חודשים']
        for row in portfolio['הרכב התיק']:
            tickers.add(row[COL_STOCK])
            if 'אחוז משיכה שנתי' in portfolio.keys():
                coeff_p.append(portfolio['אחוז משיכה שנתי'])
            if 'הפקדה חודשית' in portfolio.keys():
                coeff_p.append(portfolio['הפקדה חודשית'])

    first_start_date = [min_start_date]
    ticker_data_dict = {}
    full_dates = None
    for ticker in tickers:
        ticker_data = yf.Ticker(ticker=STOCK_OPTIONS[ticker])
        ticker_data = ticker_data.history(period="max", interval="1d")
        ticker_data = ticker_data[["Close"]]
        full_range = pd.date_range(start=ticker_data.index[0], end=ticker_data.index[-1], freq='D')

        ticker_data = ticker_data.reindex(full_range, method="bfill")
        ticker_data.index = ticker_data.index.tz_localize(None)

        first_start_date.append(ticker_data.index[0].date())

        ticker_data_dict[ticker] = ticker_data

        full_dates = ticker_data.index

    first_start_date = max(first_start_date)

    bck_dawys = (datetime.now() - relativedelta(months=total_motnhs, days=BACKWARD_DAYS)).date()
    final_start_date = min(max_start_date, bck_dawys)

    start_date_arr = pd.date_range(start=first_start_date, end=final_start_date, freq=f'{res_days}D')

    coeff_p_avg = sum(coeff_p) / len(coeff_p)

    fast_cacl = False
    if fast_cacl:
        base_date = start_date_arr[0]
        offsets = [pd.DateOffset(months=m) for m in range(total_motnhs + 1)]

        base_monthly_dts = pd.to_datetime([base_date + opt for opt in offsets])
        base_indices = np.searchsorted(full_dates, base_monthly_dts)
        relative_offsets = base_indices - base_indices[0]

        start_indices = np.searchsorted(full_dates, start_date_arr)

        all_dates_map = start_indices[:, None] + relative_offsets
        all_dates_map = np.clip(all_dates_map, 0, len(full_dates) - 1)
    else:
        # 1. נמצא את היום בחודש של כל תאריך התחלה
        days_in_month = start_date_arr.day.values  # מערך של (N,)

        # 2. נהפוך את תאריכי ההתחלה לתקופות חודשיות (N,)
        periods = start_date_arr.to_period('M')

        # 3. יצירת מטריצת תקופות (N, M) על ידי הוספת חודשים [0, 1, 2...]
        month_offsets = np.arange(total_motnhs + 1)
        all_periods_matrix = periods.values[:, None] + month_offsets

        # 4. שיטוח המטריצה והמרה חזרה לתאריכים (Timestamp)
        flat_periods = all_periods_matrix.ravel()
        flat_timestamps = pd.PeriodIndex(flat_periods).to_timestamp()

        # 5. שכפול מערך הימים שיתאים למטריצה השטוחה
        repeated_days = np.repeat(days_in_month, total_motnhs + 1)

        # --- התיקון למקרי קצה (פברואר/סוף חודש) ---
        # מחלצים את מספר הימים המקסימלי שיש בכל חודש במטריצה (וקטורי)
        max_days_in_each_month = flat_timestamps.days_in_month.values

        # מגבילים את היום המקורי כך שלא יעבור את היום האחרון של אותו חודש
        # אם repeated_days הוא 31 ובחודש יש 28, actual_days יהיה 28
        actual_days = np.clip(repeated_days, 1, max_days_in_each_month)
        # ------------------------------------------

        # 6. יצירת התאריכים הסופיים המדויקים
        flat_dates = flat_timestamps + pd.to_timedelta(actual_days - 1, unit='D')

        # 7. חיפוש אינדקסים מהיר ב-NumPy ועיצוב מחדש למטריצה (N, M)
        flat_indices = np.searchsorted(full_dates, flat_dates)
        all_dates_map = flat_indices.reshape(all_periods_matrix.shape)

        # הגנה מחריגה מגבולות המערך
        all_dates_map = np.clip(all_dates_map, 0, len(full_dates) - 1)

    lev_np_dict = {}
    for portfolio in portfolio_list:
        for row in portfolio['הרכב התיק']:
            stock, lev = row[COL_STOCK], row[COL_LEVERAGE]
            key = f"{stock}_{lev}"
            if key not in lev_np_dict:
                raw_prices = ticker_data_dict[stock]['Close'].to_numpy()
                if lev == 1.0:
                    lev_np_dict[key] = raw_prices
                else:
                    lev_np_dict[key] = apply_leverage_numpy(data_array=raw_prices, leverage_factor=lev)

    return {'ticker_data_dict': ticker_data_dict, 'start_date_arr': start_date_arr,
            'total_motnhs': total_motnhs, 'coeff_p_avg': coeff_p_avg,
            'all_dates_map': all_dates_map, 'lev_np_dict': lev_np_dict}


def get_initial_guess_stats(start_amount: float, end_amount: float, deposit_val: float, total_motnhs: int,
                            r_assume_p: float = 6.0, x_var: str = None) -> float:
    r_0 = (1 + r_assume_p / 100) ** (1 / 12) - 1
    G_n = (1 + r_0) ** total_motnhs
    A_n = (G_n - 1) / r_0

    if x_var == "סכום התחלתי":
        x_0 = (end_amount - deposit_val * A_n) / G_n
    elif x_var == "הפקדה חודשית":
        x_0 = (end_amount - start_amount * G_n) * 1 / A_n
    else:
        x_0 = None
    return x_0


def get_initial_guess(start_amount: float, end_amount: float, withdraw_p: float, total_motnhs: int,
                      r_assume_p: float = 6.0, x_var: str = None) -> float:
    r_0 = (1 + r_assume_p / 100) ** (1 / 12) - 1
    G_n = (1 + r_0) ** total_motnhs
    A_n = (G_n - 1) / r_0

    if x_var == "סכום התחלתי":
        x_0 = end_amount / (G_n - (1 / 1200) * withdraw_p * A_n)
    elif x_var == "אחוז משיכה":
        x_0 = 12 * 100 * (G_n - end_amount / start_amount) / A_n
    else:
        x_0 = None
    return x_0


@st.cache_data(show_spinner=False)
def calculate_trinity_withdraw_stats(start_amount: float, end_amount: float, min_start_date: datetime,
                                     max_start_date: datetime, res_days: int, x_var: str, gain_tax: float,
                                     portfolio_list: list) -> dict:
    result = calculate_date_range(min_start_date=min_start_date, max_start_date=max_start_date,
                                  res_days=res_days, portfolio_list=portfolio_list)

    ticker_data_dict = result['ticker_data_dict']
    start_date_arr = result['start_date_arr']
    total_motnhs = result['total_motnhs']
    coeff_p_avg = result['coeff_p_avg']
    all_dates_map = result['all_dates_map']
    lev_np_dict = result['lev_np_dict']

    def simulate_single_date(x_val: float, month_indices: np.ndarray):
        s_amt = x_val if x_var == "סכום התחלתי" else start_amount
        w_pct = x_val if x_var == "אחוז משיכה" else None
        t_end = x_val if x_var == "סכום סופי" else end_amount

        final_money = s_amt
        total_final_withdraw = 0

        for idx, portfolio in enumerate(portfolio_list):
            weights = np.array([row[COL_WEIGHT] for row in portfolio['הרכב התיק']])
            weights /= weights.sum()

            stock_arrays = [lev_np_dict[f"{row[COL_STOCK]}_{row[COL_LEVERAGE]}"] for row in
                            portfolio['הרכב התיק']]

            base_style_is_start = (portfolio['סגנון משיכה'] == 'התחלתי')
            start_w_pct = portfolio['אחוז משיכה התחלתי'] / 100
            yearly_w_pct = portfolio['אחוז משיכה שנתי'] if w_pct is None else w_pct

            # משיכה התחלתית (חודש 0)
            base_w = s_amt if base_style_is_start else final_money
            start_withdraw = (1 / 12) * start_w_pct * base_w
            start_withdraw = min(start_withdraw, final_money)
            final_money -= start_withdraw
            total_final_withdraw += start_withdraw

            for j in range(total_motnhs):
                m_idx = month_indices[j]
                m_next_idx = month_indices[j + 1]

                gains = np.array([arr[m_next_idx] / arr[m_idx] for arr in stock_arrays])

                base_w = s_amt if base_style_is_start else final_money
                relative_withdraw = (1 / 1200) * yearly_w_pct * base_w

                step_gain = np.dot(weights, gains)
                final_money = (final_money * step_gain) - (min(relative_withdraw, final_money) * step_gain)

                total_final_withdraw += relative_withdraw
                if final_money < 0.0001:
                    final_money = 0
                    break

        return final_money - t_end, final_money, total_final_withdraw

    progress_bar = st.progress(value=0)
    total_withdraw_list = []
    x_opt_list = []
    results_data = []
    x_0 = get_initial_guess(start_amount=start_amount, end_amount=end_amount, withdraw_p=coeff_p_avg,
                            total_motnhs=total_motnhs, r_assume_p=6.0, x_var=x_var)
    last_x_opt = x_0
    for i, start_date in enumerate(start_date_arr):
        val_complete = i / len(start_date_arr)
        progress_bar.progress(value=val_complete, text=f"מעבד נתונים : {int(100 * val_complete)}%")

        current_indices = all_dates_map[i]

        if x_var == "סכום סופי":
            _, end_money, total_withdraw = simulate_single_date(x_val=0, month_indices=current_indices)
            x_opt = end_money
        else:
            x_opt = fsolve(lambda x: simulate_single_date(x_val=x, month_indices=current_indices)[0], x0=last_x_opt)[0]
            _, end_money, total_withdraw = simulate_single_date(x_val=x_opt, month_indices=current_indices)
            last_x_opt = x_opt

        end_money, total_withdraw = round(end_money, 2), round(total_withdraw, 2)

        x_opt_list.append(x_opt)
        total_withdraw_list.append(total_withdraw)

        next_row = {
            "תאריך התחלה": start_date,
            "תאריך סיום": start_date + relativedelta(months=total_motnhs),
            f"{x_var}": round(x_opt, 2),
            "יתרה סופית": round(end_money, 2),
            "סך משיכות נומינלי": float(total_withdraw)
        }
        if x_var == "סכום התחלתי":
            next_row.pop(f"{x_var}")
        elif x_var == "סכום סופי":
            next_row.pop(f"{x_var}")
        results_data.append(next_row)

    progress_bar.empty()

    avg_withdraw = sum(total_withdraw_list) / (len(total_withdraw_list) * total_motnhs)

    x_opt_np = np.array(x_opt_list)
    min_idx = np.argmin(x_opt_np)
    max_idx = np.argmax(x_opt_np)
    min_val = x_opt_np[min_idx]
    max_val = x_opt_np[max_idx]

    min_date_str = start_date_arr[min_idx].strftime('%d/%m/%Y')
    min_end_date_str = (start_date_arr[min_idx] + relativedelta(months=total_motnhs)).strftime('%d/%m/%Y')
    min_date_str_range = f"{min_date_str} - {min_end_date_str}"

    max_date_str = start_date_arr[max_idx].strftime('%d/%m/%Y')
    max_end_date_str = (start_date_arr[max_idx] + relativedelta(months=total_motnhs)).strftime('%d/%m/%Y')
    max_date_str_range = f"{max_date_str} - {max_end_date_str}"
    stats_data = {'min_val': min_val, 'min_date_range': min_date_str_range,
                  'max_val': max_val, 'max_date_range': max_date_str_range, 'total_withdraw': avg_withdraw}

    return {'stats_data': stats_data, 'hist_data': x_opt_np, 'x_var_name': x_var, 'results_data': results_data}
