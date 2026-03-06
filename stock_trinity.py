import streamlit as st
import pandas as pd
import numpy as np
import plotly.express as px
from datetime import datetime
from dateutil.relativedelta import relativedelta
from params import *
from utils import get_stock_dates_bounds, calculate_trinity_withdraw_stats


def get_all_trin_plans_data() -> list:
    out_list = []

    if 'trin_plans' not in st.session_state:
        return []

    for plan in st.session_state.trin_plans:
        p_id = plan["trin_id"]
        p_name = plan.get("trin_name", f"תכנית {p_id}")

        first_deposit = st.session_state.get(f"trin_fst_amt_{p_id}", 0)
        monthly_deposit = st.session_state.get(f"trin_amt_{p_id}", 0)
        months_count = st.session_state.get(f"trin_pay_{p_id}", 0)
        deposit_type = st.session_state.get(f"trin_pay_method_{p_id}", 0)

        raw_data = plan.get("trin_current_df")

        if isinstance(raw_data, list):
            df_to_process = pd.DataFrame(raw_data)
        else:
            df_to_process = raw_data

        if df_to_process is not None and isinstance(df_to_process, pd.DataFrame) and not df_to_process.empty:
            is_valid = df_to_process[COL_STOCK].notna() & (df_to_process[COL_WEIGHT] > 0)
            df_valid_only = df_to_process[is_valid]

            if not df_valid_only.empty:
                out_list.append({
                    "שם תוכנית": p_name,
                    "אחוז משיכה התחלתי": first_deposit,
                    "אחוז משיכה שנתי": monthly_deposit,
                    "מספר חודשים": months_count,
                    "סגנון משיכה": deposit_type,
                    "הרכב התיק": df_valid_only.to_dict('records')
                })
    return out_list


def stock_trinity_tab(st):
    st.title("📊 סימולציית כלל טריניטי")

    if 'trin_plans' not in st.session_state:
        st.session_state.trin_plans = [
            {"trin_id": 1, "trin_name": "תכנית 1",
             "trin_current_df": DEF_PORTFOLIO.copy()}
        ]

    def update_plan_df(p_id):
        editor_key = f"trin_editor_ui_{p_id}"
        if editor_key in st.session_state:
            for plan_0 in st.session_state.trin_plans:
                if plan_0["trin_id"] == p_id:
                    raw_data = plan_0.get("trin_current_df")

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
                            # אנחנו יוצרים שורה חדשה עם ערכי ברירת מחדל כדי למנוע None בטורים קריטיים
                            new_row = {COL_STOCK: None, COL_WEIGHT: 0.0, COL_LEVERAGE: 1.0}
                            new_row.update(row)
                            new_df = pd.concat([new_df, pd.DataFrame([new_row])], ignore_index=True)

                    if changes.get("deleted_rows"):
                        new_df = new_df.drop(changes["deleted_rows"]).reset_index(drop=True)

                    plan_0["trin_current_df"] = new_df
                    break

    def add_plan():
        new_id = max([p["trin_id"] for p in st.session_state.trin_plans]) + 1 if st.session_state.trin_plans else 1
        st.session_state.trin_plans.append({
            "trin_id": new_id,
            "trin_name": f"תכנית {new_id}",
            "trin_current_df": DEF_PORTFOLIO.copy()
        })

    def delete_plan(plan_id):
        if len(st.session_state.trin_plans) > 1:
            st.session_state.trin_plans = [p for p in st.session_state.trin_plans if p["trin_id"] != plan_id]
        else:
            pass
            # st.warning("חובה להשאיר לפחות תוכנית אחת.")

    def move_plan(index, direction):
        new_index = index + direction
        if 0 <= new_index < len(st.session_state.trin_plans):
            st.session_state.trin_plans[index], st.session_state.trin_plans[new_index] = \
                st.session_state.trin_plans[new_index], st.session_state.trin_plans[index]

    col1, col2, col3, col4 = st.columns(spec=[2, 2, 1, 2.4])
    with col4:
        x_variable = st.segmented_control(label=f"\u202bחשב :", options=["סכום סופי", "אחוז משיכה", "סכום התחלתי"],
                                          default="סכום סופי", key=f"trin_x_variable")
    with col1:
        start_amount_dis = bool(x_variable == "סכום התחלתי")
        start_amount = st.number_input(label="סכום התחלתי בתיק", min_value=0.0, disabled=start_amount_dis,
                                       max_value=1_000_000_000.0, value=1_000_000.0, step=1.0, key="start_amount")
    with col2:
        end_amount_dis = bool(x_variable == "סכום סופי")
        end_amount = st.number_input(label="יעד סופי בתיק", min_value=0.0, disabled=end_amount_dis,
                                     max_value=1_000_000_000.0, value=1_000_000.0, step=1.0, key="end_amount")
    with col3:
        trin_gain_tax = st.number_input(label="\u202bמס רווחי הון (%)", min_value=0.0, max_value=100.0,
                                        value=25.0, step=0.01, key="trin_gain_tax")

    col1, col2, col3 = st.columns(spec=[1, 1, 1])
    with col1:
        trin_min_start_date = st.date_input(label="תאריך התחלה מינימלי", value=datetime(day=1, month=1, year=1980),
                                            format="DD/MM/YYYY", min_value=None, max_value=None,
                                            key="trin_min_start_date")
    with col2:
        trin_max_start_date = st.date_input(label="תאריך התחלה מקסימלי", value=datetime(day=1, month=1, year=2000),
                                            format="DD/MM/YYYY", min_value=None, max_value=None,
                                            key="trin_max_start_date")
    with col3:
        trin_res_days = st.number_input(label="רזולוצייה ימים לדגימה", min_value=1, max_value=500, value=40, step=1,
                                        key="trin_res_days")

    limit_spot = st.empty()

    st.button("➕ הוסף תוכנית חדשה", on_click=add_plan, key="add_plan_trin")

    for i, plan in enumerate(st.session_state.trin_plans):
        plan_id = plan["trin_id"]

        name_key = f"trin_name_input_{plan_id}"
        current_name = st.session_state.get(name_key, plan.get("trin_name", f"תכנית {plan_id}"))

        with st.expander(f"📌 **הגדרות עבור : {current_name}**", expanded=True):
            col_title, empty_col, col_up, col_down, col_del = st.columns([0.5, 0.4, 0.1, 0.1, 0.1])

            with col_title:
                new_name = st.text_input(f"שם תכנית {plan_id}", value=plan.get("trin_name", f"תכנית {plan_id}"),
                                         key=f"trin_name_input_{plan_id}", label_visibility="collapsed")
                plan["trin_name"] = new_name

            with col_up:
                st.button("🔼", key=f"trin_up_{plan_id}", on_click=move_plan, args=(i, -1), disabled=(i == 0))
            with col_down:
                st.button("🔽", key=f"trin_down_{plan_id}", on_click=move_plan, args=(i, 1),
                          disabled=(i == len(st.session_state.trin_plans) - 1))
            with col_del:
                st.button("🗑️", key=f"trin_del_{plan_id}", on_click=delete_plan, args=(plan_id,))

            c1, c2, c3, c4, c5 = st.columns(5)
            with c1:
                p_start = st.number_input(label=f"\u202bאחוז משיכה התחלתי (%)", min_value=0.0,
                                          max_value=100.0, value=0.0, step=0.01, key=f"trin_fst_amt_{plan_id}")
            with c2:
                p_dep_dis = bool(x_variable == "אחוז משיכה")
                p_month = st.number_input(label=f"\u202bאחוז משיכה שנתי (%)", min_value=0.0, disabled=p_dep_dis,
                                          max_value=100.0, value=4.0, step=0.01, key=f"trin_amt_{plan_id}")
            with c3:
                n_month = st.number_input(label=f"מספר חודשי משיכה", min_value=0,
                                          max_value=500, value=240, step=1, key=f"trin_pay_{plan_id}")
            with c4:
                p_type = st.segmented_control(label=f"\u202bמשיכה ממחיר :", options=["התחלתי", "נוכחי"],
                                              default="התחלתי", key=f"trin_pay_method_{plan_id}")
            with c5:
                if p_type == "התחלתי":
                    v_0 = (1 / 12) * (p_month / 100) * start_amount
                    c5.metric("מחיר", f"{v_0:,.2f}₪")

            if "trin_current_df" not in plan or plan["trin_current_df"] is None:
                plan["trin_current_df"] = DEF_PORTFOLIO.copy()

            current_df = plan["trin_current_df"]

            if isinstance(current_df, list):
                current_df = pd.DataFrame(current_df)

            st.data_editor(data=current_df, column_config=PRTFOLIO_COFIG,
                           num_rows="dynamic", use_container_width=True,
                           key=f"trin_editor_ui_{plan_id}",
                           on_change=update_plan_df, args=(plan_id,))

    dict_final = get_all_trin_plans_data()
    if dict_final:
        abs_min, abs_max = get_stock_dates_bounds(portfolio_list=dict_final)

        with limit_spot:
            if abs_max >= abs_min:
                st.info(f"✅ טווח זמין לסימולציה: {abs_min.strftime('%d/%m/%Y')} עד {abs_max.strftime('%d/%m/%Y')}")
            else:
                diff = relativedelta(datetime.now().date(), abs_min)
                max_months = (diff.years * 12) + diff.months
                st.error(f"❌ משך הסימולציה ארוך מדי. עבור המניות בתיק, ניתן להזין עד **{max_months}** חודשים.")
    else:
        with limit_spot:
            st.warning("⚠️ אנא הזן הרכב תיק (מניות ומשקלים) כדי לראות את הטווח הזמין.")

    # with st.expander("הדפס את כל נתוני התוכניות", expanded=False):
    #     if st.button("הדפס את כל נתוני התוכניות", key="print_trin"):
    #         st.write(dict_final)

    if "final_results_trin" not in st.session_state:
        st.session_state.final_results_trin = None

    if st.button("בצע סימולציה", key="butt_apply_trin"):
        st.session_state.final_results_trin = calculate_trinity_withdraw_stats(start_amount=start_amount,
                                                                               end_amount=end_amount,
                                                                               min_start_date=trin_min_start_date,
                                                                               max_start_date=trin_max_start_date,
                                                                               res_days=trin_res_days,
                                                                               gain_tax=trin_gain_tax,
                                                                               x_var=x_variable,
                                                                               portfolio_list=dict_final)

    if x_variable == "אחוז משיכה":
        res_units = "%"
    else:
        res_units = "₪"

    analysis_container = st.container()
    with analysis_container:
        header_spot = st.empty()
        stats_spot = st.container()
        plot_spot = st.empty()
        bin_spot = st.empty()
        slider_spot = st.empty()
        warn_spot = st.empty()
        history_spot = st.empty()

    if st.session_state.final_results_trin is not None:
        final_arr = st.session_state.final_results_trin['hist_data']
        final_stats = st.session_state.final_results_trin['stats_data']
        results_df_data = st.session_state.final_results_trin['results_data']

        with header_spot:
            st.subheader("📊 ניתוח התפלגות תשואות")

        with bin_spot:
            n_bins = st.slider("\u202bמספר עמודות (Bins) :", min_value=10,
                               max_value=400, value=100, step=1, key="trin_bins")

        with slider_spot:
            col1, col2, col3 = st.columns(spec=[2, 1, 1, ])
            unit_mapping = {"1": float(1), "K": float(1e3), "M": float(1e6)}

            selected_label = st.session_state.get("trin_unit_selector", "1")
            current_step = unit_mapping.get(selected_label, 1.0)
            with col2:
                selected_unit = st.segmented_control("\u202bיחידות :", options=["1", "K", "M"],
                                                     default="1", key="trin_unit_selector")

            with col1:
                min_val = float(np.min(final_arr)) / current_step
                max_val = float(np.max(final_arr)) / current_step
                a_units, b_units = st.slider(label="טווח ערכים", min_value=min_val, max_value=max_val,
                                             value=(min_val, max_val), step=0.01, format="%.3f",
                                             key="trin_range_slider")

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
                st.dataframe(results_df_data, use_container_width=True,
                             hide_index=True, column_config=DF_HISTORY_CFG)

        with stats_spot:
            col1, col2, col3, col4 = st.columns(4)
            with col1:
                total_withdraw = final_stats.get('total_withdraw', 0)
                total_withdraw_p = round(((12 * total_withdraw) / start_amount) * 100, 2)
                col1.metric("משיכה חודשית ממוצעת", f"{total_withdraw:,.2f}₪ ({total_withdraw_p} %)")
            with col3:
                col3.metric("ממוצע", f"{np.mean(final_arr):,.2f}{res_units}")
            with col4:
                col4.metric("חציון", f"{np.median(final_arr):,.2f}{res_units}")

            col1, col2 = st.columns(2)
            with col1:
                min_val = final_stats['min_val']
                col1.metric("מינימום", f"{min_val:,.2f}{res_units} ")
            with col2:
                min_range = final_stats['min_date_range']
                col2.metric("טווח תאריך מינימום", f"{min_range}")

            col1, col2 = st.columns(2)
            with col1:
                max_val = final_stats['max_val']
                col1.metric("מקסימום", f"{max_val:,.2f}{res_units}")
            with col2:
                max_range = final_stats['max_date_range']
                col2.metric("טווח תאריך מינימום", f"{max_range}")

        with plot_spot:
            fig = px.histogram(x=final_arr, nbins=n_bins, title="",
                               labels={'x': '', 'y': 'שכיחות'}, color_discrete_sequence=['#1f77b4'])

            bin_size = (max_val - min_val) / n_bins if max_val != min_val else 1
            highlight_end = b + (bin_size * 1) if b >= max_val * 0.99 else b

            fig.update_traces(xbins=dict(start=min_val, end=max_val + bin_size, size=bin_size), autobinx=False)

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
