import streamlit as st
import sys

from streamlit.web import cli as stcli
from streamlit import runtime
from params import *
from stock_statistics import stock_statistics_tab
from stock_trinity import stock_trinity_tab


def main():
    st.set_page_config(layout=PAGE_CONFIG_LAYOUT)
    st.markdown(body=HTML_STYLE, unsafe_allow_html=True)

    tab_1, tab_2 = st.tabs(tabs=[TABS_1, TABS_2])

    if 'trades' not in st.session_state:
        st.session_state.trades = []

    with st.sidebar:
        st.header(body=SIDE_BAR)

    with tab_1:
        stock_statistics_tab(st=st)
    with tab_2:
        stock_trinity_tab(st=st)


if __name__ == "__main__":
    if not runtime.exists():
        sys.argv = ["streamlit", "run", sys.argv[0]]
        stcli.main()
    else:
        main()