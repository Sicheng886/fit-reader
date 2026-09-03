# fit-reader

A local training analytics tool that parses `.fit` files exported from bike computers and sports watches. It outputs a per-second time-series CSV and a summary metrics JSON, and provides a web dashboard plus AI training reports.

> 中文文档：[README.md](./README.md)

## Features

- **FIT parsing**: resamples `.fit` files to a strict 1-second grid time-series CSV (power, heart rate, cadence, altitude, speed, temperature) and generates a summary JSON (NP, IF, TSS, power/HR zones, peak power curve, HR drift, interval/climb segments, data quality, etc.)
- **Metric computation**: Normalized Power (NP), Intensity Factor (IF), Training Stress Score (TSS), CTL/ATL/TSB load trends, automatic FTP estimate (20-min peak power × 0.95), scientific FTP estimation (critical power model + Coggan dual-method cross-check + HR cross-validation)
- **Multi-sport**: cycling (fullest metrics), running (pace/cadence), swimming (length messages: lengths/pool length/strokes/SWOLF)
- **Web dashboard**: local browser view of load trends, monthly summary, per-workout time-series charts, zone distributions, and upload/analyze
- **AI training analysis**: one-click review, period planning, taper, and workout comparison reports; the AI queries the training library on demand via agentic tool calls (function calling) — activity lists, single-workout summaries, per-second time series, load trends, monthly summaries, FTP estimates — and can compute on the fly: future CTL/ATL/TSB load simulation (with risk flags) and single-workout generation by target/duration, beyond the preloaded prompt data
- **AI chat**: report follow-ups (quick Q&A, ≤200 chars, grounded in this workout's data) and free-form Q&A on the Chat page — both persisted, generated asynchronously (close the page and check later), with full deletion support
- **AI memory**: the AI proactively saves personal facts it learns (injuries, schedule constraints, goal changes, etc.) with timestamps (new facts can supersede old ones); all future AI calls inject them automatically; view and delete on the Memory page
- **Skills knowledge base**: Markdown training-science documents under `skills/` (Coggan power system, TrainingPeaks load model, HR zones, report-writing standards) are injected in full into AI report and chat prompts, keeping report quality consistent across any model; drop a `.md` file into the directory to extend it (see `skills/_README.md`)
- **Bilingual UI (Chinese / English)**: interface, charts and AI reports support English — the language is auto-detected from your browser on first launch (anything non-Chinese falls back to English) and can be switched anytime on the Settings page; CLI prompt commands accept `--lang en`
- Workout notes (feel/conditions) and identity/training goals are taken into account by AI analyses
- **Training database**: local SQLite library that archives every analysis and tracks long-term load trends

## Quick Start

```bash
npm install

# Analyze a single file
node index.js your-ride.fit

# Batch-analyze all .fit files in a directory
node index.js ./input ./output

# Start the web UI (default http://localhost:3000)
npm run web

# Run the regression tests
npm test
```

## Docker Deployment (Quick Start)

Images are published to GitHub Packages — pull and run:

```bash
docker pull ghcr.io/sicheng886/fit-reader:latest
docker run -d \
  --name fit-reader \
  -p 3000:3000 \
  -v "$(pwd)/input:/input" \
  -v "$(pwd)/output:/output" \
  -v "$(pwd)/db:/app/db" \
  ghcr.io/sicheng886/fit-reader:latest
```

Then open http://localhost:3000.

Full build instructions (local builds, version tags, persistent volumes, permissions) are in **[DEPLOY.md](./DEPLOY.md)** (Chinese).

## Tech Stack

- Node.js (ESM, zero build, zero transpilation)
- `fit-file-parser`: parses `.fit` files
- `marked`: renders AI report Markdown to HTML
- `dayjs`: current date/weekday/timezone formatting for AI prompts
- Node built-in `node:sqlite`: local training library

## Development Conventions

See `AGENTS.md` (Chinese): algorithm thresholds live in `src/settings.js`, athlete parameters go through the training-library settings table; after changing metric algorithms, run `npm test` and update the docs accordingly.
