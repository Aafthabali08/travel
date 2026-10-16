import { useEffect, useState, type ReactNode } from "react";
import { FlaskConical, RefreshCw, Target } from "lucide-react";
import { api } from "./api";
import { Empty } from "./Shell";

// Shapes returned by GET /api/admin/model-accuracy (backend/app/model_eval.py).
type Metrics = {
  n: number;
  mae: number | null;
  rmse: number | null;
  mape: number | null;
  medape: number | null;
  r2: number | null;
  bias: number | null;
  within10: number | null;
  coverage: number | null;
  coverage_n?: number;
  mape_sd?: number;
};
type Predictor = "routewise" | "card" | "average" | "gemini";
type Table = Record<Predictor, Metrics>;
type Scored = {
  kind: string;
  km: number | null;
  created_at: number;
  verdict: "correct" | "wrong";
  actual: number;
  routewise: number;
  card: number;
  average: number;
  gemini: number | null;
  range: [number, number] | null;
};
type Accuracy = {
  real: {
    reports: number;
    paid_reports: number;
    skipped: { no_amount: number; absurd: number };
    all: Table;
    paid_only: Table;
    by_kind: Record<string, { routewise: Metrics; card: Metrics }>;
    curve: { index: number; routewise: number; card: number }[];
    recent: Scored[];
  } | null;
  note: string;
  benchmark: {
    holdout: number;
    seeds: number;
    rows: ({ riders: number } & Record<
      "card" | "average" | "routewise",
      Metrics
    >)[];
    stress: Record<"card" | "average" | "routewise", number>;
  };
};

const NAMES: Record<Predictor, string> = {
  routewise: "RouteWise model",
  card: "Fare card",
  average: "Average of reports",
  gemini: "Gemini",
};
const KIND_NAMES: Record<string, string> = {
  auto: "Private auto",
  cab: "Cab",
  share_auto: "Share auto",
  bus: "City bus",
};
const rupees = (v: number | null | undefined) =>
  v == null ? "—" : `₹${v.toFixed(1)}`;
const signedRupees = (v: number | null | undefined) =>
  v == null
    ? "—"
    : `${v > 0 ? "+" : v < 0 ? "−" : ""}₹${Math.abs(v).toFixed(1)}`;
const pct = (v: number | null | undefined) =>
  v == null ? "—" : `${v.toFixed(1)}%`;
const r2 = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));

// Each metric: how to show it, which direction is better, and what it means.
const ROWS: {
  key: keyof Metrics;
  label: string;
  show: (v: number | null | undefined) => string;
  better: "low" | "high" | "zero" | "target";
  meaning: string;
}[] = [
  {
    key: "mae",
    label: "MAE",
    show: rupees,
    better: "low",
    meaning:
      "Mean absolute error: on average, how many rupees off the prediction was.",
  },
  {
    key: "rmse",
    label: "RMSE",
    show: rupees,
    better: "low",
    meaning:
      "Root mean squared error: like MAE, but big misses count much more. Much higher than MAE means a few large misses.",
  },
  {
    key: "mape",
    label: "MAPE",
    show: pct,
    better: "low",
    meaning:
      "Mean absolute percentage error: average % off. Fair across ₹20 share autos and ₹400 cabs.",
  },
  {
    key: "medape",
    label: "Median % error",
    show: pct,
    better: "low",
    meaning: "The typical trip's % error; one wild report can't move it.",
  },
  {
    key: "r2",
    label: "R²",
    show: r2,
    better: "high",
    meaning:
      "How much of the variation in what riders paid the prediction explains. 1 = perfect, 0 = no better than always guessing the average fare, below 0 = worse than that.",
  },
  {
    key: "bias",
    label: "Bias",
    show: signedRupees,
    better: "zero",
    meaning:
      "Average signed error. Negative = predicts too low (riders pay more), positive = too high. Closest to ₹0 is best.",
  },
  {
    key: "within10",
    label: "Within ±10%",
    show: pct,
    better: "high",
    meaning:
      "Share of trips predicted within 10% of what the rider paid — close enough not to feel misled.",
  },
  {
    key: "coverage",
    label: "Range coverage",
    show: pct,
    better: "target",
    meaning:
      "How often the fare the rider paid fell inside “Riders usually pay ₹a–₹b”. The range is about ±1 standard deviation, so ≈68% is well calibrated: much lower = range too narrow (overconfident), much higher = too wide.",
  },
];

function best(row: (typeof ROWS)[number], table: Table, names: Predictor[]) {
  const vals = names
    .map((n) => [n, table[n]?.[row.key]] as const)
    .filter(
      (x): x is readonly [Predictor, number] =>
        typeof x[1] === "number" && (table[x[0]]?.n ?? 0) > 0,
    );
  if (vals.length < 2 || row.better === "target") return null;
  const score = (v: number) =>
    row.better === "low" ? v : row.better === "high" ? -v : Math.abs(v);
  return vals.reduce((a, b) => (score(b[1]) < score(a[1]) ? b : a))[0];
}

function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="tile">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function CompareTable({ table, names }: { table: Table; names: Predictor[] }) {
  return (
    <div className="table-wrap">
      <table className="data-table metrics-table">
        <thead>
          <tr>
            <th>Metric</th>
            {names.map((n) => (
              <th key={n} className="num">
                {NAMES[n]}
                <small>{table[n]?.n ?? 0} reports</small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => {
            const winner = best(row, table, names);
            return (
              <tr key={row.key}>
                <td>
                  <strong>{row.label}</strong>
                </td>
                {names.map((n) => {
                  const m = table[n];
                  const v = m && m.n > 0 ? (m[row.key] as number | null) : null;
                  const notApplicable =
                    row.key === "coverage" && n !== "routewise";
                  return (
                    <td key={n} className={`num ${winner === n ? "best" : ""}`}>
                      {notApplicable ? (
                        <span className="muted-cell">n/a</span>
                      ) : (
                        row.show(v)
                      )}
                      {row.key === "coverage" &&
                      n === "routewise" &&
                      m?.coverage_n ? (
                        <small>{m.coverage_n} with a range</small>
                      ) : null}
                      {winner === n && <small className="best-tag">best</small>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Rolling % error by report number: two series, so a legend plus distinct line styles.
function LearningCurve({
  points,
}: {
  points: { index: number; routewise: number; card: number }[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2)
    return (
      <Empty
        icon={<Target size={24} />}
        title="The learning curve appears after 2 reports"
      >
        Each new rider report adds a point.
      </Empty>
    );
  const W = 640,
    H = 220,
    L = 40,
    R = 12,
    T = 12,
    B = 28;
  const max = Math.max(10, ...points.flatMap((p) => [p.routewise, p.card]));
  const top = Math.ceil(max / 10) * 10;
  const x = (i: number) => L + (i / (points.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const line = (k: "routewise" | "card") =>
    points
      .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`)
      .join(" ");
  const h = hover != null ? points[hover] : null;
  return (
    <figure className="curve">
      <div className="curve-legend">
        <span>
          <i className="swatch model" /> RouteWise model
        </span>
        <span>
          <i className="swatch base" /> Fare card
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Rolling percentage error by report number, RouteWise model versus fare card"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          const i = Math.round(((px - L) / (W - L - R)) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              className="grid"
              x1={L}
              x2={W - R}
              y1={y(top * f)}
              y2={y(top * f)}
            />
            <text
              className="axis"
              x={L - 6}
              y={y(top * f) + 4}
              textAnchor="end"
            >
              {Math.round(top * f)}%
            </text>
          </g>
        ))}
        <text className="axis" x={L} y={H - 6}>
          report 1
        </text>
        <text className="axis" x={W - R} y={H - 6} textAnchor="end">
          report {points[points.length - 1]!.index}
        </text>
        <path className="series base" d={line("card")} />
        <path className="series model" d={line("routewise")} />
        {h && hover != null && (
          <g>
            <line
              className="crosshair"
              x1={x(hover)}
              x2={x(hover)}
              y1={T}
              y2={H - B}
            />
            <circle
              className="dot model"
              cx={x(hover)}
              cy={y(h.routewise)}
              r={4}
            />
            <circle className="dot base" cx={x(hover)} cy={y(h.card)} r={4} />
          </g>
        )}
      </svg>
      <figcaption>
        {h ? (
          <>
            After report {h.index}: RouteWise <b>{pct(h.routewise)}</b> · fare
            card <b>{pct(h.card)}</b> (average over the last{" "}
            {Math.min(10, h.index)} reports)
          </>
        ) : (
          "Average % error over the last 10 reports. Hover to inspect. Lower is better."
        )}
      </figcaption>
      <details className="chart-table">
        <summary>View as table</summary>
        <table>
          <tbody>
            {points.map((p) => (
              <tr key={p.index}>
                <td>Report {p.index}</td>
                <td>RouteWise {pct(p.routewise)}</td>
                <td>Card {pct(p.card)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export default function ModelAccuracy() {
  const [data, setData] = useState<Accuracy | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [paidOnly, setPaidOnly] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setLoading(true);
    api<Accuracy>("/api/admin/model-accuracy")
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [version]);

  if (loading && !data)
    return <p className="muted">Scoring every rider report…</p>;
  if (error)
    return (
      <div className="error-banner" role="alert">
        <div>
          <strong>Model accuracy couldn't load</strong>
          <p>{error}</p>
        </div>
      </div>
    );
  if (!data) return null;
  const real = data.real;
  const table = real ? (paidOnly ? real.paid_only : real.all) : null;
  const names: Predictor[] = ["routewise", "card", "average", "gemini"];
  const rw = table?.routewise;

  return (
    <div className="accuracy">
      <section className="card accuracy-intro">
        <div>
          <h2>How accurate are RouteWise fares?</h2>
          <p>
            <b>Supervised regression</b> on rider reports: the model predicts a
            price in rupees and learns from what riders say they paid. Every
            report below is scored against what each predictor said{" "}
            <b>before</b> that report existed (a time-based backtest), so
            nothing is graded on data it learned from.
          </p>
        </div>
        <button
          className="secondary"
          onClick={() => setVersion((v) => v + 1)}
          disabled={loading}
        >
          <RefreshCw size={15} /> {loading ? "Refreshing…" : "Refresh"}
        </button>
      </section>

      {!real ? (
        <section className="card">
          <Empty icon={<Target size={26} />} title="No rider reports to score">
            {data.note}
          </Empty>
        </section>
      ) : (
        <>
          <div className="filter-row">
            <button
              className={!paidOnly ? "chip selected" : "chip"}
              onClick={() => setPaidOnly(false)}
            >
              All reports ({real.reports})
            </button>
            <button
              className={paidOnly ? "chip selected" : "chip"}
              onClick={() => setPaidOnly(true)}
            >
              Only reports with a price paid ({real.paid_reports})
            </button>
          </div>
          <p className="muted small-print accuracy-note">
            {paidOnly
              ? "Strict view: only riders who typed what they paid. This is the fairest test of the model."
              : "Includes “Correct” confirmations, which count the shown fare as right — so RouteWise looks better here than in the strict view."}{" "}
            {real.skipped.no_amount + real.skipped.absurd > 0 &&
              `Not scored: ${real.skipped.no_amount} disputes without an amount, ${real.skipped.absurd} absurd amounts.`}
          </p>

          {table && rw && rw.n > 0 ? (
            <>
              <div className="tiles">
                <Tile
                  label="Reports scored"
                  value={rw.n}
                  note={paidOnly ? "with a price paid" : "all rider reports"}
                />
                <Tile
                  label="RouteWise MAPE"
                  value={pct(rw.mape)}
                  note={`fare card ${pct(table.card.mape)}`}
                />
                <Tile
                  label="RouteWise MAE"
                  value={rupees(rw.mae)}
                  note={`fare card ${rupees(table.card.mae)}`}
                />
                <Tile
                  label="Within ±10%"
                  value={pct(rw.within10)}
                  note="of rider-paid fares"
                />
                <Tile
                  label="R²"
                  value={r2(rw.r2)}
                  note={
                    rw.r2 == null ? "needs 2+ different fares" : "1.0 = perfect"
                  }
                />
                <Tile
                  label="Range coverage"
                  value={pct(rw.coverage)}
                  note={
                    rw.coverage_n
                      ? `target ≈68% · ${rw.coverage_n} reports had a range`
                      : "no ranges shown yet"
                  }
                />
              </div>
              {rw.n < 30 && (
                <p className="form-note">
                  Only {rw.n} report{rw.n === 1 ? "" : "s"} so far — treat these
                  numbers as early signals. They become reliable from roughly 30
                  reports per fare type.
                </p>
              )}
              <section className="card admin-section">
                <div className="panel-title">
                  <h2>All metrics, every predictor</h2>
                  <span>REAL RIDER REPORTS</span>
                </div>
                <CompareTable table={table} names={names} />
              </section>
            </>
          ) : (
            <section className="card">
              <Empty
                icon={<Target size={24} />}
                title="Nothing to score in this view yet"
              >
                Reports appear here once riders rate a fare
                {paidOnly ? " and type what they paid" : ""}.
              </Empty>
            </section>
          )}

          <div className="two-col">
            <section className="card admin-section">
              <div className="panel-title">
                <h2>Learning curve</h2>
                <span>ROLLING % ERROR</span>
              </div>
              <LearningCurve points={real.curve} />
            </section>
            <section className="card admin-section">
              <div className="panel-title">
                <h2>By fare type</h2>
                <span>ALL REPORTS</span>
              </div>
              {Object.keys(real.by_kind).length === 0 ? (
                <Empty
                  icon={<Target size={24} />}
                  title="No fare types scored yet"
                />
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Fare type</th>
                        <th className="num">Reports</th>
                        <th className="num">RouteWise MAPE</th>
                        <th className="num">Card MAPE</th>
                        <th className="num">RouteWise MAE</th>
                        <th className="num">Bias</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(real.by_kind).map(([kind, m]) => (
                        <tr key={kind}>
                          <td>
                            <strong>{KIND_NAMES[kind] ?? kind}</strong>
                          </td>
                          <td className="num">{m.routewise.n}</td>
                          <td
                            className={`num ${(m.routewise.mape ?? 0) <= (m.card.mape ?? 0) ? "best" : ""}`}
                          >
                            {pct(m.routewise.mape)}
                          </td>
                          <td className="num">{pct(m.card.mape)}</td>
                          <td className="num">{rupees(m.routewise.mae)}</td>
                          <td className="num">
                            {signedRupees(m.routewise.bias)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <section className="card admin-section">
            <div className="panel-title">
              <h2>Latest scored reports</h2>
              <span>NEWEST FIRST</span>
            </div>
            {real.recent.length === 0 ? (
              <Empty icon={<Target size={24} />} title="No reports yet" />
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Trip</th>
                      <th className="num">Rider paid</th>
                      <th className="num">RouteWise</th>
                      <th className="num">Card</th>
                      <th className="num">Avg of reports</th>
                      <th className="num">Gemini</th>
                      <th className="num">Range</th>
                      <th className="num">RouteWise error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {real.recent.map((r, i) => {
                      const err = (100 * (r.routewise - r.actual)) / r.actual;
                      return (
                        <tr key={i}>
                          <td>
                            {new Date(r.created_at * 1000).toLocaleDateString()}
                          </td>
                          <td>
                            <strong>{KIND_NAMES[r.kind] ?? r.kind}</strong>
                            <small>
                              {r.km != null ? `${r.km} km · ` : ""}
                              {r.verdict === "correct"
                                ? "confirmed shown fare"
                                : "typed amount paid"}
                            </small>
                          </td>
                          <td className="num">
                            <b>₹{Math.round(r.actual)}</b>
                          </td>
                          <td className="num">₹{Math.round(r.routewise)}</td>
                          <td className="num">₹{Math.round(r.card)}</td>
                          <td className="num">₹{Math.round(r.average)}</td>
                          <td className="num">
                            {r.gemini != null
                              ? `₹${Math.round(r.gemini)}`
                              : "—"}
                          </td>
                          <td className="num">
                            {r.range
                              ? `₹${Math.round(r.range[0])}–${Math.round(r.range[1])}`
                              : "—"}
                          </td>
                          <td
                            className={`num ${Math.abs(err) <= 10 ? "good-text" : Math.abs(err) > 25 ? "bad-text" : ""}`}
                          >
                            {err > 0 ? "+" : ""}
                            {err.toFixed(0)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <section className="card admin-section">
        <div className="panel-title">
          <h2>
            <FlaskConical size={17} /> Simulated benchmark
          </h2>
          <span>SYNTHETIC DATA</span>
        </div>
        <p className="muted">
          Riders pay according to a hidden Vizag-like pattern (longer trips
          relatively pricier, +20% near the railway station, −10% in a suburb,
          +12% in the evening, 10% rider-to-rider variation, 5% absurd reports).
          The model learns from N reports and predicts {data.benchmark.holdout}{" "}
          trips nobody reported; averaged over {data.benchmark.seeds} random
          samples. This shows the model <i>can</i> learn such patterns — real
          accuracy is the section above.
        </p>
        <div className="table-wrap">
          <table className="data-table metrics-table">
            <thead>
              <tr>
                <th>Riders</th>
                <th className="num">MAE</th>
                <th className="num">RMSE</th>
                <th className="num">MAPE</th>
                <th className="num">Median %</th>
                <th className="num">R²</th>
                <th className="num">Bias</th>
                <th className="num">Within ±10%</th>
                <th className="num">Coverage</th>
                <th className="num">Card MAPE</th>
                <th className="num">Avg MAPE</th>
              </tr>
            </thead>
            <tbody>
              {data.benchmark.rows.map((row) => (
                <tr key={row.riders}>
                  <td>
                    <strong>{row.riders}</strong>
                  </td>
                  <td className="num">{rupees(row.routewise.mae)}</td>
                  <td className="num">{rupees(row.routewise.rmse)}</td>
                  <td className="num">
                    {pct(row.routewise.mape)}
                    {row.routewise.mape_sd != null && (
                      <small>±{row.routewise.mape_sd.toFixed(1)}</small>
                    )}
                  </td>
                  <td className="num">{pct(row.routewise.medape)}</td>
                  <td className="num">{r2(row.routewise.r2)}</td>
                  <td className="num">{signedRupees(row.routewise.bias)}</td>
                  <td className="num">{pct(row.routewise.within10)}</td>
                  <td className="num">{pct(row.routewise.coverage)}</td>
                  <td className="num">{pct(row.card.mape)}</td>
                  <td className="num">{pct(row.average.mape)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.benchmark.stress &&
          Object.keys(data.benchmark.stress).length > 0 && (
            <p className="muted small-print">
              Stress test (150 riders, 25% noise, 20% absurd reports) — MAPE:
              RouteWise <b>{pct(data.benchmark.stress.routewise)}</b>, average
              of reports {pct(data.benchmark.stress.average)}, fare card{" "}
              {pct(data.benchmark.stress.card)}.
            </p>
          )}
      </section>

      <section className="card admin-section">
        <div className="panel-title">
          <h2>What the metrics mean</h2>
          <span>REGRESSION METRICS</span>
        </div>
        <dl className="glossary">
          {ROWS.map((r) => (
            <div key={r.key}>
              <dt>{r.label}</dt>
              <dd>{r.meaning}</dd>
            </div>
          ))}
          <div>
            <dt>Predictors</dt>
            <dd>
              <b>RouteWise model</b> — the fare shown to the rider.{" "}
              <b>Fare card</b> — the published rate, no learning.{" "}
              <b>Average of reports</b> — the card scaled by the average of all
              earlier reports, the simplest learner to beat. <b>Gemini</b> — the
              AI suggestion shown alongside (scored only on reports where it
              gave one).
            </dd>
          </div>
          <div>
            <dt>Why not accuracy, precision or F1?</dt>
            <dd>
              Those are classification metrics, for models that pick a category.
              RouteWise predicts a number, so it is judged with regression
              metrics.
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
