import os
import ast
import re
import unicodedata

import pandas as pd
import plotly.graph_objects as go

from dash import Dash, dcc, html, Input, Output

# -----------------------------
# CONFIG
# -----------------------------
STREETSAFE_CSV_OLD = "streetsafe_results.csv"
STREETSAFE_CSV_NEW = "streetsafe_results_new.csv"
USCITIES_CSV       = "uscities.csv"

TOP_N_SUBSTANCES = 50
RADIUS = 25


def normalize_text(s):
    if pd.isna(s):
        return ""
    s = str(s).strip()
    if s.lower() == "nan":
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"\s+", " ", s)
    return s.lower()


def to_list(x):
    if pd.isna(x):
        return []
    try:
        return ast.literal_eval(x)
    except Exception:
        return [x]


def quarter_label(ts: pd.Timestamp) -> str:
    q = ((ts.month - 1) // 3) + 1
    return f"{ts.year} Q{q}"


# -----------------------------
# LOAD STREETSAFE FILES
# -----------------------------
df_old = pd.read_csv(STREETSAFE_CSV_OLD)
df_new = pd.read_csv(STREETSAFE_CSV_NEW)
df = pd.concat([df_old, df_new], ignore_index=True)

# -----------------------------
# ADD NEW DATETIME COLUMN (KEEP ORIGINAL sample_date)
# -----------------------------
if "sample_date" not in df.columns:
    raise KeyError(f"'sample_date' column not found. Columns: {list(df.columns)}")

df["sample_datetime"] = pd.to_datetime(df["sample_date"], errors="coerce")
df = df.dropna(subset=["sample_datetime"]).copy()

# Quarter bucket (start of quarter)
df["quarter_start"] = df["sample_datetime"].dt.to_period("Q").dt.start_time

# -----------------------------
# PREP STREETSAFE
# -----------------------------
df["substances"] = df["substances"].apply(to_list)
df = df.explode("substances")

df["city_clean"]      = df["city"].apply(normalize_text)
df["state_clean"]     = df["state"].apply(normalize_text)
df["substance_clean"] = df["substances"].apply(normalize_text)

df["city_clean"] = df["city_clean"].str.replace(r"\s+county$", "", regex=True)

# -----------------------------
# LOAD USCITIES
# -----------------------------
cities = pd.read_csv(USCITIES_CSV)
cities["city_clean"]  = cities["city"].apply(normalize_text)
cities["state_clean"] = cities["state_name"].apply(normalize_text)

if "population" in cities.columns:
    cities = cities.sort_values("population", ascending=False)

cities = cities.drop_duplicates(["city_clean", "state_clean"])

# -----------------------------
# MERGE COORDS
# -----------------------------
merged = df.merge(
    cities[["city_clean", "state_clean", "lat", "lng"]],
    on=["city_clean", "state_clean"],
    how="left"
)

merged = merged.dropna(subset=["lat", "lng"]).copy()

# -----------------------------
# TOP SUBSTANCES
# -----------------------------
FORCE_INCLUDE = ["medetomidine", "nitazene"]

valid = merged.loc[
    merged["substance_clean"].notna() &
    (merged["substance_clean"].str.strip() != "")
]

counts = valid["substance_clean"].value_counts()
top_substances = counts.head(TOP_N_SUBSTANCES).index.tolist()
sorted_substances = sorted(top_substances, key=str.lower)

for s in FORCE_INCLUDE:
    if s in counts.index and s not in top_substances:
        top_substances.append(s)

if len(top_substances) > TOP_N_SUBSTANCES:
    forced_set = set(FORCE_INCLUDE)
    sorted_current = sorted(top_substances, key=lambda x: counts.get(x, 0), reverse=True)

    rebuilt = []
    for s in sorted_current:
        if s in forced_set or len(rebuilt) < TOP_N_SUBSTANCES:
            if s not in rebuilt:
                rebuilt.append(s)
        if len(rebuilt) == TOP_N_SUBSTANCES and forced_set.issubset(set(rebuilt)):
            break

    top_substances = rebuilt

# -----------------------------
# QUARTER SLIDER STEPS + MARKS
# -----------------------------
quarter_steps = (
    merged["quarter_start"]
    .dropna()
    .sort_values()
    .unique()
)

# ❌ Remove Q4 2026
quarter_steps = [q for q in quarter_steps if not (q.year == 2026 and q.month == 10)]
quarter_steps = list(quarter_steps)

if not quarter_steps:
    raise ValueError("No quarters found after parsing sample_date → sample_datetime.")

marks = {
    0: quarter_label(quarter_steps[0]),
    len(quarter_steps) - 1: quarter_label(quarter_steps[-1]),
}
for i, qs in enumerate(quarter_steps):
    if qs.month == 1:  # Q1
        marks[i] = quarter_label(qs)

# -----------------------------
# DASH APP
# -----------------------------
app = Dash(__name__)
server = app.server  # IMPORTANT for gunicorn on Render

app.layout = html.Div(
    style={
        "width": "100vw",
        "height": "100vh",
        "margin": "0",
        "padding": "0",
        "position": "relative",
        "overflow": "hidden",
        "fontFamily": "Arial, sans-serif",
    },
    children=[
        # FULLSCREEN MAP
        dcc.Graph(
            id="map",
            style={"width": "100vw", "height": "100vh"},
            config={"responsive": True, "displayModeBar": True},
        ),

        # FLOATING CONTROL PANEL (overlay)
        html.Div(
            style={
                "position": "absolute",
                "top": "12px",
                "left": "12px",
                "zIndex": "1000",
                "width": "460px",
                "maxWidth": "calc(100vw - 24px)",
                "padding": "10px 12px",
                "borderRadius": "12px",
                "background": "rgba(255, 255, 255, 0.88)",
                "boxShadow": "0 10px 25px rgba(0,0,0,0.18)",
                "backdropFilter": "blur(6px)",
                "WebkitBackdropFilter": "blur(6px)",
            },
            children=[
                html.Div(
                    style={"marginBottom": "10px"},
                    children=[
                        html.Div("Substance", style={"fontSize": "12px", "marginBottom": "4px"}),
                        dcc.Dropdown(
                            id="substance",
                            options=[{"label": s, "value": s} for s in sorted_substances],
                            value=sorted_substances[0] if sorted_substances else None,
                            clearable=False,
                        ),
                    ],
                ),

                html.Div(
                    id="q_label",
                    style={
                        "fontSize": "18px",
                        "fontWeight": "600",
                        "marginTop": "10px",
                        "marginBottom": "6px",
                        "color": "#222",
                    }
                ),

                html.Div(
                    style={"marginBottom": "6px"},
                    children=[
                        html.Div("Quarter", style={"fontSize": "12px", "marginBottom": "4px"}),
                        dcc.Slider(
                            id="q_idx",
                            min=0,
                            max=max(len(quarter_steps) - 1, 0),
                            step=1,
                            value=max(len(quarter_steps) - 1, 0),
                            marks=marks,
                            tooltip={"enabled": False, "always_visible": False},
                        ),
                    ],
                ),
                
                dcc.Checklist(
                    id="all_time",
                    options=[{"label": " Show all samples", "value": "all"}],
                    value=["all"],
                    style={"fontSize": "18px", "fontWeight": "600"},
                ),
                html.Div(
                    "When checked, the quarter slider is deactivated.",
                    style={"fontSize": "12px", "color": "#555", "marginTop": "4px"}
                ),
            ],
        ),
    ],
)

@app.callback(
    Output("map", "figure"),
    Output("q_label", "children"),
    Output("q_idx", "disabled"),
    Input("substance", "value"),
    Input("q_idx", "value"),
    Input("all_time", "value"),
)
def update_map(substance, q_idx, all_time_values):
    show_all = "all" in (all_time_values or [])

    # Defensive: if quarter_steps is empty, avoid crashes
    selected_q = quarter_steps[int(q_idx)] if quarter_steps else None

    sub_df = merged[merged["substance_clean"] == substance] if substance else merged

    if (not show_all) and (selected_q is not None):
        sub_df = sub_df[sub_df["quarter_start"] == selected_q]

    agg = (
        sub_df.groupby(["lat", "lng"], as_index=False)
              .size()
              .rename(columns={"size": "count"})
    )

    fig = go.Figure()
    fig.add_trace(
        go.Densitymap(
            lat=agg["lat"] if len(agg) else [],
            lon=agg["lng"] if len(agg) else [],
            z=agg["count"] if len(agg) else [],
            radius=RADIUS,
            name=substance or ""
        )
    )

    fig.update_traces(colorbar=dict(thickness=12))

    if show_all or (selected_q is None):
        label = f"Quarter: All samples | Substance: {substance}"
    else:
        label = f"Quarter: {quarter_label(selected_q)} | Substance: {substance}"

    fig.update_layout(
        title=None,
        margin=dict(r=0, t=0, l=0, b=0),
        map=dict(
            style="open-street-map",
            center=dict(lat=39.5, lon=-98.35),
            zoom=3.2
        ),
    )

    return fig, label, show_all


# -----------------------------
# ENTRYPOINT (Render)
# -----------------------------
if __name__ == "__main__":
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", 8050))
    app.run(debug=False, host=host, port=port)



