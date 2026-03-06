import streamlit as st
import pandas as pd
import numpy as np
import plotly.express as px
from datetime import datetime
from params import *
from utils import get_stock_dates_bounds, calculate_portfolot_stats


def get_all_plans_data() -> list:
    out_list = []
    # וודא שאנחנו רצים על מה שיש בזיכרון
    if 'plans' not in st.session_state:
        return []

    for plan in st.session_state.plans:
        p_id = plan["id"]
        p_name = plan.get("name", f"תכנית {p_id}")

        first_deposit = st.session_state.get(f"fst_amt_{p_id}", 0)
        monthly_deposit = st.session_state.get(f"amt_{p_id}", 0)
        months_count = st.session_state.get(f"pay_{p_id}", 0)

        # שליפת ה-DF שנשמר בתוך המילון של התוכנית
        raw_data = plan.get("current_df")
        if isinstance(raw_data, list):
            df_to_process = pd.DataFrame(raw_data)
        else:
            df_to_process = raw_data

        if df_to_process is not None and isinstance(df_to_process, pd.DataFrame) and not df_to_process.empty:
            # ניקוי שורות ריקות (כאלו שהתווספו ב-"+" אבל לא מולאו)
            df_clean = df_to_process.dropna(subset=[COL_STOCK])

            if not df_clean.empty:
                out_list.append({
                    "שם תוכנית": p_name,
                    "הפקדה התחלתית": first_deposit,
                    "הפקדה חודשית": monthly_deposit,
                    "מספר חודשים": months_count,
                    "הרכב התיק": df_clean.to_dict('records')
                })
    return out_list


def stock_statistics_tab(st):
    st.title("📊 ניהול תוכניות השקעה דינמי")

    # --- 1. אתחול הזיכרון (פעם אחת בלבד במבנה אחיד) ---
    if 'plans' not in st.session_state:
        st.session_state.plans = [
            {"id": 1, "name": "תכנית 1",
             "current_df": pd.DataFrame(columns=[COL_STOCK, COL_WEIGHT, COL_LEVERAGE])}
        ]

    def update_plan_df(p_id):
        editor_key = f"editor_ui_{p_id}"
        if editor_key in st.session_state:
            for plan_0 in st.session_state.plans:
                if plan_0["id"] == p_id:
                    raw_data = plan_0.get("current_df")

                    if isinstance(raw_data, list):
                        new_df = pd.DataFrame(raw_data)
                    else:
                        new_df = raw_data.copy()

                    changes = st.session_state[editor_key]

                    if changes.get("edited_rows"):
                        for index, updates in changes["edited_rows"].items():
                            row_idx = int(index)
                            for key, value in updates.items():
                                new_df.at[row_idx, key] = value

                    if changes.get("added_rows"):
                        for row in changes["added_rows"]:
                            if row:
                                new_row_df = pd.DataFrame([row])
                                new_df = pd.concat([new_df, new_row_df], ignore_index=True)

                    if changes.get("deleted_rows"):
                        new_df = new_df.drop(changes["deleted_rows"]).reset_index(drop=True)

                    plan_0["current_df"] = new_df
                    break

    def add_plan():
        new_id = max([p["id"] for p in st.session_state.plans]) + 1 if st.session_state.plans else 1
        st.session_state.plans.append({
            "id": new_id,
            "name": f"תכנית {new_id}",
            "current_df": pd.DataFrame(columns=[COL_STOCK, COL_WEIGHT, COL_LEVERAGE])  # אתחול תקין
        })

    def delete_plan(plan_id):
        if len(st.session_state.plans) > 1:
            st.session_state.plans = [p for p in st.session_state.plans if p["id"] != plan_id]
        else:
            pass
            # st.warning("חובה להשאיר לפחות תוכנית אחת.")

    def move_plan(index, direction):
        new_index = index + direction
        if 0 <= new_index < len(st.session_state.plans):
            st.session_state.plans[index], st.session_state.plans[new_index] = \
                st.session_state.plans[new_index], st.session_state.plans[index]

    col1, col2, col3, col4, col5 = st.columns(spec=[2.8, 2.8, 2, 2, 5])
    with col5:
        x_variable = st.segmented_control(label=f"\u202bחשב :", options=["סכום סופי", "הפקדה חודשית", "סכום התחלתי"],
                                          default="סכום סופי")
    with col1:
        start_amount_dis = bool(x_variable == "סכום התחלתי")
        start_amount = st.number_input(label="סכום התחלתי בתיק", min_value=0.0,
                                       max_value=1_000_000_000.0, value=0.0, step=1.0, disabled=start_amount_dis)
    with col2:
        end_amount_dis = bool(x_variable == "סכום סופי")
        end_amount = st.number_input(label="יעד סופי בתיק", min_value=0.0,
                                     max_value=1_000_000_000.0, value=1_000_000.0, step=1.0, disabled=end_amount_dis)
    with col3:
        gain_tax = st.number_input(label="\u202bמס רווחי הון (%)", min_value=0.0, max_value=100.0, value=25.0,
                                   step=0.01)
    with col4:
        transition_tax = st.segmented_control(label="\u202b אירוע מס", options=["בטל", "אפשר"],
                                              default="בטל", help="בצע אירוע מס במעבר בין תמהילים בעלי מניות שונות")
        transition_tax_bool = (transition_tax == "אפשר")

    col1, col2, col3 = st.columns(spec=[1, 1, 1])
    with col1:
        min_start_date = st.date_input(label="תאריך התחלה מינימלי", value=datetime(day=1, month=1, year=1980),
                                       format="DD/MM/YYYY", min_value=None, max_value=None)
    with col2:
        max_start_date = st.date_input(label="תאריך התחלה מקסימלי", value=datetime(day=1, month=1, year=2000),
                                       format="DD/MM/YYYY", min_value=None, max_value=None)
    with col3:
        res_days = st.number_input(label="רזולוציית ימים לדגימה", min_value=1, max_value=500, value=40, step=1)

    limit_spot = st.empty()
    st.button("➕ הוסף תוכנית חדשה", on_click=add_plan)

    for i, plan in enumerate(st.session_state.plans):
        plan_id = plan["id"]

        name_key = f"name_input_{plan_id}"
        current_name = st.session_state.get(name_key, plan.get("name", f"תכנית {plan_id}"))

        with (st.expander(f"📌 **הגדרות עבור : {current_name}**", expanded=True)):
            col_title, empty_col, col_up, col_down, col_del = st.columns([0.5, 0.4, 0.1, 0.1, 0.1])

            with col_title:
                new_name = st.text_input(f"שם תכנית {plan_id}", value=plan.get("name", f"תכנית {plan_id}"),
                                         key=f"name_input_{plan_id}", label_visibility="collapsed")
                plan["name"] = new_name

            with col_up:
                st.button("🔼", key=f"up_{plan_id}", on_click=move_plan, args=(i, -1), disabled=(i == 0))
            with col_down:
                st.button("🔽", key=f"down_{plan_id}", on_click=move_plan, args=(i, 1),
                          disabled=(i == len(st.session_state.plans) - 1))
            with col_del:
                st.button("🗑️", key=f"del_{plan_id}", on_click=delete_plan, args=(plan_id,))

            c1, c2, c3 = st.columns(3)
            with c1:
                st.number_input(label=f"סכום הפקדה התחלתית (₪)", min_value=0.0,
                                max_value=1_000_000.0, value=0.0, step=0.01, key=f"fst_amt_{plan_id}")
            with c2:
                dep_dis = bool(x_variable == "הפקדה חודשית")
                st.number_input(label=f"סכום הפקדה חודשית (₪)", min_value=0.0,
                                max_value=10_000.0, value=1000.0, step=0.01, key=f"amt_{plan_id}", disabled=dep_dis)
            with c3:
                st.number_input(label=f"מספר חודשי הפקדה", min_value=0,
                                max_value=500, value=240, step=1, key=f"pay_{plan_id}")

            current_df = plan.get("current_df")
            if isinstance(current_df, list):
                current_df = pd.DataFrame(current_df)
            if current_df is None or (isinstance(current_df, pd.DataFrame) and current_df.empty) or \
                (isinstance(current_df, list) and len(current_df) == 0):
                current_df = DEF_PORTFOLIO

            plan["current_df"] = st.data_editor(data=current_df, column_config=PRTFOLIO_COFIG,
                                                num_rows="dynamic", use_container_width=True,
                                                key=f"editor_ui_{plan_id}",
                                                on_change=update_plan_df, args=(plan_id,))

    dict_final = get_all_plans_data()
    if dict_final:
        abs_min, abs_max = get_stock_dates_bounds(portfolio_list=dict_final)

        with limit_spot:
            if abs_max >= abs_min:
                st.info(f"✅ טווח זמין לסימולציה : {abs_min.strftime('%d/%m/%Y')} עד {abs_max.strftime('%d/%m/%Y')}")
            else:
                diff = relativedelta(datetime.now().date(), abs_min)
                max_months = (diff.years * 12) + diff.months
                st.error(f"❌ משך הסימולציה ארוך מדי. עבור המניות בתיק, ניתן להזין עד **{max_months}** חודשים.")

    # with st.expander("הדפס את כל נתוני התוכניות", expanded=False):
    #     if st.button("הדפס את כל נתוני התוכניות"):
    #         st.write(dict_final)

    if "final_results" not in st.session_state:
        st.session_state.final_results = None

    if st.button("🚀 בצע סימולציה"):
        st.session_state.final_results = calculate_portfolot_stats(start_amount=start_amount,
                                                                   end_amount=end_amount,
                                                                   min_start_date=min_start_date,
                                                                   max_start_date=max_start_date,
                                                                   res_days=res_days,
                                                                   transition_tax=transition_tax_bool,
                                                                   gain_tax=gain_tax,
                                                                   portfolio_list=dict_final,
                                                                   x_var=x_variable)

    analysis_container = st.container()
    with analysis_container:
        header_spot = st.empty()
        stats_spot = st.container()
        plot_spot = st.empty()
        bin_spot = st.empty()
        slider_spot = st.empty()
        warn_spot = st.empty()
        history_spot = st.empty()

    if st.session_state.final_results is not None:
        final_arr = st.session_state.final_results['hist_data']
        final_stats = st.session_state.final_results['stats_data']
        results_df_data = st.session_state.final_results['results_data']
        total_deposit_avgerage = st.session_state.final_results['total_depos_avg']
        ann_r_avg = st.session_state.final_results['ann_r_avg']

        with header_spot:
            st.subheader("📊 ניתוח התפלגות תשואות")

        with bin_spot:
            n_bins = st.slider("\u202bמספר עמודות (Bins) :", min_value=10,
                               max_value=400, value=100, step=1)

        with slider_spot:
            col1, col2, col3 = st.columns(spec=[2, 1, 1, ])
            unit_mapping = {"1": float(1), "K": float(1e3), "M": float(1e6)}

            selected_label = st.session_state.get("unit_selector", "1")
            current_step = unit_mapping.get(selected_label, 1.0)
            with col2:
                selected_unit = st.segmented_control("\u202bיחידות :", options=["1", "K", "M"],
                                                     default="1", key="unit_selector")

            with col1:
                min_val = float(np.min(final_arr)) / current_step
                max_val = float(np.max(final_arr)) / current_step
                a_units, b_units = st.slider(label="טווח ערכים", min_value=min_val, max_value=max_val,
                                             value=(min_val, max_val), step=0.01, format="%.3f", key="range_slider")

                a = a_units * current_step
                b = b_units * current_step

            with col3:
                count_in_range = np.sum((final_arr >= a) & (final_arr <= b))
                percentage = (count_in_range / len(final_arr)) * 100
                col3.metric("מספר דגימות בטווח", f"{count_in_range:,} / {len(final_arr):,} ({percentage:.2f}%)")

        with warn_spot:
            if a > b:
                st.info(f"\u202b המינימום גדול מהמקסימום חביבי ⚠️")

        with history_spot:
            with st.expander("📋 פירוט תוצאות לפי תקופות היסטוריות", expanded=False):
                st.dataframe(results_df_data, use_container_width=True, hide_index=True, column_config=DF_HISTORY_2_CFG)

        with stats_spot:
            col1, col2, col3, col4 = st.columns(4)
            with col1:
                col1.metric("\u202b סך הפקדות (ממוצע)", f"{total_deposit_avgerage:,.2f}₪")
            with col2:
                col2.metric("\u202b תשואה שנתית שקולה (ממוצע)", f"{ann_r_avg:,.2f} %")
            with col3:
                col3.metric("ממוצע", f"{np.mean(final_arr):,.2f}₪")
            with col4:
                col4.metric("חציון", f"{np.median(final_arr):,.2f}₪")

            col1, col2 = st.columns(2)
            with col1:
                min_val = final_stats['min_val']
                min_r_val = final_stats['min_r_val']
                col1.metric("מינימום", f"{min_val:,.2f}₪ ({min_r_val:,.2f} %)")
            with col2:
                min_range = final_stats['min_date_range']
                col2.metric("טווח תאריך מינימום", f"{min_range}")

            col1, col2 = st.columns(2)
            with col1:
                max_val = final_stats['max_val']
                max_r_val = final_stats['max_r_val']
                col1.metric("מקסימום", f"{max_val:,.2f}₪ ({max_r_val:,.2f} %)")
            with col2:
                max_range = final_stats['max_date_range']
                col2.metric("טווח תאריך מינימום", f"{max_range}")

        with plot_spot:
            fig = px.histogram(x=final_arr, nbins=n_bins, title="",
                               labels={'x': '', 'y': 'שכיחות'}, color_discrete_sequence=['#1f77b4'])

            bin_size = (max_val - min_val) / n_bins if max_val != min_val else 1
            highlight_end = b + (bin_size * 1) if b >= max_val * 0.99 else b

            if a < b:
                fig.add_vrect(x0=a, x1=highlight_end, fillcolor="rgba(255, 165, 0, 0.25)",
                              layer="below", line_width=0)

            mean_val = np.mean(final_arr)
            median_val = np.median(final_arr)

            fig.add_vline(x=mean_val, line_dash="dash", line_color="red", layer="above")
            fig.add_vline(x=median_val, line_dash="dash", line_color="black", layer="above")

            fig.add_scatter(x=[None], y=[None], mode="lines", line=dict(color="red", dash="dash"),
                            name=f"\u202bממוצע : {mean_val:,.2f}", showlegend=True)

            fig.add_scatter(x=[None], y=[None], mode="lines", line=dict(color="black", dash="dash"),
                            name=f"\u202bחציון : {median_val:,.2f}", showlegend=True)

            fig.update_xaxes(range=[min_val, max_val + bin_size], automargin=True, showspikes=True, spikesnap="data")
            fig.update_layout(hovermode="x unified", hoverlabel=dict(bgcolor="white", font_size=14), bargap=0.02,
                              xaxis=dict(fixedrange=True), yaxis=dict(fixedrange=True),
                              legend=dict(orientation="v", yanchor="bottom", y=1.02, xanchor="right", x=1),
                              font=dict(size=16, color="black"), )
            fig.update_annotations(align="right")
            st.plotly_chart(fig, config={'displayModeBar': False}, use_container_width=True)

    st.markdown('<div style="height: 400px;"></div>', unsafe_allow_html=True)
