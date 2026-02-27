# US Drug Heatmap

Interactive browser map of continental US drug testing data from the [StreetSafe Supply Network](https://streetsafe.supply), with a multi-select substance filter and quarter-by-quarter time slider.

## To Run

```sh
python -m http.server 8080
```

## Files

```
web/                        ← JS web app (new)
  index.html
  assets/
    style.css
    app.js
dash/                       ← Python/Dash app (original)
  app.py
  assets/style.css
  requirements.txt
  streetsafe_results.csv
  streetsafe_results_new.csv
  uscities.csv
```

## WordPress embed (iframe)

The simplest approach is to host this repo as a static site and embed via iframe.

### 1. Host the files

Enable [GitHub Pages](https://pages.github.com) on this repo:

1. Go to **Settings → Pages → Branch: main → folder: / (root) → Save**
2. Your URL will be `https://gpgilbert1.github.io/dash/web/`

### 2. Embed in WordPress

In the WordPress block editor, add a **Custom HTML** block and paste:

```html
<iframe
  src="https://gpgilbert1.github.io/dash/web/"
  width="100%"
  height="600"
  style="border:none; border-radius:8px;"
  loading="lazy"
  title="US Drug Heatmap">
</iframe>
```

Adjust `height` to taste. The map is fully responsive inside the iframe.

## Local preview

```bash
# from repo root:
python3 -m http.server 8080
# open http://localhost:8080/web/
```

> **Note:** The app fetches CSV files via `fetch()`, so it must be served over HTTP — opening `index.html` directly as a `file://` URL will fail.

## Data

`dash/streetsafe_results_new.csv`

Header: `sampleLabelId, sample_date, assumed, substances, url, city, state`
